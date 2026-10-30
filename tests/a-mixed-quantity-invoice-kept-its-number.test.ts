// A manual invoice mixing a qty-1 line and a qty>1 line failed to save, and
// each failed save used an invoice number (#606).
//
// The lines went in as one bulk insert whose rows had different keys. PostgREST
// sends a bulk insert with the union of the columns and NULL where a row had
// none, so "Full groom x1" beside "Add-on x2" wrote quantity NULL into a NOT
// NULL column. The invoice had already been inserted on its own, and its
// number taken from the org's counter, so deleting it afterwards left a gap.
//
// This file covers what the TypeScript sends. The database half (the counter
// does not move on a failed save) is in
// tests/integration/a-failed-invoice-kept-its-number.db.test.ts.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshState, manualInvoiceFakeDb } from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Full groom x1 + Add-on x2", () => {
  it("sends every line with the same keys, quantity and unit price included", async () => {
    const state = freshState();
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const r = await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: "0a000000-0000-4000-8000-0000000000aa",
      userId: "a0000000-0000-4000-8000-00000000a001",
      clientId: "c0000000-0000-4000-8000-0000000000a1",
      items: [
        { description: "Full groom", amountCents: 8500 },
        { description: "Add-on", amountCents: 3000, quantity: 2, unitAmountCents: 1500 },
      ],
    });
    expect(r.totalCents).toBe(11500);
    expect(state.inserted.invoices[0]).toMatchObject({ subtotal_cents: 11500, total_cents: 11500 });

    const [groom, addon] = state.inserted.lines;
    expect(Object.keys(groom).sort()).toEqual(Object.keys(addon).sort());
    expect(groom).toMatchObject({ quantity: 1, unit_amount_cents: null, amount_cents: 8500 });
    expect(addon).toMatchObject({ quantity: 2, unit_amount_cents: 1500, amount_cents: 3000 });
  });
});

describe("a failed save uses no number", () => {
  const ts = read("src/lib/manual-invoice.server.ts");
  const sql = read("supabase/migrations/20261030090000_a-failed-invoice-kept-its-number.sql");

  it("writes the invoice and its lines in one call, not one request each", () => {
    expect(ts).toMatch(/supabase\.rpc\("create_manual_invoice"/);
    expect(ts).not.toMatch(/\.from\("invoices"\)\s*\.insert/);
    expect(ts).not.toMatch(/\.from\("invoice_line_items"\)/);
    // Nothing to clean up: a failure leaves no invoice behind to delete.
    expect(ts).not.toMatch(/\.from\("invoices"\)\.delete\(\)/);
  });

  it("the function runs as the caller and does the add-on claim and visit check inside", () => {
    expect(sql).toMatch(/SECURITY INVOKER/);
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql).toMatch(
      /UPDATE public\.addon_charges[\s\S]*?status = 'pending'[\s\S]*?IF NOT FOUND THEN\s+RAISE EXCEPTION/,
    );
    expect(sql).toMatch(/A visit on this invoice was just billed on invoice/);
    expect(sql).toMatch(/COALESCE\(v_li\.quantity, 1\)/);
  });
});
