import { describe, expect, it } from "vitest";
import {
  REPORT_DEFS,
  REPORT_ORDER,
  agingBucket,
  daysBetween,
  monthLabel,
  monthsBetween,
  monthKey,
  orgLocalDay,
  reducesIncome,
  reportFileName,
  reportsFor,
  reversalLabel,
  routingAudience,
  stripe1099kGuidance,
  type ReportId,
} from "@/lib/cpa-reports";

// BUILD-13. These are tax definitions, so the tests are about the cases that
// produce a WRONG NUMBER on a return rather than about coverage: the year
// boundary in a non-UTC timezone, aging from the wrong date, a refund counted
// twice, and the 1099-K explanation being given to the wrong party.

describe("orgLocalDay — the tax-year boundary", () => {
  it("keeps a New Year's Eve evening payment in the year it was taken", () => {
    // 7pm on 31 Dec in Chicago is 1 Jan 01:00 UTC. A naive slice(0,10) files
    // this payment in the WRONG TAX YEAR — not an off-by-one, a wrong return.
    const iso = "2027-01-01T01:00:00Z";
    expect(iso.slice(0, 10)).toBe("2027-01-01");
    expect(orgLocalDay(iso, "America/Chicago")).toBe("2026-12-31");
  });

  it("keeps a New Year's Day morning payment out of the prior year", () => {
    expect(orgLocalDay("2027-01-01T14:00:00Z", "America/Chicago")).toBe("2027-01-01");
  });

  it("handles an org east of UTC, where the slip runs the other way", () => {
    // 11pm UTC on 31 Dec is already 1 Jan in Auckland.
    expect(orgLocalDay("2026-12-31T23:00:00Z", "Pacific/Auckland")).toBe("2027-01-01");
  });

  it("returns empty for an unparseable timestamp rather than throwing", () => {
    expect(orgLocalDay("not a date", "UTC")).toBe("");
  });
});

describe("months", () => {
  it("emits every month in the range so a quiet month shows as a zero row", () => {
    expect(monthsBetween("2026-11-14", "2027-02-03")).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
  });

  it("returns a single month when the range sits inside one", () => {
    expect(monthsBetween("2026-03-02", "2026-03-30")).toEqual(["2026-03"]);
  });

  it("returns nothing when the range runs backwards", () => {
    expect(monthsBetween("2026-05-01", "2026-02-01")).toEqual([]);
  });

  it("labels a month for a human", () => {
    expect(monthLabel("2026-07")).toBe("July 2026");
    expect(monthKey("2026-07-14")).toBe("2026-07");
  });
});

describe("aging", () => {
  it("ages from the DUE date, not the issue date", () => {
    // Issued 40 days ago on 30-day terms is 10 days overdue, not 40. Aging from
    // issue would report a current invoice as a month late and make a healthy
    // book look like a collections problem.
    expect(agingBucket("2026-07-25", "2026-06-15", "2026-07-25")).toBe("current");
    expect(agingBucket("2026-06-15", "2026-05-15", "2026-07-25")).toBe("d60");
  });

  it("falls back to the issue date only when no due date was ever set", () => {
    expect(agingBucket(null, "2026-06-25", "2026-07-25")).toBe("d30");
  });

  it("treats a not-yet-due invoice as current", () => {
    expect(agingBucket("2026-09-01", "2026-08-01", "2026-07-25")).toBe("current");
  });

  it("walks every bucket boundary exactly", () => {
    const as = "2026-07-25";
    expect(agingBucket("2026-07-25", null, as)).toBe("current"); // 0 days
    expect(agingBucket("2026-07-24", null, as)).toBe("d30"); // 1
    expect(agingBucket("2026-06-25", null, as)).toBe("d30"); // 30
    expect(agingBucket("2026-06-24", null, as)).toBe("d60"); // 31
    expect(agingBucket("2026-05-26", null, as)).toBe("d60"); // 60
    expect(agingBucket("2026-05-25", null, as)).toBe("d90"); // 61
    expect(agingBucket("2026-04-26", null, as)).toBe("d90"); // 90
    expect(agingBucket("2026-04-25", null, as)).toBe("d90plus"); // 91
  });

  it("counts days across a daylight-saving transition without slipping", () => {
    // US DST starts 8 March 2026. Anchoring at UTC noon keeps this exact.
    expect(daysBetween("2026-03-01", "2026-03-15")).toBe(14);
    expect(daysBetween("2026-10-25", "2026-11-08")).toBe(14);
  });

  it("defaults to current when there is no date to age from at all", () => {
    expect(agingBucket(null, null, "2026-07-25")).toBe("current");
  });
});

