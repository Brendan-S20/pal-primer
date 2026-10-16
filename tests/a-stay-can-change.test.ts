// A confirmed stay can change, and a cancel keeps the nights worked (#411
// review, blocker 1). The pure rules the change form uses, and the shape of
// the migration that holds the same rules in the database. The round trips
// are in tests/integration/stay-changes.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changedVisitPriceCents,
  earliestStayEnd,
  priceDifferenceSentence,
  splitStayVisits,
  stayChangeDifferenceCents,
} from "@/lib/stays";
import { formatServiceMoney } from "@/lib/services";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sql = readFileSync(
  join(ROOT, "supabase/migrations/20261017000000_a-stay-can-change.sql"),
  "utf8",
);

const TODAY = "2026-10-20";
const night = { price_unit: "night", base_price_cents: 6000, extra_pet_cents: 1500, default_duration_min: null };

describe("worked and future visits", () => {
  const visits = [
    { scheduled_on: "2026-10-18", status: "completed" },
    { scheduled_on: "2026-10-19", status: "scheduled" },
    { scheduled_on: "2026-10-20", status: "in_progress" },
    { scheduled_on: "2026-10-20", status: "scheduled" },
    { scheduled_on: "2026-10-21", status: "scheduled" },
    { scheduled_on: "2026-10-22", status: "canceled" },
  ];

  it("a scheduled visit from today on is still to come; a canceled one is neither", () => {
    const { worked, future } = splitStayVisits(visits, TODAY);
    expect(future.map((v) => v.scheduled_on)).toEqual(["2026-10-20", "2026-10-21"]);
    expect(worked.map((v) => v.status)).toEqual(["completed", "scheduled", "in_progress"]);
  });

  it("a stay ends no earlier than its last visit under way or done, nor before yesterday", () => {
    expect(earliestStayEnd("drop_in", visits, TODAY)).toBe("2026-10-20");
    expect(earliestStayEnd("overnight", visits, TODAY)).toBe("2026-10-21");
    expect(earliestStayEnd("drop_in", [], TODAY)).toBe("2026-10-19");
    expect(earliestStayEnd("overnight", [], TODAY)).toBe("2026-10-20");
  });
});

describe("the price of a pet change", () => {
  it("moves the current price by the service's own difference", () => {
    expect(changedVisitPriceCents(6000, night, 1, 2)).toBe(7500);
    expect(changedVisitPriceCents(7500, night, 2, 1)).toBe(6000);
    // A price the office typed keeps its offset.
    expect(changedVisitPriceCents(5000, night, 1, 3)).toBe(8000);
    expect(changedVisitPriceCents(5000, night, 2, 2)).toBe(5000);
  });

  it("is null when the service has no price, and never below zero", () => {
    expect(changedVisitPriceCents(6000, { ...night, base_price_cents: null }, 1, 2)).toBeNull();
    expect(changedVisitPriceCents(500, night, 3, 1)).toBe(0);
  });
});

describe("the price difference the form shows", () => {
  const nights = (from: string, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(`${from}T12:00:00Z`);
      d.setUTCDate(d.getUTCDate() + i);
      return { scheduled_on: d.toISOString().slice(0, 10), status: "scheduled" };
    });

  it("two more nights at $75 adds $150", () => {
    expect(
      stayChangeDifferenceCents({
        kind: "overnight",
        windowCount: 1,
        today: TODAY,
        visits: nights("2026-10-25", 5),
        currentVisitCents: 7500,
        newVisitCents: 7500,
        startsOn: "2026-10-25",
        endsOn: "2026-11-01",
      }),
    ).toBe(15000);
  });

  it("coming home two days early on a started stay takes the two nights off", () => {
    const visits = [
      { scheduled_on: "2026-10-18", status: "completed" },
      { scheduled_on: "2026-10-19", status: "completed" },
      ...nights("2026-10-20", 4),
    ];
    expect(
      stayChangeDifferenceCents({
        kind: "overnight",
        windowCount: 1,
        today: TODAY,
        visits,
        currentVisitCents: 7500,
        newVisitCents: 7500,
        startsOn: "2026-10-18",
        endsOn: "2026-10-22",
      }),
    ).toBe(-15000);
  });

  it("a second pet reprices only the visits to come", () => {
    const visits = [
      { scheduled_on: "2026-10-19", status: "completed" },
      { scheduled_on: "2026-10-19", status: "completed" },
      { scheduled_on: "2026-10-20", status: "completed" },
      { scheduled_on: "2026-10-20", status: "scheduled" },
      { scheduled_on: "2026-10-21", status: "scheduled" },
      { scheduled_on: "2026-10-21", status: "scheduled" },
    ];
    // Drop-ins twice a day, $25 to $30: three visits to come, $5 each.
    expect(
      stayChangeDifferenceCents({
        kind: "drop_in",
        windowCount: 2,
        today: TODAY,
        visits,
        currentVisitCents: 2500,
        newVisitCents: 3000,
        startsOn: "2026-10-19",
        endsOn: "2026-10-21",
      }),
    ).toBe(1500);
  });

  it("says which way the price moves", () => {
    expect(priceDifferenceSentence(15000, formatServiceMoney)).toBe("Adds $150.00 before tax.");
    expect(priceDifferenceSentence(-7500, formatServiceMoney)).toBe("Takes $75.00 off before tax.");
    expect(priceDifferenceSentence(0, formatServiceMoney)).toBe("No change to the price.");
  });
});

describe("the migration", () => {
  it("lets the dates and pets through only for change_stay's own stay", () => {
    expect(sql).toMatch(/PERFORM set_config\('houndstack\.stay_change', _st\.id::text, true\)/);
    expect(sql.match(/current_setting\('houndstack\.stay_change', true\) IS DISTINCT FROM OLD\.id::text/g)).toHaveLength(2);
  });

  it("gates change_stay on can_write_org and keeps the internals off the API", () => {
    expect(sql).toMatch(/IF NOT public\.can_write_org\(auth\.uid\(\), _st\.organization_id\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.change_stay\(uuid, date, date, uuid\[\]\) FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.restate_stay_billing\(uuid\) FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.stay_visit_bill\(uuid\) FROM PUBLIC, anon, authenticated;/);
  });

  it("never touches a completed visit", () => {
    const updates = sql.match(/UPDATE public\.visits v[\s\S]*?;/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(u).toMatch(/v\.status (=|NOT IN) \(?'(scheduled|canceled)'/);
  });

  it("a cancel restates the bill instead of voiding the stay invoice outright", () => {
    const follow = sql.slice(sql.indexOf("FUNCTION public.tg_stays_follow()"));
    expect(follow).toMatch(/PERFORM public\.restate_stay_billing\(NEW\.id\)/);
    expect(follow.slice(0, follow.indexOf("$function$;"))).not.toMatch(/NEW\.invoice_id, NEW\.deposit_invoice_id/);
  });
});
