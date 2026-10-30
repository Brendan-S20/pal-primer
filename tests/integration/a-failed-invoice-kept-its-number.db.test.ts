/** A mixed-quantity manual invoice saves, and a failed save takes no invoice
 *  number (#606).
 *
 *  insertManualInvoice wrote the invoice, then its lines, each as its own
 *  request. A line with no quantity beside one with a quantity went in as NULL
 *  and failed NOT NULL, and by then the invoice had its number from the org's
 *  counter, so each failed save left a gap. These drive the app's own
 *  insertManualInvoice against real Postgres and read the counter.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { insertManualInvoice } from "@/lib/manual-invoice.server";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

let admin: SupabaseClient;
let orgId: string;
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function newClient(): Promise<string> {
  return ins("clients", {
    organization_id: orgId,
    display_name: `Invoice number ${++serial} ${runId}`,
    account_type: "residential",
    active: true,
  });
}

/** The number the org's next invoice will get. */
async function counter(): Promise<number> {
  const { data, error } = await admin
    .from("organizations")
    .select("next_invoice_number")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { next_invoice_number: number }).next_invoice_number;
}

async function invoicesFor(clientId: string): Promise<number> {
  const { count, error } = await admin
    .from("invoices")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

async function numberOf(invoiceId: string): Promise<number> {
  const { data, error } = await admin
    .from("invoices")
    .select("number")
    .eq("id", invoiceId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { number: number }).number;
}

describe.skipIf(!enabled)("a manual invoice is saved whole or not at all", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Invoice number ${runId}`,
      timezone: "UTC",
    });
  });

  it("Full groom x1 + Add-on x2 saves, with the right total and the next number", async () => {
    const clientId = await newClient();
    const before = await counter();
    const { invoiceId, totalCents } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: [
        { description: "Full groom", amountCents: 6_500 },
        { description: "Add-on", amountCents: 2_000, quantity: 2, unitAmountCents: 1_000 },
      ],
    });
    expect(totalCents).toBe(8_500);
    expect(await numberOf(invoiceId)).toBe(before);
    expect(await counter()).toBe(before + 1);

    const { data: inv } = await admin
      .from("invoices")
      .select("subtotal_cents, total_cents")
      .eq("id", invoiceId)
      .single();
    expect(inv).toMatchObject({ subtotal_cents: 8_500, total_cents: 8_500 });
    const { data: lines } = await admin
      .from("invoice_line_items")
      .select("description, quantity, unit_amount_cents, amount_cents")
      .eq("invoice_id", invoiceId)
      .order("amount_cents", { ascending: false });
    expect(lines).toEqual([
      { description: "Full groom", quantity: 1, unit_amount_cents: null, amount_cents: 6_500 },
      { description: "Add-on", quantity: 2, unit_amount_cents: 1_000, amount_cents: 2_000 },
    ]);
  });

  it("a save that fails on a line takes no number and leaves no invoice", async () => {
    const clientId = await newClient();
    const before = await counter();
    // 3 x $10 is not $50: the line's own CHECK refuses it, after the invoice
    // row has gone in and taken its number.
    await expect(
      insertManualInvoice(admin, {
        orgId,
        userId: null,
        clientId,
        items: [
          { description: "Full groom", amountCents: 6_500 },
          { description: "Bad line", amountCents: 5_000, quantity: 3, unitAmountCents: 1_000 },
        ],
      }),
    ).rejects.toThrow(/invoice_line_items_total_is_quantity_times_unit/);
    expect(await counter()).toBe(before);
    expect(await invoicesFor(clientId)).toBe(0);

    // The next good save takes that same number: no gap.
    const { invoiceId } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: [{ description: "Full groom", amountCents: 6_500 }],
    });
    expect(await numberOf(invoiceId)).toBe(before);
  });

  it("an add-on billed by the run in the meantime: no number, and the other add-on stays pending", async () => {
    // The race checkInvoiceLinks cannot close: an add-on still pending when
    // the app checks it, billed before the save. Called at the RPC, which is
    // where that race lands.
    const clientId = await newClient();
    const pending = await ins("addon_charges", {
      organization_id: orgId,
      client_id: clientId,
      description: `Nail trim ${runId}`,
      quantity: 1,
      unit_price_cents: 1_500,
      amount_cents: 1_500,
      status: "pending",
    });
    const billed = await ins("addon_charges", {
      organization_id: orgId,
      client_id: clientId,
      description: `Teeth ${runId}`,
      quantity: 1,
      unit_price_cents: 900,
      amount_cents: 900,
      status: "invoiced",
    });
    const before = await counter();
    const { error } = await admin.rpc("create_manual_invoice", {
      _invoice: {
        organization_id: orgId,
        client_id: clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: 2_400,
        tax_rate_bps: 0,
        tax_cents: 0,
        total_cents: 2_400,
      },
      _lines: [
        { description: "Nail trim", amount_cents: 1_500, addon_charge_id: pending },
        { description: "Teeth", amount_cents: 900, addon_charge_id: billed },
      ],
    });
    expect(error?.message).toBe("An add-on on this invoice has already been billed.");
    expect(await counter()).toBe(before);
    expect(await invoicesFor(clientId)).toBe(0);
    const { data: still } = await admin
      .from("addon_charges")
      .select("status, invoice_line_item_id")
      .eq("id", pending)
      .single();
    expect(still).toEqual({ status: "pending", invoice_line_item_id: null });
  });
});
