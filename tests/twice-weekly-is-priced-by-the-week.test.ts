// Twice-weekly was billed at 3.6x the weekly plan (#572, F-07).
//
// organizations.frequency_multipliers is applied PER VISIT by every pricing
// path. The shipped twice_weekly 1.8 therefore made one twice-weekly visit
// cost 1.8 weekly visits, and the week 3.6. A $35 weekly yard was $63 a
// visit, $126 a week. D1 (2026-10-28): 1.8 is the WEEK, so 0.9 a visit.
//
// The office paths (quote prefill, zone pricing the wizard stores) are pure
// and are exercised here with the seeded map. public_quote reads the same
// column in the database; its arithmetic is pinned against the newest body's
// text here, and proved in Postgres by
// twice-weekly-is-priced-by-the-week-in-a-real-database.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FREQUENCY_MULTIPLIERS,
  FREQUENCY_KEYS,
  multipliersProblem,
  perVisitMultiplier,
  weeklyTotalMultiplier,
  withDefaults,
} from "@/lib/frequency-multipliers";
import { LINE_SEEDS } from "@/lib/service-lines";
import { computeZoneVisitPrice } from "@/lib/pricing";
import { standardChoice, zoneChoice } from "@/lib/quote-pricing";

const ROOT = join(import.meta.dirname, "..");
const MIGRATIONS = join(ROOT, "supabase/migrations");
const MIGRATION = "20261029120000_twice-weekly-is-priced-by-the-week.sql";
const read = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");

const SHIPPED = { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 };
const M = LINE_SEEDS.pet_waste.frequencyMultipliers;

/** A week of a plan, from what one visit costs. */
const week = (perVisitCents: number, frequency: "weekly" | "twice_weekly") =>
  perVisitCents * (frequency === "twice_weekly" ? 2 : 1);

describe("the default table", () => {
  it("twice-weekly is 1.8x the weekly plan for the week, 0.9 a visit", () => {
    expect(M.twice_weekly).toBe(0.9);
    expect(weeklyTotalMultiplier(M, "twice_weekly")).toBeCloseTo(1.8, 10);
    expect(weeklyTotalMultiplier(M, "twice_weekly")).toBeLessThanOrEqual(2);
  });

  it("the shipped table was 3.6x, which is the fault", () => {
    expect(weeklyTotalMultiplier(SHIPPED, "twice_weekly")).toBeCloseTo(3.6, 10);
  });

  it("biweekly and monthly keep their values and their per-visit meaning", () => {
    expect(M.weekly).toBe(1);
    expect(M.biweekly).toBe(1.7);
    expect(M.monthly).toBe(3.2);
    // Cheaper a week than weekly, dearer a visit: waste builds up between.
    expect(weeklyTotalMultiplier(M, "biweekly")).toBeCloseTo(0.85, 10);
    expect(weeklyTotalMultiplier(M, "monthly")).toBeCloseTo(3.2 * (12 / 52), 10);
    expect(weeklyTotalMultiplier(M, "monthly")).toBeLessThan(1);
  });

  it("is the seed, the shared constant and the database column default at once", () => {
    expect(M).toBe(DEFAULT_FREQUENCY_MULTIPLIERS);
    const def = read(MIGRATION).match(/frequency_multipliers\s+SET DEFAULT '([^']+)'::jsonb/);
    expect(def, "the column default moved").not.toBeNull();
    expect(JSON.parse(def![1])).toEqual({ ...DEFAULT_FREQUENCY_MULTIPLIERS });
  });

  it("no later migration puts a different default back", () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f > MIGRATION)
      .filter((f) => /frequency_multipliers[\s\S]{0,80}DEFAULT/i.test(read(f)));
    expect(later).toEqual([]);
  });
});

describe("office pricing: the issue's own example", () => {
  // Weekly $35 a visit = $35 a week. Twice weekly should be $31.50 a visit,
  // $63 a week (1.8x), not $63 a visit and $126 a week.
  const zone = {
    base_price_cents: 3500,
    per_dog_addl_cents: 0,
    pricing_mode: "flat" as const,
  };

  it("zone pricing, as the new-client wizard stores it", () => {
    const weekly = computeZoneVisitPrice(zone, { dogCount: 1, multiplier: M.weekly });
    const twice = computeZoneVisitPrice(zone, { dogCount: 1, multiplier: M.twice_weekly });
    expect(weekly.recurringCents).toBe(3500);
    expect(twice.recurringCents).toBe(3150);
    expect(week(twice.recurringCents, "twice_weekly")).toBe(6300);
    expect(week(twice.recurringCents, "twice_weekly") / week(weekly.recurringCents, "weekly")).toBe(
      1.8,
    );

    const before = computeZoneVisitPrice(zone, { dogCount: 1, multiplier: SHIPPED.twice_weekly });
    expect(before.recurringCents).toBe(6300);
    expect(week(before.recurringCents, "twice_weekly")).toBe(12600);
  });

  it("the quote prefill from a zone", () => {
    const z = { id: "z1", name: "North", zip_codes: ["48009"], ...zone };
    const standard = { basePriceCents: null, perDogAddlCents: null, frequencyMultipliers: M };
    const weekly = zoneChoice(z, { frequency: "weekly", dogCount: 1 }, standard)!;
    const twice = zoneChoice(z, { frequency: "twice_weekly", dogCount: 1 }, standard)!;
    expect(weekly.priceCents).toBe(3500);
    expect(twice.priceCents).toBe(3150);
    expect(twice.breakdown).toMatch(/x0\.9 for twice-weekly visits/);
    expect(week(twice.priceCents, "twice_weekly")).toBe(Math.round(1.8 * weekly.priceCents));
  });

  it("the quote prefill from standard pricing, with extra dogs", () => {
    // 4 dogs: $25 base + 3 x $5 = $40 a weekly visit.
    const standard = { basePriceCents: 2500, perDogAddlCents: 500, frequencyMultipliers: M };
    const weekly = standardChoice({ frequency: "weekly", dogCount: 4 }, standard)!;
    const twice = standardChoice({ frequency: "twice_weekly", dogCount: 4 }, standard)!;
    expect(weekly.priceCents).toBe(4000);
    expect(twice.priceCents).toBe(3600);
    expect(week(twice.priceCents, "twice_weekly")).toBe(7200);
    expect(week(twice.priceCents, "twice_weekly")).toBeLessThanOrEqual(2 * weekly.priceCents);
  });
});

