/** Completing a visit billed after each visit invoices it, once (#859; #605
 *  decision D2: invoice at completion).
 *
 *  Before #859 nothing ran at completion: finalize_visit_completion froze the
 *  price and debited a prepaid balance, and the first invoice a postpaid
 *  after-each-visit client saw came from the nightly run or the "Invoice this
 *  visit" button. These drive invoiceVisitAtCompletion, which both completion
 *  server functions call, against real Postgres, and count what it wrote:
 *
 *    - one open invoice for the visit's price, linked by visit_id, stamped to
 *      be emailed after the grace days as the run's invoices are;
 *    - nothing more on a retry, a second complete, two at once, or the
 *      button pressed afterwards or alongside;
 *    - nothing at all for a prepaid plan or a monthly client, or once the
 *      visit's invoice was voided (one line per visit, ever);
 *    - and the run bills nothing further.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { addDays, orgDay } from "../support/org-day";
import { insertManualInvoice } from "@/lib/manual-invoice.server";
import { visitInvoicing } from "@/lib/visit-invoicing.server";
import {
  invoiceVisitAtCompletion,
  nextVisitInvoiceKey,
} from "@/lib/visit-completion-invoice.server";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

const ORG_TZ = "UTC";
const today = orgDay(ORG_TZ);
const GRACE = 2;

let admin: SupabaseClient;
let orgId: string;
let serviceId: string;
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

/** A client with one completed visit today, as the tester's: $20 a visit. */
async function completedVisit(opts: { cadence?: "postpaid" | "prepaid"; frequency?: string } = {}) {
  const n = ++serial;
  const clientId = await ins("clients", {
    organization_id: orgId,
    display_name: `Billed at completion ${n} ${runId}`,
    account_type: "residential",
    active: true,
    billing_frequency: opts.frequency ?? "after_each_visit",
  });
  const propertyId = await ins("properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Completed Ct`,
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
    price_cents: 2000,
    billing_cadence: opts.cadence ?? "postpaid",
    service_id: serviceId,
    status: "active",
    started_on: today,
  });
  const visitId = await ins("visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: serviceId,
    scheduled_on: today,
    status: "completed",
    completed_at: new Date().toISOString(),
  });
  return { clientId, visitId };
}

async function invoices(clientId: string) {
  const { data, error } = await admin
    .from("invoices")
    .select("id, status, total_cents, send_after, invoice_line_items(visit_id)")
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return (data ?? []) as Array<{
    id: string;
    status: string;
    total_cents: number;
    send_after: string | null;
    invoice_line_items: Array<{ visit_id: string | null }>;
  }>;
}

const complete = (visitId: string) =>
  invoiceVisitAtCompletion(admin, { visitId, actorUserId: null });

describe.skipIf(!enabled)("a visit billed after each visit is invoiced when completed", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Billed at completion ${runId}`,
      service_lines: ["pet_waste"],
      timezone: ORG_TZ,
      auto_invoice_enabled: true,
      invoice_grace_days: GRACE,
    });
    serviceId = await ins("services", {
      organization_id: orgId,
      service_line: "pet_waste",
      name: `Weekly scoop ${runId}`,
      price_unit: "visit",
      base_price_cents: 2000,
      extra_pet_cents: 0,
      default_duration_min: 15,
      active: true,
    });
  });

  it("the first completed visit has its open invoice, for its price, with no extra click", async () => {
    const { clientId, visitId } = await completedVisit();
    const r = await complete(visitId);
    expect(r).toMatchObject({ invoiced: true, totalCents: 2000 });

    const list = await invoices(clientId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: "open", total_cents: 2000 });
    expect(list[0].invoice_line_items.map((l) => l.visit_id)).toEqual([visitId]);
    // Emailed by the nightly auto-send after the grace days, as the run's are.
    expect(list[0].send_after).toBe(addDays(today, GRACE));

    // The visit drawer now says which invoice it is on.
    expect(await visitInvoicing(admin, orgId, visitId)).toMatchObject({
      state: "invoiced",
      invoiceId: list[0].id,
    });
  });

  it("completing again, a retry, or the nightly run makes no second invoice", async () => {
    const { clientId, visitId } = await completedVisit();
    await complete(visitId);
    expect(await complete(visitId)).toEqual({ invoiced: false, reason: "already invoiced" });

    // Reopened and completed again (a-completed-visit-can-be-reopened).
    await admin.from("visits").update({ status: "in_progress" }).eq("id", visitId);
    await admin.from("visits").update({ status: "completed" }).eq("id", visitId);
    expect((await complete(visitId)).invoiced).toBe(false);

    const { error } = await admin.rpc("run_billing_cycles", { _org_id: orgId });
    expect(error).toBeNull();
    expect(await invoices(clientId)).toHaveLength(1);
  });

  it("two completions at once make one invoice: the visit's key is unique", async () => {
    const { clientId, visitId } = await completedVisit();
    const [a, b, c] = await Promise.all([complete(visitId), complete(visitId), complete(visitId)]);
    const ids = new Set([a, b, c].flatMap((r) => (r.invoiced ? [r.invoiceId] : [])));
    expect(ids.size).toBe(1);
    const list = await invoices(clientId);
    expect(list).toHaveLength(1);
    expect(list[0].invoice_line_items).toHaveLength(1);
  });

  it("Invoice this visit, pressed beside a completion, makes the same one invoice", async () => {
    const { clientId, visitId } = await completedVisit();
    const state = await visitInvoicing(admin, orgId, visitId);
    if (state.state !== "ready") throw new Error(`expected ready, got ${state.state}`);
    // What the invoiceVisit server function does, raced against a completion.
    const button = insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: state.lines,
      period: { start: today, end: today },
      creationKey: await nextVisitInvoiceKey(admin, visitId),
    }).catch((e: Error) => e);
    const [pressed, completed] = await Promise.all([button, complete(visitId)]);
    const list = await invoices(clientId);
    expect(list).toHaveLength(1);
    if (!(pressed instanceof Error)) expect(pressed.invoiceId).toBe(list[0].id);
    if (completed.invoiced) expect(completed.invoiceId).toBe(list[0].id);

    // And pressed afterwards, it is refused: the visit is on that invoice.
    expect(await visitInvoicing(admin, orgId, visitId)).toMatchObject({ state: "invoiced" });
  });

  it("a visit whose invoice was voided is not billed again by a later completion", async () => {
    // invoice_line_items_visit_unique allows one line per visit, void or
    // not, so the completion must step aside rather than fail or duplicate.
    const { clientId, visitId } = await completedVisit();
    const first = await complete(visitId);
    if (!first.invoiced) throw new Error("expected an invoice");
    const { error } = await admin
      .from("invoices")
      .update({ status: "void" })
      .eq("id", first.invoiceId);
    expect(error).toBeNull();
    expect(await complete(visitId)).toEqual({ invoiced: false, reason: "already invoiced" });
    expect(await invoices(clientId)).toHaveLength(1);
  });

  it("a prepaid visit opens no invoice at completion", async () => {
    const { clientId, visitId } = await completedVisit({ cadence: "prepaid" });
    expect((await complete(visitId)).invoiced).toBe(false);
    expect(await invoices(clientId)).toHaveLength(0);
  });

  it("a monthly client opens no invoice at completion: the run bills the month", async () => {
    const { clientId, visitId } = await completedVisit({ frequency: "monthly" });
    expect((await complete(visitId)).invoiced).toBe(false);
    expect(await invoices(clientId)).toHaveLength(0);
  });
});
