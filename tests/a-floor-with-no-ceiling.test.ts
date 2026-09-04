// Area pricing had a floor and no ceiling.
//
// `zones.area_min_charge_cents` bounds the area component from BELOW, and
// until this change nothing bounded it from above -- so a per-sqft or per-acre
// rate times a large enough lot returned an arbitrarily large per-visit price
// and the quote screen would have shown it.
//
// Measured on the live database: a zone at 0.75c/sqft over a $20 base with a
// $25 floor computes $287.92 per visit for a 35,700 sqft yard, $489.46 after
// the biweekly multiplier. That customer pays $26.00. Nobody was ever charged
// the larger number, and the reason is the whole shape of the problem -- a
// zone rate is read ONCE, when a subscription is created, and never consulted
// again. The arithmetic was never wrong in production only because it was
// never used in production.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeZoneVisitPrice, SQFT_PER_SQM } from "../src/lib/pricing";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** The real Westside Suburb configuration, as it stands in production. */
const WESTSIDE = {
  base_price_cents: 2000,
  per_dog_addl_cents: 400,
  pricing_mode: "per_sqft" as const,
  price_per_sqft_cents: 0.75,
  price_per_acre_cents: 0,
  area_min_charge_cents: 2500,
  area_max_charge_cents: null as number | null,
};

/** 35,700 sqft, the lot that produced the $489.46 quote. */
const BIG_YARD_SQM = 35700 / SQFT_PER_SQM;

describe("the area component cannot run away", () => {
  it("reproduces the unbounded quote, so the fix has something to bind", () => {
    const out = computeZoneVisitPrice(WESTSIDE, { dogCount: 1, boundaryAreaSqm: BIG_YARD_SQM });
    expect(out.perVisitCents).toBeGreaterThan(28000);
    expect(out.areaCapped).toBe(false);
  });

  it("binds it to the ceiling when the zone declares one", () => {
    const out = computeZoneVisitPrice(
      { ...WESTSIDE, area_max_charge_cents: 4000 },
      { dogCount: 1, boundaryAreaSqm: BIG_YARD_SQM },
    );
    // $20 base + $40 capped area, and nothing else.
    expect(out.perVisitCents).toBe(6000);
    expect(out.areaCapped).toBe(true);
  });

  it("leaves an ordinary yard alone", () => {
    // The cap is a rail, not a rate. A lot that never reaches it must quote
    // exactly what it quoted before.
    const small = { dogCount: 2, boundaryAreaSqm: 400 };
    const before = computeZoneVisitPrice(WESTSIDE, small);
    const after = computeZoneVisitPrice({ ...WESTSIDE, area_max_charge_cents: 9999900 }, small);
    expect(after.perVisitCents).toBe(before.perVisitCents);
    expect(after.areaCapped).toBe(false);
  });

  it("still honours the floor underneath the ceiling", () => {
    const tiny = { dogCount: 1, boundaryAreaSqm: 1 };
    const out = computeZoneVisitPrice({ ...WESTSIDE, area_max_charge_cents: 6000 }, tiny);
    // Area basis rounds to ~8 cents; the $25 floor is what should apply.
    expect(out.perVisitCents).toBe(2000 + 2500);
    expect(out.areaCapped).toBe(false);
  });

  it("resolves a zone saved with min above max to the LOWER of the two", () => {
    // Save-time validation and a CHECK constraint both reject that pair, so
    // this should not arise -- but of the two possible answers only one cannot
    // produce a $489 invoice, and that is the one the math picks.
    const out = computeZoneVisitPrice(
      { ...WESTSIDE, area_min_charge_cents: 9000, area_max_charge_cents: 3000 },
      { dogCount: 1, boundaryAreaSqm: 1 },
    );
    expect(out.perVisitCents).toBe(2000 + 3000);
    expect(out.areaCapped).toBe(true);
  });

  it("treats a missing ceiling as no ceiling, which is today's behaviour", () => {
    // The migration adds no default and backfills nothing, so every zone
    // written before it keeps quoting exactly as it does now. Nothing about
    // this change moves a price on its own.
    const withNull = computeZoneVisitPrice(WESTSIDE, { dogCount: 1, boundaryAreaSqm: 400 });
    const withUndef = computeZoneVisitPrice(
      { ...WESTSIDE, area_max_charge_cents: undefined },
      { dogCount: 1, boundaryAreaSqm: 400 },
    );
    expect(withUndef.perVisitCents).toBe(withNull.perVisitCents);
  });
});

describe("an area-priced zone cannot be saved without one", () => {
  const fns = read("src/lib/zones.functions.ts");

  it("has the rule, and applies it to flat zones never", () => {
    expect(fns).toMatch(/function requireAreaCeiling/);
    const body = fns.slice(fns.indexOf("function requireAreaCeiling"));
    expect(body).toMatch(/mode !== "per_sqft" && mode !== "per_acre"/);
  });

  it("checks it on create and on update", () => {
    const calls = fns.match(/requireAreaCeiling\(/g) ?? [];
    // One declaration plus two call sites.
    expect(calls.length).toBe(3);
  });

  it("merges the patch over the stored row before judging an update", () => {
    // Two ways to become area-priced with no ceiling that reading the patch
    // alone would miss: switching a flat zone to per_sqft without touching the
    // cap, and clearing the cap without touching the mode.
    const upd = fns.slice(fns.indexOf("export const updateZone"));
    expect(upd).toMatch(
      /data\.pricingMode !== undefined \? data\.pricingMode : existing\.pricing_mode/,
    );
    expect(upd).toMatch(/existing\.area_max_charge_cents/);
    // ...which requires those columns to actually be selected.
    expect(upd).toMatch(/pricing_mode, area_max_charge_cents/);
  });
});

describe("the migration", () => {
  const mig = read("supabase/migrations/20260903160000_a-floor-with-no-ceiling.sql");

  it("adds no default and backfills nothing", () => {
    expect(mig).toMatch(/ADD COLUMN IF NOT EXISTS area_max_charge_cents integer;/);
    expect(mig).not.toMatch(/ALTER COLUMN area_max_charge_cents SET DEFAULT/);
    expect(mig).not.toMatch(/UPDATE public\.zones\s+SET area_max_charge_cents/);
  });

  it("constrains the ceiling to sit above the floor, and validates it", () => {
    expect(mig).toMatch(/CHECK \(\s*area_max_charge_cents IS NULL/);
    expect(mig).toMatch(/VALIDATE CONSTRAINT zones_area_ceiling_above_floor/);
  });

  it("warns about existing uncapped zones rather than failing the replay", () => {
    // A count of rows this file did not create is a premise, not a product:
    // a fresh build has no zones and must not fail for it.
    // From where the count is TAKEN, not from the DECLARE that names it --
    // the assertions above it are about objects this file creates and are
    // rightly exceptions.
    const from = mig.indexOf("SELECT count(*) INTO _uncapped");
    expect(from, "the uncapped-zone measurement is gone").toBeGreaterThan(-1);
    const measured = mig.slice(from);
    expect(measured).toMatch(/RAISE WARNING/);
    expect(measured).not.toMatch(/RAISE EXCEPTION/);
  });
});
