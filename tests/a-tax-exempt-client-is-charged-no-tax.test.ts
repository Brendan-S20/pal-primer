// A client marked tax-exempt is charged no sales tax, whatever the
// organization's rate, on every path that makes an invoice.
//
// The SQL paths (the billing run, the prepaid invoice, the portal top-up) are
// proved in a real database by the-billing-run-charges-the-organizations-rate;
// this file covers the TypeScript path -- the New invoice dialog and a quote's
// one-time charges, both through insertManualInvoice -- and the switch itself.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effectiveTaxRateBps } from "@/lib/sales-tax";
import { freshState, manualInvoiceFakeDb, type FakeDbState } from "./helpers/manual-invoice-fake-db";

vi.mock("@/lib/activity.server", () => ({ logActivity: vi.fn(async () => {}) }));

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

async function makeInvoice(state: FakeDbState, amounts: number[]) {
  const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
  const r = await insertManualInvoice(manualInvoiceFakeDb(state) as never, {
    orgId: "0a000000-0000-4000-8000-0000000000aa",
    userId: "a0000000-0000-4000-8000-00000000a001",
    clientId: "c0000000-0000-4000-8000-0000000000a1",
    items: amounts.map((a, i) => ({ description: `Line ${i + 1}`, amountCents: a })),
  });
  return { result: r, row: state.inserted.invoices[0] };
}

describe("the rate that applies to a client", () => {
  it("is the organization's unless the client is exempt", () => {
    expect(effectiveTaxRateBps(825, false)).toBe(825);
    expect(effectiveTaxRateBps(825, null)).toBe(825);
    expect(effectiveTaxRateBps(825, true)).toBe(0);
    expect(effectiveTaxRateBps(0, false)).toBe(0);
    expect(effectiveTaxRateBps(null, false)).toBe(0);
  });
});

describe("a hand-made invoice", () => {
  let state: FakeDbState;
  beforeEach(() => {
    state = freshState({
      org: { invoice_net_days: 15, timezone: "America/Chicago", sales_tax_rate_bps: 825, sales_tax_label: "Sales tax" },
    });
  });

  it("taxes a client who is not exempt", async () => {
    const { result, row } = await makeInvoice(state, [6_000, 4_000]);
    expect(row).toMatchObject({
      subtotal_cents: 10_000,
      tax_rate_bps: 825,
      tax_cents: 825,
      tax_label: "Sales tax",
      total_cents: 10_825,
    });
    expect(result).toMatchObject({ totalCents: 10_825, taxCents: 825 });
  });

  it("charges an exempt client nothing, at rate 0, with no label", async () => {
    state.client = { tax_exempt: true };
    const { result, row } = await makeInvoice(state, [6_000, 4_000]);
    expect(row).toMatchObject({
      subtotal_cents: 10_000,
      tax_rate_bps: 0,
      tax_cents: 0,
      tax_label: null,
      total_cents: 10_000,
    });
    expect(result).toMatchObject({ totalCents: 10_000, taxCents: 0 });
  });

  it("writes the lines exactly as typed; the tax is on the invoice, not a line", async () => {
    await makeInvoice(state, [6_000, 4_000]);
    expect(state.inserted.lines.map((l) => l.amount_cents)).toEqual([6_000, 4_000]);
  });
});

describe("the switch on the client page", () => {
  const fn = read("src/lib/clients.functions.ts");
  const drawer = read("src/components/client-detail/EditClientDrawer.tsx");

  it("is written by updateClient behind the billing permission", () => {
    expect(fn).toMatch(/taxExempt: z\.boolean\(\)\.optional\(\)/);
    expect(fn).toMatch(
      /data\.active !== undefined \|\| data\.taxExempt !== undefined\s*\?\s*"manage_client_billing"/,
    );
    expect(fn).toMatch(/patch\.tax_exempt = data\.taxExempt/);
  });

  it("is read back so the drawer opens on the saved value", () => {
    const getClient = fn.slice(fn.indexOf("export const getClient"), fn.indexOf("export const updateClient"));
    expect(getClient).toMatch(/tax_exempt/);
    expect(drawer).toMatch(/taxExempt: !!client\?\.tax_exempt/);
  });

  it("is sent only when changed, so an unrelated edit does not need the billing permission for it", () => {
    expect(drawer).toMatch(
      /form\.taxExempt !== initial\.taxExempt \? \{ taxExempt: form\.taxExempt \} : \{\}/,
    );
  });
});
