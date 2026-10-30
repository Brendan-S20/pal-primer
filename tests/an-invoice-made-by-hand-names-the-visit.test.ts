/** #605: a hand-made invoice names the visits it bills, so the billing run
 *  leaves them alone. The pure rules: which visits can be invoiced by hand,
 *  and what their lines say. The round trip through Postgres is
 *  tests/integration/a-visit-invoiced-at-completion.db.test.ts. */
import { describe, expect, it } from "vitest";
import {
  linesForVisit,
  liveInvoiceFor,
  serviceLineItemName,
  visitInvoiceBlocker,
  type BillableVisit,
  type PendingAddon,
  type VisitLink,
} from "@/lib/visit-invoicing";

const visit = (over: Partial<BillableVisit> = {}): BillableVisit => ({
  id: "v1",
  scheduled_on: "2026-10-25",
  status: "completed",
  skip_billable: false,
  skip_charge_cents: 0,
  skip_reason_code: null,
  is_deepclean: false,
  deepclean_charge_cents: 0,
  price_cents: 3000,
  client_package_id: null,
  subscription: { price_cents: 2500, billing_cadence: "postpaid" },
  service_name: "30-minute walk",
  street: "12 Elm St",
  ...over,
});

const link = (status: string, number = 1042): VisitLink => ({
  visit_id: "v1",
  invoice: { id: `inv-${status}`, number, status },
});

const label = (inv: { id: string; number: number | null }) => `INV-${inv.number}`;

describe("which visits can be invoiced by hand", () => {
  it("a completed postpaid visit on no invoice can", () => {
    expect(visitInvoiceBlocker(visit(), [], label)).toBeNull();
  });

  it("a visit on a live invoice cannot, and says which invoice", () => {
    expect(visitInvoiceBlocker(visit(), [link("open")], label)).toBe(
      "This visit is already on invoice INV-1042.",
    );
  });

  it("a line on a void invoice does not count: voiding gave the money back", () => {
    expect(liveInvoiceFor("v1", [link("void")])).toBeNull();
    expect(visitInvoiceBlocker(visit(), [link("void")], label)).toBeNull();
  });

  it("a prepaid visit cannot: it was paid from the balance at completion", () => {
    const v = visit({ subscription: { price_cents: 2500, billing_cadence: "prepaid" } });
    expect(visitInvoiceBlocker(v, [], label)).toMatch(/prepaid/);
  });

  it("a package lesson cannot: it is on the package invoice", () => {
    expect(visitInvoiceBlocker(visit({ client_package_id: "p1" }), [], label)).toMatch(/package/);
  });

  it("a scheduled visit, or a skip that is not billable, cannot", () => {
    expect(visitInvoiceBlocker(visit({ status: "scheduled" }), [], label)).toMatch(/completed/);
    expect(visitInvoiceBlocker(visit({ status: "skipped" }), [], label)).toMatch(/completed/);
    expect(
      visitInvoiceBlocker(visit({ status: "skipped", skip_billable: true }), [], label),
    ).toBeNull();
  });
});

describe("the lines, in the billing run's words", () => {
  it("bills the visit at its frozen price, named for its service, linked to the visit", () => {
    expect(linesForVisit(visit(), [])).toEqual([
      { visitId: "v1", description: "30-minute walk on 2026-10-25 - 12 Elm St", amountCents: 3000 },
    ]);
  });

  it("falls back to the plan's price when the visit has none", () => {
    expect(linesForVisit(visit({ price_cents: null }), [])[0].amountCents).toBe(2500);
  });

  it("calls the seeded pet-waste service, or none, Service", () => {
    expect(serviceLineItemName("Pet waste removal")).toBe("Service");
    expect(serviceLineItemName(null)).toBe("Service");
    expect(serviceLineItemName(" Walk ")).toBe("Walk");
  });

  it("bills a billable skip at its skip charge", () => {
    const v = visit({
      status: "skipped",
      skip_billable: true,
      skip_charge_cents: 1500,
      skip_reason_code: "locked_gate",
    });
    expect(linesForVisit(v, [])).toEqual([
      { visitId: "v1", description: "Skipped visit 2026-10-25 (locked_gate)", amountCents: 1500 },
    ]);
  });

  it("adds the deep-clean surcharge, and each pending add-on charged with this visit", () => {
    const addons: PendingAddon[] = [
      {
        id: "a1",
        visit_id: "v1",
        description: "Nail trim",
        occurred_on: "2026-10-25",
        quantity: 2,
        amount_cents: 1000,
      },
      {
        id: "a2",
        visit_id: "other",
        description: "Not this one",
        occurred_on: "2026-10-25",
        quantity: 1,
        amount_cents: 500,
      },
    ];
    const lines = linesForVisit(
      visit({ is_deepclean: true, deepclean_charge_cents: 4000 }),
      addons,
    );
    expect(lines).toEqual([
      { visitId: "v1", description: "Deep clean on 2026-10-25 - 12 Elm St", amountCents: 3000 },
      { description: "Seasonal deep-clean surcharge (2026-10-25)", amountCents: 4000 },
      { addonChargeId: "a1", description: "Nail trim (2026-10-25) x 2", amountCents: 1000 },
    ]);
  });
});
