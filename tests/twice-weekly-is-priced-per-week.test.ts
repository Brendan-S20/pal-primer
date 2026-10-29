// Twice weekly billed 3.6x the weekly plan (#572, F-07).
//
// organizations.frequency_multipliers is {weekly 1, biweekly 1.7,
// twice_weekly 1.8, monthly 3.2}, and every price was "per visit x the
// cadence's number". For a cadence of one visit per cycle that is right. Twice
// weekly is two visits a week, so 1.8 per visit was 3.6 weekly visits a week:
// four dogs at $35.00 a week weekly became $63.00 a visit, $126.00 a week.
//
// The owner's decision (D1): 1.8 is the WEEKLY TOTAL. This file holds that on
// every office path that prices a visit, holds biweekly and monthly where they
// were, and holds the owner's ability to see and change the numbers. The
// public signup page's half is tests/sql/twice-weekly-is-priced-per-week.proof.sql.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_FREQUENCY_MULTIPLIERS,
  MULTIPLIER_FREQUENCIES,
  cycleMultiplier,
  perVisitMultiplier,
} from "@/lib/frequency-multipliers";
import { standardChoice, zoneChoice, type QuotePricingZone } from "@/lib/quote-pricing";
import { computePricingDrift, type DriftSubscription } from "@/lib/pricing-drift";
import { LINE_SEEDS } from "@/lib/service-lines";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const DEFAULTS = { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 };

// The issue's example: four dogs, $35.00 a visit weekly.
const ZONE: QuotePricingZone = {
  id: "z1",
  name: "Central",
  zip_codes: ["48009"],
  base_price_cents: 2000,
  per_dog_addl_cents: 500,
  pricing_mode: "flat",
} as QuotePricingZone;
const STANDARD = { basePriceCents: 2000, perDogAddlCents: 500, frequencyMultipliers: DEFAULTS };

const zoneVisit = (frequency: string) =>
  zoneChoice(ZONE, { dogCount: 4, frequency, accountType: "residential" }, STANDARD)!.priceCents;

describe("what the stored numbers mean", () => {
  it("are what one cycle costs, so twice weekly's visit is half its number", () => {
    expect(perVisitMultiplier(DEFAULTS, "weekly")).toBe(1);
    expect(perVisitMultiplier(DEFAULTS, "twice_weekly")).toBe(0.9);
    expect(cycleMultiplier(DEFAULTS, "twice_weekly")).toBe(1.8);
  });

  it("leave biweekly and monthly exactly where they were", () => {
    expect(perVisitMultiplier(DEFAULTS, "biweekly")).toBe(1.7);
    expect(perVisitMultiplier(DEFAULTS, "monthly")).toBe(3.2);
  });

  it("price a cadence the org has no number for like a weekly visit, never halved", () => {
    expect(perVisitMultiplier({ weekly: 1 }, "twice_weekly")).toBe(1);
    expect(perVisitMultiplier({}, "every_n_days")).toBe(1);
    expect(perVisitMultiplier(null, "twice_weekly")).toBe(1);
    expect(perVisitMultiplier({ twice_weekly: 0 }, "twice_weekly")).toBe(1);
  });

  it("match the column default and the pet-waste seed", () => {
    expect(DEFAULT_FREQUENCY_MULTIPLIERS).toEqual(DEFAULTS);
    expect({ ...LINE_SEEDS.pet_waste.frequencyMultipliers }).toEqual(DEFAULTS);
    expect(
      read("supabase/migrations/20260701215820_4512337b-2f80-4abb-87fa-423f545cd1c3.sql"),
    ).toContain(`'{"weekly":1.0,"biweekly":1.7,"twice_weekly":1.8,"monthly":3.2}'`);
  });
});

