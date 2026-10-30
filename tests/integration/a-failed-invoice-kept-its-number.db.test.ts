/** A failed manual invoice kept its number (#606).
 *
 *  Drives insertManualInvoice against real Postgres: a mixed qty-1 / qty-2
 *  invoice saves with the right total, and a save that fails on a line leaves
 *  the org's counter where it was, so the next invoice takes the next number.
 *
 *  Local stack only. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { insertManualInvoice } from "@/lib/manual-invoice.server";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

let admin: SupabaseClient;
let orgId: string;
let clientId: string;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function nextNumber(): Promise<number> {
  const { data, error } = await admin
    .from("organizations")
    .select("next_invoice_number")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { next_invoice_number: number }).next_invoice_number;
}

describe.skipIf(!enabled)("a mixed-quantity manual invoice", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Mixed quantity ${runId}`,
      service_lines: ["grooming"],
      timezone: "UTC",
    });
    clientId = await ins("clients", {
      organization_id: orgId,
      display_name: `Mixed quantity ${runId}`,
      account_type: "residential",
      active: true,
    });
  });

  it("Full groom x1 + Add-on x2 saves with the right total", async () => {
    const before = await nextNumber();
    const { invoiceId, totalCents } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: [
        { description: "Full groom", amountCents: 8500 },
        { description: "Add-on", amountCents: 3000, quantity: 2, unitAmountCents: 1500 },
      ],
    });
    expect(totalCents).toBe(11500);
    const { data: inv } = await admin
      .from("invoices")
      .select(
        "number, total_cents, invoice_line_items(description, quantity, unit_amount_cents, amount_cents)",
      )
      .eq("id", invoiceId)
      .single();
    expect(inv!.number).toBe(before);
    expect(inv!.total_cents).toBe(11500);
    const lines = (
      inv!.invoice_line_items as Array<{
        description: string;
        quantity: number | string;
        unit_amount_cents: number | null;
        amount_cents: number;
      }>
    ).sort((a, b) => a.amount_cents - b.amount_cents);
    expect(
      lines.map((l) => [l.description, Number(l.quantity), l.unit_amount_cents, l.amount_cents]),
    ).toEqual([
      ["Add-on", 2, 1500, 3000],
      ["Full groom", 1, null, 8500],
    ]);
    expect(await nextNumber()).toBe(before + 1);
  });

  it("a save that fails on a line uses no number and leaves no invoice", async () => {
    const before = await nextNumber();
    const { count: invoicesBefore } = await admin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);
    // A unit price that does not multiply out: the second line breaks
    // invoice_line_items_total_is_quantity_times_unit after the invoice row
    // and the first line are already written.
    await expect(
      insertManualInvoice(admin, {
        orgId,
        userId: null,
        clientId,
        items: [
          { description: "Full groom", amountCents: 8500 },
          { description: "Add-on", amountCents: 9999, quantity: 2, unitAmountCents: 1500 },
        ],
      }),
    ).rejects.toThrow(/invoice_line_items_total_is_quantity_times_unit/);
    expect(await nextNumber()).toBe(before);
    const { count: invoicesAfter } = await admin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("client_id", clientId);
    expect(invoicesAfter).toBe(invoicesBefore);

    const { invoiceId } = await insertManualInvoice(admin, {
      orgId,
      userId: null,
      clientId,
      items: [{ description: "Full groom", amountCents: 8500 }],
    });
    const { data } = await admin.from("invoices").select("number").eq("id", invoiceId).single();
    expect(data!.number).toBe(before);
  });
});
