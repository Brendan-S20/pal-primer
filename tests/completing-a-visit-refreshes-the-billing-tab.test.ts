import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateBillingAfterVisitCompleted } from "@/lib/client-visit-history-cache";

// #1028: after the first visit was completed the invoice existed, but the
// client's Billing tab and header still read the cached "no invoices, $0".
describe("completing a visit refreshes billing", () => {
  const seed = () => {
    const qc = new QueryClient();
    qc.setQueryData(["billing-summary", "c1"], { openCount: 0, openTotalCents: 0, invoices: [] });
    qc.setQueryData(["billing-summary", "c2"], { openCount: 0, openTotalCents: 0, invoices: [] });
    qc.setQueryData(["invoices"], []);
    return qc;
  };

  it("marks the client's billing summary and the invoice lists stale", () => {
    const qc = seed();
    invalidateBillingAfterVisitCompleted(qc, "c1");
    expect(qc.getQueryState(["billing-summary", "c1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["invoices"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["billing-summary", "c2"])?.isInvalidated).toBe(false);
  });

  it("without a client id (the visit drawer) refreshes every billing summary", () => {
    const qc = seed();
    invalidateBillingAfterVisitCompleted(qc);
    expect(qc.getQueryState(["billing-summary", "c1"])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(["billing-summary", "c2"])?.isInvalidated).toBe(true);
  });
});