describe("public_quote reads the same column, per visit", () => {
  // The newest body, by filename. Its pet-waste branch multiplies one visit by
  // the org's map, so a twice-weekly quote is the zone price x 0.9 once the
  // row says 0.9. No new body is needed for the fix, and none was written.
  const newest = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => /CREATE OR REPLACE FUNCTION public\.public_quote\(/.test(read(f)))
    .pop()!;
  const body = read(newest);

  it("multiplies the visit by frequency_multipliers ->> _frequency", () => {
    expect(body).toMatch(
      /_mult := COALESCE\(\(_org\.frequency_multipliers ->> _frequency\)::numeric, 1\.0\);/,
    );
    expect(body).toMatch(/_recurring := round\(_base_visit_cents \* _mult\)::integer;/);
  });

  it("which on the issue's live example is $22.50 a visit, $45 a week", () => {
    // /signup/demo-pet-waste-co, ZIP 48009, 1 dog: weekly $25.00.
    const visit = Math.round(2500 * perVisitMultiplier(M, "twice_weekly"));
    expect(visit).toBe(2250);
    expect(week(visit, "twice_weekly")).toBe(4500);
  });
});

describe("the migration", () => {
  const sql = read(MIGRATION);

  it("moves every org still on the shipped 1.8 to 0.9, and only those", () => {
    expect(sql).toMatch(/jsonb_set\(frequency_multipliers, '\{twice_weekly\}', '0\.9'::jsonb\)/);
    expect(sql).toMatch(/\(frequency_multipliers ->> 'twice_weekly'\)::numeric = 1\.8;/);
  });

  it("gives the owner a write that caps twice-weekly at the weekly price", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.update_org_frequency_multipliers\(/);
    expect(sql).toMatch(/IF _twice_weekly > 1 THEN/);
    expect(sql).toMatch(/has_role\(auth\.uid\(\), _org_id, 'owner'\)/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.update_org_frequency_multipliers[^;]+FROM PUBLIC, anon;/,
    );
  });
});

describe("what the owner can save", () => {
  it("accepts the default table", () => {
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS })).toBeNull();
  });

  it("refuses a twice-weekly visit dearer than a weekly one", () => {
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS, twice_weekly: 1.8 })).toMatch(
      /twice-weekly/i,
    );
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS, twice_weekly: 1 })).toBeNull();
  });

  it("refuses a weekly that is not the price itself, and nonsense", () => {
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS, weekly: 2 })).not.toBeNull();
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS, monthly: NaN })).not.toBeNull();
    expect(multipliersProblem({ ...DEFAULT_FREQUENCY_MULTIPLIERS, biweekly: 0 })).not.toBeNull();
  });

  it("an org map with a gap is shown with the default for it", () => {
    expect(withDefaults({ weekly: 1, biweekly: 2 })).toEqual({
      ...DEFAULT_FREQUENCY_MULTIPLIERS,
      biweekly: 2,
    });
    for (const k of FREQUENCY_KEYS)
      expect(withDefaults(null)[k]).toBe(DEFAULT_FREQUENCY_MULTIPLIERS[k]);
  });
});

describe("the card is on the settings page", () => {
  const page = readFileSync(join(ROOT, "src/routes/_authenticated/settings.business.tsx"), "utf8");
  const card = readFileSync(join(ROOT, "src/components/FrequencyPricingCard.tsx"), "utf8");

  it("rendered for a pet-waste business with manage_pricing", () => {
    expect(page).toMatch(/known && petWaste && <FrequencyPricingCard \/>/);
  });

  it("saves through the server function that calls the RPC", () => {
    expect(card).toMatch(/updateFrequencyMultipliers/);
    const fns = readFileSync(join(ROOT, "src/lib/subscriptions.functions.ts"), "utf8");
    expect(fns).toMatch(/rpc\("update_org_frequency_multipliers"/);
  });
});