describe("an office quote", () => {
  it("prices four dogs weekly at $35.00 a visit", () => {
    expect(zoneVisit("weekly")).toBe(3500);
  });

  it("prices twice weekly at 1.8x the weekly plan for the week, not 3.6x", () => {
    const weekly = zoneVisit("weekly");
    const twice = zoneVisit("twice_weekly");
    expect(twice).toBe(3150);
    expect(2 * twice).toBe(Math.round(1.8 * weekly));
    expect(2 * twice).toBeLessThanOrEqual(2 * weekly);
    // The fault, for the record: $63.00 a visit, $126.00 a week.
    expect(2 * twice).not.toBe(12600);
  });

  it("does the same from standard pricing, when no zone applies", () => {
    const s = (frequency: string) =>
      standardChoice({ dogCount: 4, frequency }, STANDARD)!.priceCents;
    expect(s("weekly")).toBe(3500);
    expect(s("twice_weekly")).toBe(3150);
    expect(s("biweekly")).toBe(5950);
    expect(s("monthly")).toBe(11200);
  });

  it("keeps biweekly and monthly where they were", () => {
    expect(zoneVisit("biweekly")).toBe(5950);
    expect(zoneVisit("monthly")).toBe(11200);
  });

  it("says what the twice-weekly number is in the breakdown", () => {
    const c = zoneChoice(ZONE, { dogCount: 1, frequency: "twice_weekly" }, STANDARD)!;
    expect(c.breakdown).toBe(
      "$20.00 base, x0.9 for twice-weekly visits (1.8x a weekly visit, per week)",
    );
    const b = zoneChoice(ZONE, { dogCount: 1, frequency: "biweekly" }, STANDARD)!;
    expect(b.breakdown).toBe("$20.00 base, x1.7 for every-2-weeks visits");
  });

  it("follows an owner's own number", () => {
    const own = { ...STANDARD, frequencyMultipliers: { ...DEFAULTS, twice_weekly: 1.9 } };
    expect(zoneChoice(ZONE, { dogCount: 4, frequency: "twice_weekly" }, own)!.priceCents).toBe(
      3325,
    );
  });

  it("also holds for an HOA priced by units", () => {
    const hoa = { ...ZONE, commercial_base_cents: 10000 } as QuotePricingZone;
    const c = (frequency: string) =>
      zoneChoice(hoa, { accountType: "commercial", unitCount: 1, frequency }, STANDARD)!.priceCents;
    expect(c("weekly")).toBe(10000);
    expect(c("twice_weekly")).toBe(9000);
  });
});

describe("the pricing-drift report", () => {
  const sub = (over: Partial<DriftSubscription>): DriftSubscription => ({
    id: "s1",
    clientId: "c1",
    clientName: "A Client",
    frequency: "twice_weekly",
    priceCents: 3150,
    dogCount: 4,
    zone: {
      id: "z1",
      name: "Central",
      base_price_cents: 2000,
      per_dog_addl_cents: 500,
      pricing_mode: "flat",
      price_per_sqft_cents: 0,
      price_per_acre_cents: 0,
      area_min_charge_cents: 0,
      area_max_charge_cents: null,
    },
    boundaryAreaSqm: null,
    pricedAt: null,
    pricedFromZoneId: null,
    priceOverriddenAt: null,
    ...over,
  });

  it("reads a twice-weekly plan at the per-week price as on the card", () => {
    const { rows } = computePricingDrift([sub({})], DEFAULTS);
    expect(rows[0].outcome).toBe("on_rate");
    expect(rows[0].todayCents).toBe(3150);
  });

  it("shows a plan sold at the old price as above the card, for the owner to decide", () => {
    const { rows } = computePricingDrift([sub({ priceCents: 6300 })], DEFAULTS);
    expect(rows[0].outcome).toBe("over");
    expect(rows[0].diffCents).toBe(-3150);
  });
});

describe("every office path uses the per-visit factor", () => {
  // Each file that reads frequency_multipliers to price a visit. A raw
  // `multipliers[frequency]` here is how 1.8 got applied to each visit.
  const PRICING_FILES = [
    "src/lib/quote-pricing.ts",
    "src/lib/pricing-drift.ts",
    "src/lib/clients.functions.ts",
    "src/lib/properties.functions.ts",
    "src/lib/subscriptions.functions.ts",
    "src/components/client-detail/ServicesTab.tsx",
  ];

  it.each(PRICING_FILES)("%s goes through perVisitMultiplier", (file) => {
    const src = read(file);
    expect(src).toContain("perVisitMultiplier(");
    expect(src).not.toMatch(
      /Number\(\s*\(?[\w.?]*(?:frequency_multipliers|frequencyMultipliers|multipliers|mults)\b[^)]*\)?\s*\??\.?\[/,
    );
  });

  it("is the whole list: nothing else in src/ indexes the multipliers", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|tsx)$/.test(name) && !rel.endsWith("integrations/supabase/types.ts")) {
          const src = read(rel);
          if (
            /(frequency_multipliers|frequencyMultipliers|\bmults|\bmultipliers)\s*\??\.?\s*\[/.test(
              src,
            )
          )
            hits.push(rel);
        }
      }
    };
    walk("src");
    expect(hits.filter((f) => f !== "src/lib/frequency-multipliers.ts")).toEqual([]);
  });

  it("reprices a frequency change with per-visit factors", () => {
    const src = read("src/lib/subscriptions.functions.ts");
    const fn = src.slice(src.indexOf("applyFrequencyChangeRequest"));
    const body = fn.slice(0, fn.indexOf("export const", 10));
    expect(body).toMatch(/oldMult = perVisitMultiplier\(mults, before\.frequency/);
    expect(body).toMatch(/newMult = perVisitMultiplier\(mults, data\.frequency\)/);
    // weekly $35.00 moved to twice weekly lands on the quote's $31.50.
    const reprice = (old: number, from: string, to: string) =>
      Math.round((old / perVisitMultiplier(DEFAULTS, from)) * perVisitMultiplier(DEFAULTS, to));
    expect(reprice(3500, "weekly", "twice_weekly")).toBe(3150);
    expect(reprice(3150, "twice_weekly", "monthly")).toBe(11200);
  });
});

