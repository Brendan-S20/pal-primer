// A mixed qty-1 / qty>1 manual invoice failed to save, and every failed save
// burned an invoice number (#606).
//
// The lines went in as one bulk insert. A bulk insert writes every column any
// row names, so a row with no quantity beside a row with one was written with
// quantity NULL, and the NOT NULL on that column refused the whole insert. The
// invoice was already in, with its number taken from the org's counter, so the
// cleanup delete left a gap.
//
// This is the TypeScript half: what insertManualInvoice sends. The SQL half,
// that create_manual_invoice saves all of it or none of it and a failure takes
// no number, is supabase/proofs/20261030090000-a-failed-invoice-kept-its-number.sql
// and tests/integration/a-failed-invoice-kept-its-number.db.test.ts, both run
// by the database job in sandboxes.yml on a database built from migrations.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { freshState, manualInvoiceFakeDb } from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const ORG = "0a000000-0000-4000-8000-0000000000aa";
const USER = "a0000000-0000-4000-8000-00000000a001";
const CLIENT = "c0000000-0000-4000-8000-0000000000a1";

describe("Full groom x1 + Add-on x2", () => {
  it("sends quantity and unit price on every line, and the right total", async () => {
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const state = freshState();
    const out = await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
      orgId: ORG,
      userId: USER,
      clientId: CLIENT,
      items: [
        { description: "Full groom", amountCents: 6_500 },
        { description: "Add-on", amountCents: 2_000, quantity: 2, unitAmountCents: 1_000 },
      ],
    });
    expect(out.totalCents).toBe(8_500);
    expect(state.inserted.invoices[0]).toMatchObject({ subtotal_cents: 8_500, total_cents: 8_500 });
    expect(state.inserted.lines).toEqual([
      {
        description: "Full groom",
        amount_cents: 6_500,
        quantity: 1,
        unit_amount_cents: null,
        visit_id: null,
        addon_charge_id: null,
      },
      {
        description: "Add-on",
        amount_cents: 2_000,
        quantity: 2,
        unit_amount_cents: 1_000,
        visit_id: null,
        addon_charge_id: null,
      },
    ]);
    // Every row names the same columns, so no row's column is left to NULL.
    const keys = state.inserted.lines.map((l) => Object.keys(l).sort().join());
    expect(new Set(keys).size).toBe(1);
  });
});

describe("a failed save", () => {
  it("throws the database's message and writes nothing else", async () => {
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    const state = freshState();
    const db = manualInvoiceFakeDb(state);
    db.rpc = (async () => ({
      data: null,
      error: { message: "An add-on on this invoice has already been billed." },
    })) as never;
    await expect(
      insertManualInvoice(db as never, {
        orgId: ORG,
        userId: USER,
        clientId: CLIENT,
        items: [{ description: "Full groom", amountCents: 6_500 }],
      }),
    ).rejects.toThrow("An add-on on this invoice has already been billed.");
    // The fake has no invoices.insert, invoice_line_items or delete: a
    // write outside the one transaction would have thrown above instead.
  });

  it("goes through one transaction, not an insert and a cleanup delete", () => {
    const core = read("src/lib/manual-invoice.server.ts");
    expect(core).toMatch(/\.rpc\("create_manual_invoice"/);
    expect(core).not.toMatch(/from\("invoices"\)/);
    expect(core).not.toMatch(/from\("invoice_line_items"\)/);
    expect(core).not.toMatch(/from\("addon_charges"\)/);
  });

  it("runs as the caller, so their row level security still decides what they may write", () => {
    const sql = read("supabase/migrations/20261030090000_a-failed-invoice-kept-its-number.sql");
    expect(sql).toMatch(
      /FUNCTION public\.create_manual_invoice\(_invoice jsonb, _lines jsonb\)[\s\S]*?SECURITY INVOKER/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.create_manual_invoice\(jsonb, jsonb\) TO authenticated, service_role/,
    );
  });
});
