import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { orgLocalDay } from "@/lib/org-day";
import {
  MANUAL_PAYMENT_METHODS,
  describeManualPayment,
  receivedAtInstant,
  receivedOnProblem,
} from "@/lib/manual-payments";

// Until 2026-09-28 the only way to record money that did not go through
// Stripe was "Mark paid": the whole balance, today's instant, and a payments
// row that said `manual_mark_paid` and nothing else. A check received Friday
// and entered Monday was Monday's income on the cash-basis report, which
// buckets by orgLocalDay(paid_at), and nobody could say which check it was.
//
// These pin the two rules that are easy to get subtly wrong: which instant a
// back-dated day becomes, and which days are allowed at all. Both are about
// the ORG's calendar, not the machine running the suite.

// 2026-09-28 15:00 UTC is 10:00 in Chicago (CDT), 06:00 in Honolulu, and
// already 2026-09-29 01:00 in Sydney.
const NOW = new Date("2026-09-28T15:00:00Z");

describe("receivedAtInstant reads back as the day the office chose", () => {
  for (const tz of [
    "America/Chicago",
    "America/New_York",
    "Pacific/Honolulu",
    "Australia/Sydney",
  ]) {
    it(`an earlier day is that day in ${tz}`, () => {
      const at = receivedAtInstant("2026-09-25", tz, NOW);
      expect(orgLocalDay(at, tz)).toBe("2026-09-25");
    });
  }

  it("either side of a daylight-saving change", () => {
    // US clocks go back on 2026-11-01; Sydney's go forward on 2026-10-04.
    expect(
      orgLocalDay(receivedAtInstant("2026-11-01", "America/Chicago", NOW), "America/Chicago"),
    ).toBe("2026-11-01");
    expect(
      orgLocalDay(receivedAtInstant("2026-10-04", "Australia/Sydney", NOW), "Australia/Sydney"),
    ).toBe("2026-10-04");
  });

  it("today is now, so it sorts after anything else recorded today", () => {
    expect(receivedAtInstant("2026-09-28", "America/Chicago", NOW)).toBe(NOW.toISOString());
  });

  it("today is the ORG's today: in Sydney it is already the 29th", () => {
    expect(receivedAtInstant("2026-09-29", "Australia/Sydney", NOW)).toBe(NOW.toISOString());
    expect(receivedAtInstant("2026-09-28", "Australia/Sydney", NOW)).not.toBe(NOW.toISOString());
  });
});

describe("receivedOnProblem", () => {
  it("accepts today and the recent past", () => {
    expect(receivedOnProblem("2026-09-28", "America/Chicago", NOW)).toBeNull();
    expect(receivedOnProblem("2026-06-01", "America/Chicago", NOW)).toBeNull();
  });

  it("refuses tomorrow on the org's calendar", () => {
    expect(receivedOnProblem("2026-09-29", "America/Chicago", NOW)).toMatch(/future/);
    // ...which in Sydney is today, and fine.
    expect(receivedOnProblem("2026-09-29", "Australia/Sydney", NOW)).toBeNull();
  });

  it("refuses more than a year back, and garbage", () => {
    expect(receivedOnProblem("2025-09-01", "America/Chicago", NOW)).toMatch(/more than a year/);
    expect(receivedOnProblem("", "America/Chicago", NOW)).toMatch(/Choose/);
    expect(receivedOnProblem("09/27/2026", "America/Chicago", NOW)).toMatch(/Choose/);
  });
});

describe("describeManualPayment", () => {
  it("names the method and the reference the way a person would", () => {
    expect(describeManualPayment("check", "1042")).toBe("Check #1042");
    expect(describeManualPayment("check", "#1042")).toBe("Check #1042");
    expect(describeManualPayment("cash", null)).toBe("Cash");
    expect(describeManualPayment("venmo", "@dana-f")).toBe("Venmo · @dana-f");
    expect(describeManualPayment("bank_transfer", "  ")).toBe("Bank transfer");
  });

  it("says nothing for a Stripe payment or an unknown method", () => {
    expect(describeManualPayment(null, null)).toBeNull();
    expect(describeManualPayment("bitcoin", "x")).toBeNull();
  });
});

describe("the method list and the database agree", () => {
  it("every method the dialog offers is one the CHECK constraint allows, and no more", () => {
    const sql = readFileSync(
      "supabase/migrations/20260928030000_a-cash-payment-could-not-say-how-it-was-paid.sql",
      "utf8",
    );
    const m = sql.match(/method IN \(([^)]*)\)/);
    expect(m, "the CHECK constraint's IN list").not.toBeNull();
    const allowed = m![1].split(",").map((s) => s.trim().replace(/'/g, ""));
    expect([...allowed].sort()).toEqual([...MANUAL_PAYMENT_METHODS].sort());
  });
});
