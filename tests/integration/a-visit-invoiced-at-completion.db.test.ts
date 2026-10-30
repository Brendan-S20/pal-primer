/** A visit invoiced by hand is not billed again (#605, decision D2: invoice
 *  at completion).
 *
 *  The postpaid billing run (admin_generate_invoice_for_client, which
 *  Generate from visits and the nightly run_billing_cycles both call) bills
 *  every completed postpaid visit that no invoice line points at, and every
 *  pending add-on charge. A hand-made invoice never set visit_id, so the run
 *  billed the same visit a second time.
 *
 *  These drive the app's own code (insertManualInvoice, visitInvoicing,
 *  uninvoicedWork) against real Postgres, then run the billing functions and
 *  count what they wrote. The first case is the fault itself, kept as a
 *  control: an invoice with no link IS billed again, so a green run below
 *  means the link did the work, not that the run billed nothing for some
 *  other reason.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { orgDay } from "../support/org-day";
import { insertManualInvoice } from "@/lib/manual-invoice.server";
import { uninvoicedWork, visitInvoicing } from "@/lib/visit-invoicing.server";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

const ORG_TZ = "UTC";
const today = orgDay(ORG_TZ);
const visitDay = orgDay(ORG_TZ, -3);

let admin: SupabaseClient;
let orgId: string;
let serviceId: string;
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

/** A postpaid client billed after each visit, with one completed visit. */
async function completedVisit() {
  const n = ++serial;
  const clientId = await ins("clients", {
    organization_id: orgId,
    display_name: `Invoiced at completion ${n} ${runId}`,
    account_type: "residential",
    active: true,
    billing_frequency: "after_each_visit",
  });
  const propertyId = await ins("properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Finished Ln`,
    city: "Austin",
    postal_code: "78701",
  });
  const subscriptionId = await ins("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "weekly",
    price_cents: 3000,
    billing_cadence: "postpaid",
    service_id: serviceId,
    status: "active",
    started_on: visitDay,
  });
  const visitId = await ins("visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: serviceId,
    scheduled_on: visitDay,
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  return { clientId, visitId };
}

/** How many lines on any invoice bill this visit. */
async function linesFor(visitId: string): Promise<number> {
  const { count, error } = await admin
    .from("invoice_line_items")
    .select("id", { count: "exact", head: true })
    .eq("visit_id", visitId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function invoicesFor(clientId: string): Promise<number> {
  const { count, error } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Generate from visits, as the office's button reaches it. */
async function generate(clientId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("admin_generate_invoice_for_client", {
    _client_id: clientId,
    _through: today,
  });
  if (error) throw new Error(`admin_generate_invoice_for_client: ${error.message}`);
  return (data as string | null) ?? null;
}

/** The nightly run, for this org only. */
async function billingRun(): Promise<void> {
  const { error } = await admin.rpc("run_billing_cycles", { _org_id: orgId });
  if (error) throw new Error(`run_billing_cycles: ${error.message}`);
}

describe.skipIf(!enabled)("a visit invoiced by hand is not billed again", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Invoice at completion ${runId}`,
      service_lines: ["dog_walking"],
      timezone: ORG_TZ,
      auto_invoice_enabled: true,
    });
    serviceId = await ins("services", {
      organization_id: orgId,
      service_line: "dog_walking",
      name: `Walk ${runId}`,
      price_unit: "visit",
      base_price_cents: 3000,
      extra_pet_cents: 0,
      default_duration_min: 30,
      active: true,
    });
  });

  it("control: a manual invoice that names no visit is billed again by the run", async () => {
    const { clientId, visitId } = await completedVisit();
    await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: [{ description: "Walk", amountCents: 3000 }],
    });
    expect(await generate(clientId)).not.toBeNull();
    expect(await linesFor(visitId)).toBe(1);
    expect(await invoicesFor(clientId)).toBe(2);
  });

  it("Invoice this visit: Generate from visits and the nightly run then create nothing", async () => {
    const { clientId, visitId } = await completedVisit();

    const before = await visitInvoicing(admin, orgId, visitId);
    expect(before.state).toBe("ready");
    if (before.state !== "ready") return;
    expect(before.totalCents).toBe(3000);
    expect(before.lines[0].visitId).toBe(visitId);

    // What the invoiceVisit server function does with that answer.
    const { invoiceId } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: before.lines,
      period: { start: visitDay, end: visitDay },
    });

    const after = await visitInvoicing(admin, orgId, visitId);
    expect(after).toMatchObject({ state: "invoiced", invoiceId });
    expect((await uninvoicedWork(admin, orgId, clientId)).visits).toEqual([]);

    expect(await generate(clientId)).toBeNull();
    await billingRun();
    expect(await linesFor(visitId)).toBe(1);
    expect(await invoicesFor(clientId)).toBe(1);
  });

  it("New invoice with the visit ticked: the visit and its add-on are billed once", async () => {
    const { clientId, visitId } = await completedVisit();
    const addonId = await ins("addon_charges", {
      organization_id: orgId,
      client_id: clientId,
      visit_id: visitId,
      description: `Treat bag ${runId}`,
      occurred_on: visitDay,
      quantity: 1,
      unit_price_cents: 500,
      amount_cents: 500,
      status: "pending",
    });

    // Uninvoiced work is listed, with the add-on under its visit.
    const work = await uninvoicedWork(admin, orgId, clientId);
    expect(work.visits.map((v) => v.visitId)).toEqual([visitId]);
    expect(work.visits[0].lines.map((l) => l.addonChargeId ?? l.visitId)).toEqual([
      visitId,
      addonId,
    ]);
    expect(work.addons).toEqual([]);

    // The office ticks it and changes the visit's price before sending.
    const items = work.visits[0].lines.map((l) =>
      l.visitId ? { ...l, description: "Walk, extra long", amountCents: 3500 } : l,
    );
    const { invoiceId, totalCents } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items,
    });
    expect(totalCents).toBe(4000);

    const { data: addon } = await admin
      .from("addon_charges")
      .select("status, invoice_line_items(invoice_id)")
      .eq("id", addonId)
      .single();
    expect(addon?.status).toBe("invoiced");
    expect((addon as any)?.invoice_line_items?.invoice_id).toBe(invoiceId);

    expect(await generate(clientId)).toBeNull();
    await billingRun();
    expect(await linesFor(visitId)).toBe(1);
    expect(await invoicesFor(clientId)).toBe(1);
  });

  it("refuses to put a visit that is already on a live invoice on a second one", async () => {
    const { clientId, visitId } = await completedVisit();
    expect(await generate(clientId)).not.toBeNull();
    await expect(
      insertManualInvoice(admin, {
        orgId,
        userId: null,
        clientId,
        items: [{ description: "Walk again", amountCents: 3000, visitId }],
      }),
    ).rejects.toThrow(/already on invoice/);
    expect(await linesFor(visitId)).toBe(1);
    expect(await invoicesFor(clientId)).toBe(1);
  });

  it("refuses another client's visit, and leaves no invoice behind", async () => {
    const a = await completedVisit();
    const b = await completedVisit();
    await expect(
      insertManualInvoice(admin, {
        orgId,
        userId: null,
        clientId: a.clientId,
        items: [{ description: "Walk", amountCents: 3000, visitId: b.visitId }],
      }),
    ).rejects.toThrow(/not this client's/);
    expect(await invoicesFor(a.clientId)).toBe(0);
  });
});