describe("the public signup page", () => {
  const FILE = "supabase/migrations/20261029120000_twice-weekly-is-priced-per-week.sql";
  const sql = read(FILE);

  it("splices public_quote's newest body rather than restating an old one", () => {
    expect(sql).toContain(
      "pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure)",
    );
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
    expect(sql).toMatch(/the splice anchor moved/);
  });

  it("halves twice weekly only when the org has a number for it", () => {
    expect(sql).toContain(
      "IF _frequency = ''twice_weekly'' AND (_org.frequency_multipliers ? _frequency) THEN",
    );
    expect(sql).toContain("_mult := _mult / 2;");
  });

  it("anchors on a line the newest public_quote still has, exactly once", () => {
    const anchor = "_mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);";
    const body = read("supabase/migrations/20261024100900_keep-coming-soon-off-public-booking.sql");
    expect(body.split(anchor).length - 1).toBe(1);
    // No later file touched that line.
    for (const f of [
      "supabase/migrations/20261025200000_one-switch-decides-what-is-bookable.sql",
      "supabase/migrations/20261027200000_a-stranger-is-not-sold-a-groom.sql",
      "supabase/migrations/20261028120000_the-booking-link-sells-every-live-line.sql",
    ]) {
      expect(read(f)).not.toContain("frequency_multipliers");
    }
  });

  it("splits by visits per cycle the same way in SQL and TypeScript", () => {
    // SQL halves twice_weekly and nothing else; TypeScript's table agrees.
    for (const f of MULTIPLIER_FREQUENCIES) {
      expect(perVisitMultiplier(DEFAULTS, f) * (f === "twice_weekly" ? 2 : 1)).toBeCloseTo(
        DEFAULTS[f],
      );
    }
  });
});

describe("the owner can see and change the numbers", () => {
  it("has a server function that writes all four, within bounds, as a price list", () => {
    const src = read("src/lib/subscriptions.functions.ts");
    const fn = src.slice(src.indexOf("export const updateFrequencyMultipliers"));
    const body = fn.slice(0, fn.indexOf("// ── Seasonal deep-clean"));
    expect(body).toMatch(/weekly: m, twice_weekly: m, biweekly: m, monthly: m/);
    expect(body).toMatch(/MIN_MULTIPLIER\)\.max\(MAX_MULTIPLIER\)/);
    expect(body).toMatch(/loadOrgForCaller/);
    expect(body).toMatch(
      /updateOwnOrg\(context\.supabase, orgId, \{ frequency_multipliers: stored \}\)/,
    );
  });

  it("draws the editor on Business defaults for whoever manages pricing at a pet-waste business", () => {
    const page = read("src/routes/_authenticated/settings.business.tsx");
    expect(page).toMatch(
      /import \{ FrequencyPricingCard \} from "@\/components\/FrequencyPricingCard"/,
    );
    expect(page).toMatch(/\{petWaste && <FrequencyPricingCard \/>\}/);
    const card = read("src/components/FrequencyPricingCard.tsx");
    for (const f of MULTIPLIER_FREQUENCIES) expect(card).toContain(`${f}: {`);
    expect(card).toContain("updateFrequencyMultipliers");
  });

  it("writes its copy without an em dash", () => {
    const card = read("src/components/FrequencyPricingCard.tsx");
    const jsx = card.slice(card.indexOf("const ROWS"));
    expect(jsx).not.toContain("—");
  });
});