describe("reversals", () => {
  it("deducts refunds and open chargebacks from income", () => {
    expect(reducesIncome("payment_refunded")).toBe(true);
    expect(reducesIncome("payment_chargeback")).toBe(true);
  });

  it("does NOT deduct a won dispute — the money came back", () => {
    // Deducting a recovery as well as recording it would understate income by
    // twice the disputed amount.
    expect(reducesIncome("payment_chargeback_won")).toBe(false);
  });

  it("labels every kind the webhook can file", () => {
    for (const k of ["payment_refunded", "payment_chargeback", "payment_chargeback_won"]) {
      const l = reversalLabel(k);
      expect(l.type).toBeTruthy();
      expect(l.outcome).toBeTruthy();
    }
  });
});

describe("1099-K guidance", () => {
  it("warns the collecting franchise that the 1099-K covers every location", () => {
    const g = stripe1099kGuidance("parent_collects");
    expect(g.headline).toMatch(/franchise receives the 1099-K/i);
    expect(g.points.join(" ")).toMatch(/gross/i);
  });

  it("tells a self-collecting location that royalty is a deductible expense", () => {
    expect(stripe1099kGuidance("location_collects").points.join(" ")).toMatch(/deductible/i);
  });

  it("tells an independent business the 1099-K is gross of fees and refunds", () => {
    const g = stripe1099kGuidance("independent");
    expect(g.points.join(" ")).toMatch(/before refunds/i);
    expect(g.points.join(" ")).toMatch(/fees/i);
  });

  it("gives an ordinary business the independent explanation", () => {
    expect(routingAudience({})).toBe("independent");
  });

  it("keys a location's explanation to how ITS payments are routed", () => {
    expect(routingAudience({ parentOrganizationId: "p", paymentsCollectedByParent: true })).toBe(
      "parent_collects",
    );
    expect(routingAudience({ parentOrganizationId: "p", paymentsCollectedByParent: false })).toBe(
      "location_collects",
    );
  });

  it("only warns a franchise parent when it actually collects for a location", () => {
    // Routing is per-location. A franchise flagged as a parent that collects
    // for nobody would otherwise be told to expect a 1099-K covering volume it
    // never touches — a scary, wrong warning.
    expect(routingAudience({ isFranchiseParent: true, collectsForAnyLocation: false })).toBe(
      "location_collects",
    );
    expect(routingAudience({ isFranchiseParent: true, collectsForAnyLocation: true })).toBe(
      "parent_collects",
    );
  });
});

describe("report catalogue", () => {
  it("lists every defined report exactly once, in order", () => {
    const ids = Object.keys(REPORT_DEFS) as ReportId[];
    expect([...REPORT_ORDER].sort()).toEqual([...ids].sort());
    expect(new Set(REPORT_ORDER).size).toBe(REPORT_ORDER.length);
  });

  it("hides the franchise sheet from a business that isn't in one", () => {
    const solo = reportsFor({ inFranchise: false }).map((d) => d.id);
    expect(solo).not.toContain("franchise_settlements");
    expect(reportsFor({ inFranchise: true }).map((d) => d.id)).toContain("franchise_settlements");
  });

  it("declares a basis and a purpose on every report", () => {
    // A sheet handed to an accountant without a stated basis is a sheet they
    // have to come back and ask about, which is the whole thing this is for.
    for (const id of REPORT_ORDER) {
      const d = REPORT_DEFS[id];
      expect(d.purpose.length).toBeGreaterThan(20);
      expect(["cash", "accrual", "none"]).toContain(d.basis);
      expect(d.columns.length).toBeGreaterThan(0);
    }
  });

  it("gives every column a unique key within its report", () => {
    for (const id of REPORT_ORDER) {
      const keys = REPORT_DEFS[id].columns.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it("builds a filename that survives a downloads folder", () => {
    expect(reportFileName("income_cash", "2026-01-01", "2026-12-31", "Mike's Scoop Squad!")).toBe(
      "mike-s-scoop-squad_income_cash_2026-01-01_to_2026-12-31.csv",
    );
  });

  it("falls back to a usable filename when the org has no printable name", () => {
    expect(reportFileName("ar_aging", "2026-01-01", "2026-03-31", "!!!")).toBe(
      "houndstack_ar_aging_2026-01-01_to_2026-03-31.csv",
    );
  });
});
