import { describe, expect, it } from "vitest";
import { composeVisitInvoiceLines, visitBillableCents, type VisitBillingRow } from "@/lib/ar";
import { formatLineItemDescription } from "@/lib/invoice-labels";
import { formatDay } from "@/lib/format";

// The seasonal deep-clean surcharge. admin_generate_seasonal_deepcleans stamps
// every generated visit with the org's seasonal_deepclean_charge_cents, the
// visit list shows a "Deep clean" chip — and the invoice line was built from
// subscriptions.price_cents alone, so the surcharge was never charged.
// composeVisitInvoiceLines is the pure mirror of the fixed SQL
// (20260731210000_a-deep-clean-was-billed-as-an-ordinary-visit.sql).

const visit = (over: Partial<VisitBillingRow> = {}): VisitBillingRow => ({
  visitId: "v1",
  scheduledOn: "2026-03-02",
  status: "completed",
  priceCents: 2500,
  street: "412 Congress Ave",
  ...over,
});

describe("composeVisitInvoiceLines — ordinary visits are unchanged", () => {
  it("bills a completed visit at the subscription price, one line", () => {
    const lines = composeVisitInvoiceLines(visit());
    expect(lines).toEqual([
      { visitId: "v1", description: "Service on 2026-03-02 - 412 Congress Ave", amountCents: 2500 },
    ]);
  });

  it("omits the address separator when the property has no street", () => {
    expect(composeVisitInvoiceLines(visit({ street: null }))[0].description).toBe(
      "Service on 2026-03-02",
    );
  });

  it("bills a billable skip at its skip charge, not the visit price", () => {
    const lines = composeVisitInvoiceLines(
      visit({ status: "skipped", skipChargeCents: 1000, skipReasonCode: "gate_locked" }),
    );
    expect(lines).toEqual([
      { visitId: "v1", description: "Skipped visit 2026-03-02 (gate_locked)", amountCents: 1000 },
    ]);
  });
});

describe("composeVisitInvoiceLines — the deep-clean surcharge (the money bug)", () => {
  it("adds the surcharge as its own line: $25.00 visit + $49.00 deep clean = $74.00", () => {
    const lines = composeVisitInvoiceLines(
      visit({ isDeepclean: true, deepcleanChargeCents: 4900 }),
    );
    expect(lines).toEqual([
      {
        visitId: "v1",
        description: "Deep clean on 2026-03-02 - 412 Congress Ave",
        amountCents: 2500,
      },
      {
        visitId: null,
        description: "Seasonal deep-clean surcharge (2026-03-02)",
        amountCents: 4900,
      },
    ]);
    expect(visitBillableCents(visit({ isDeepclean: true, deepcleanChargeCents: 4900 }))).toBe(7400);
  });

  it("is ADDITIVE, not a replacement price — the visit price is still billed", () => {
    // Settings > Deep-clean calls it a surcharge "added to" the invoice, and
    // help-content calls it "billed at a premium over the regular visit".
    const dc = visit({ isDeepclean: true, deepcleanChargeCents: 4900 });
    expect(visitBillableCents(dc)).toBe((dc.priceCents ?? 0) + 4900);
    expect(visitBillableCents(dc)).toBeGreaterThan(visitBillableCents(visit()));
  });

  it("keeps the surcharge line off visit_id — one line per visit is a unique index", () => {
    const lines = composeVisitInvoiceLines(
      visit({ isDeepclean: true, deepcleanChargeCents: 4900 }),
    );
    expect(lines.filter((l) => l.visitId !== null)).toHaveLength(1);
  });

  it("labels the visit line so a deep clean never reads as an ordinary visit", () => {
    const [service] = composeVisitInvoiceLines(
      visit({ isDeepclean: true, deepcleanChargeCents: 4900 }),
    );
    expect(service.description).toContain("Deep clean");
  });

  it("emits no surcharge line when the org priced the surcharge at zero", () => {
    const lines = composeVisitInvoiceLines(visit({ isDeepclean: true, deepcleanChargeCents: 0 }));
    expect(lines).toHaveLength(1);
    expect(visitBillableCents(visit({ isDeepclean: true, deepcleanChargeCents: 0 }))).toBe(2500);
  });

  it("emits no surcharge line for a legacy visit with the charge unset", () => {
    expect(composeVisitInvoiceLines(visit({ isDeepclean: true }))).toHaveLength(1);
  });

  it("never surcharges a deep clean that did not happen (billable skip)", () => {
    const skipped = visit({
      status: "skipped",
      isDeepclean: true,
      deepcleanChargeCents: 4900,
      skipChargeCents: 1000,
      skipReasonCode: "weather",
    });
    expect(composeVisitInvoiceLines(skipped)).toHaveLength(1);
    expect(visitBillableCents(skipped)).toBe(1000);
  });

  it("prices off the visit snapshot, so re-pricing the setting cannot retro-bill", () => {
    // The visit carries the charge that was in force when it was generated.
    const old = visit({ isDeepclean: true, deepcleanChargeCents: 3900 });
    expect(visitBillableCents(old)).toBe(6400);
  });
});

describe("deep-clean line descriptions render to the customer", () => {
  it("humanizes the ISO date in both lines", () => {
    const lines = composeVisitInvoiceLines(
      visit({ isDeepclean: true, deepcleanChargeCents: 4900 }),
    );
    expect(formatLineItemDescription(lines[0].description)).toBe(
      `Deep clean on ${formatDay("2026-03-02")} - 412 Congress Ave`,
    );
    expect(formatLineItemDescription(lines[1].description)).toBe(
      `Seasonal deep-clean surcharge (${formatDay("2026-03-02")})`,
    );
    expect(formatLineItemDescription(lines[1].description)).not.toContain("2026-03-02");
  });

  it("humanizes the prepaid deep-clean line shape too", () => {
    // generate_prepaid_invoice writes "Prepaid deep clean on <ISO>".
    expect(formatLineItemDescription("Prepaid deep clean on 2026-03-02")).toBe(
      `Prepaid deep clean on ${formatDay("2026-03-02")}`,
    );
  });
});
