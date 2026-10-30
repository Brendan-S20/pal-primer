import { describe, expect, it } from "vitest";
import {
  buildDigestInsights,
  buildWeeklyDigestSummary,
  type DigestInsightsInput,
  type WeeklyDigestStats,
} from "@/lib/digest-insights";

// The weekly digest email, the dashboard's digest panel and the Business
// Advisor stopped calling a model on 2026-10-03 (src/lib/digest-insights.ts
// says why). Every sentence they show is now built here, so every sentence can
// be checked against the numbers it came from.

const input = (o: Partial<DigestInsightsInput["raw"]> = {}, alerts: string[] = []): DigestInsightsInput => ({
  windowDays: 7,
  alerts,
  raw: {
    revenueCents: 120_000,
    revenueGrossCents: 120_000,
    refundsCents: 0,
    prevRevenueCents: 100_000,
    visitsCompleted: 48,
    visitsSkipped: 2,
    newClients: 3,
    openArCents: 0,
    overdueCents: 0,
    overdueInvoices: 0,
    atRiskCount: 0,
    complaintsCount: 0,
    ...o,
  },
});

describe("buildDigestInsights", () => {
  it("states revenue, the change on the previous period, and the work done", () => {
    const r = buildDigestInsights(input());
    expect(r.headline).toBe("Revenue of $1,200.00 across 48 completed visits.");
    expect(r.insights[0]).toBe(
      "Revenue was $1,200.00, up 20% on the previous 7 days ($1,000.00).",
    );
    expect(r.insights).toContain("You added 3 new clients and completed 48 visits, with 2 skipped.");
  });

  it("names the window it was asked about, not 'last week'", () => {
    const r = buildDigestInsights({ ...input(), windowDays: 30 });
    expect(r.insights[0]).toMatch(/previous 30 days/);
  });

  it("names a refund rather than letting the net figure look like a slow week", () => {
    const r = buildDigestInsights(input({ refundsCents: 5_000, revenueGrossCents: 125_000 }));
    expect(r.insights.join(" ")).toMatch(/\$50\.00 went back out in refunds and chargebacks/);
  });

  it("keeps the overdue figure and the open figure apart", () => {
    const r = buildDigestInsights(
      input({ openArCents: 272_500, overdueCents: 255_000, overdueInvoices: 10 }),
    );
    expect(r.insights.join(" ")).toMatch(
      /Open A\/R is \$2,725\.00, of which \$2,550\.00 is overdue across 10 invoices\./,
    );
  });

  it("leads its recommendations with the alerts, and has general advice only when there are none", () => {
    expect(buildDigestInsights(input({}, ["a", "b", "c", "d"])).recommendations).toEqual(["a", "b", "c"]);
    expect(buildDigestInsights(input({ atRiskCount: 2 })).recommendations[1]).toMatch(
      /2 at-risk clients/,
    );
  });

  it("returns the same commentary for the same numbers", () => {
    expect(buildDigestInsights(input())).toEqual(buildDigestInsights(input()));
  });
});

const stats = (o: Partial<WeeklyDigestStats> = {}): WeeklyDigestStats => ({
  org: "Scoop Troop",
  completed: 40,
  skipped: 10,
  scheduled: 52,
  completion_rate: 77,
  revenue_collected_cents: 90_000,
  revenue_collected_gross_cents: 95_000,
  refunds_chargebacks_cents: 5_000,
  refunds_chargebacks_count: 1,
  revenue_invoiced_cents: 110_000,
  open_invoices: 4,
  new_clients: 2,
  new_leads: 5,
  at_risk: [{ display_name: "Morgan Lee", churn_score: 82 }],
  ...o,
});

describe("buildWeeklyDigestSummary", () => {
  it("has the four sections the panel always had, plus next steps", () => {
    const s = buildWeeklyDigestSummary(stats());
    for (const h of ["### This week", "### Money", "### Growth", "### Watch list", "### Next steps"]) {
      expect(s).toContain(h);
    }
  });

  it("states only figures that are in the stats", () => {
    const s = buildWeeklyDigestSummary(stats());
    expect(s).toContain("40 visits completed of 52 scheduled. Completion rate 77%, counting missed and skipped visits against it.");
    expect(s).toContain(
      "Collected $900.00 after $50.00 in refunds and chargebacks ($950.00 before them).",
    );
    expect(s).toContain("2 new clients and 5 new leads.");
    expect(s).toContain("Call Morgan Lee first");
  });

  it("gives at most three next steps, and something useful in a quiet week", () => {
    const busy = buildWeeklyDigestSummary(stats());
    expect(busy.split("### Next steps")[1].trim().split("\n")).toHaveLength(3);
    const quiet = buildWeeklyDigestSummary(
      stats({ skipped: 0, open_invoices: 0, new_leads: 0, at_risk: [], refunds_chargebacks_cents: 0 }),
    );
    expect(quiet).toContain("Ask a happy client for a review.");
    expect(quiet).toContain("No clients with a churn score of 70 or more.");
  });

  it("puts no em dash in front of the owner", () => {
    expect(buildWeeklyDigestSummary(stats())).not.toMatch(/—/);
    expect(JSON.stringify(buildDigestInsights(input({ refundsCents: 1, openArCents: 1 })))).not.toMatch(/—/);
  });
});
