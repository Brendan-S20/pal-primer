// D7, onboarding audit 2026-11-09: setup's pricing step asked for an area, a
// radius, a price per visit and an extra-dog price, and nothing else. The two
// prices a scooper quotes on every first call were somewhere else:
//
//   * the first cleanup, on Zones, which afterwards read
//     "Off. New clients are not charged for a first cleanup."
//   * what every-2-weeks costs against weekly, on Settings > Business
//     defaults ("Price by schedule"), never shown in setup at all.
//
// So an owner who finished setup quoted their first biweekly client at the
// column default and charged no first cleanup, without ever having been asked.
//
// Setup step 2 now asks both, for a pet-waste business, and writes them where
// Zones and Business defaults read them: zones.initial_cleanup_cents plus
// organizations.first_cleanup_pricing (through setFirstCleanupPricing), and
// organizations.frequency_multipliers (through updateFrequencyMultipliers).
// No parallel field: the same server functions those two screens save with.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  firstCleanupPricingFromSetup,
  setupFirstCleanupCents,
  setupMultipliers,
} from "@/lib/setup-pricing";
import { FIRST_CLEANUP_OFF, type FirstCleanupPricing } from "@/lib/first-cleanup";
import { DEFAULT_FREQUENCY_MULTIPLIERS } from "@/lib/frequency-multipliers";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const tiered: FirstCleanupPricing = {
  mode: "by_last_cleaned",
  tiers: [{ id: "month", label: "Within a month", priceCents: 5000 }],
  perExtraDogCents: 0,
};

describe("the first cleanup, from setup", () => {
  it("Off is an explicit answer: the zone carries $0 and the mode is off", () => {
    expect(setupFirstCleanupCents("off", "")).toBe(0);
    expect(setupFirstCleanupCents("off", "75")).toBe(0);
    expect(firstCleanupPricingFromSetup(FIRST_CLEANUP_OFF, "off")).toBeNull();
    expect(firstCleanupPricingFromSetup({ ...FIRST_CLEANUP_OFF, mode: "flat" }, "off")).toEqual({
      ...FIRST_CLEANUP_OFF,
      mode: "off",
    });
  });

  it("a flat price goes on the zone and turns flat mode on", () => {
    expect(setupFirstCleanupCents("flat", "75")).toBe(7500);
    expect(setupFirstCleanupCents("flat", "49.99")).toBe(4999);
    expect(firstCleanupPricingFromSetup(FIRST_CLEANUP_OFF, "flat")).toEqual({
      ...FIRST_CLEANUP_OFF,
      mode: "flat",
    });
  });

  it("a flat answer with no price is refused rather than saved as $0", () => {
    expect(setupFirstCleanupCents("flat", "")).toBeNull();
    expect(setupFirstCleanupCents("flat", "0")).toBeNull();
    expect(setupFirstCleanupCents("flat", "abc")).toBeNull();
  });

  it("never replaces a tiered price list somebody already built on Zones", () => {
    expect(firstCleanupPricingFromSetup(tiered, "off")).toBeNull();
    expect(firstCleanupPricingFromSetup(tiered, "flat")).toBeNull();
  });

  it("keeps the extra-dog amount and the tiers it is not changing", () => {
    const kept = { ...tiered, mode: "flat" as const, perExtraDogCents: 1500 };
    expect(firstCleanupPricingFromSetup(kept, "off")).toEqual({ ...kept, mode: "off" });
  });
});

describe("the schedule multipliers, from setup", () => {
  it("starts from what is stored, else the column default, for all four", () => {
    expect(setupMultipliers({}, {})).toEqual({ ...DEFAULT_FREQUENCY_MULTIPLIERS });
    expect(setupMultipliers({ biweekly: 1.5 }, {})).toEqual({
      ...DEFAULT_FREQUENCY_MULTIPLIERS,
      biweekly: 1.5,
    });
  });

  it("writes what the owner typed for weekly and every 2 weeks", () => {
    expect(setupMultipliers({}, { weekly: "1", biweekly: "1.6" })).toEqual({
      ...DEFAULT_FREQUENCY_MULTIPLIERS,
      weekly: 1,
      biweekly: 1.6,
    });
  });

  it("refuses a number outside the range Business defaults allows", () => {
    expect(setupMultipliers({}, { biweekly: "16" })).toBeNull();
    expect(setupMultipliers({}, { biweekly: "" })).toBeNull();
    expect(setupMultipliers({}, { weekly: "0" })).toBeNull();
  });
});

describe("setup step 2 writes the same fields Zones and Business defaults read", () => {
  const setup = read("src/routes/_authenticated/setup.tsx");

  it("asks for the first cleanup, with Off as an explicit choice", () => {
    expect(setup).toMatch(/id="setup-first-cleanup-off"/);
    expect(setup).toMatch(/id="setup-first-cleanup-flat"/);
    expect(setup).toMatch(/id="setup-zone-first-cleanup"/);
  });

  it("asks for at least weekly and every-2-weeks", () => {
    expect(setup).toMatch(/setup-mult-\$\{f\}|id="setup-mult-weekly"/);
    expect(setup).toMatch(/SETUP_MULTIPLIER_FREQUENCIES/);
    const lib = read("src/lib/setup-pricing.ts");
    expect(lib).toMatch(/SETUP_MULTIPLIER_FREQUENCIES[^=]*=\s*\[\s*"weekly",\s*"biweekly"/);
  });

  it("saves through the Zones and Business defaults server functions", () => {
    expect(setup).toMatch(/useServerFn\(setFirstCleanupPricing\)/);
    expect(setup).toMatch(/useServerFn\(updateFrequencyMultipliers\)/);
    expect(setup).toMatch(/initialCleanupCents:/);
    expect(read("src/components/FirstCleanupPricingCard.tsx")).toMatch(/setFirstCleanupPricing/);
    expect(read("src/components/FrequencyPricingCard.tsx")).toMatch(/updateFrequencyMultipliers/);
  });

  it("invents no parallel column", () => {
    const migrations = readdirSync(join(root, "supabase/migrations"));
    expect(migrations.filter((m) => /setup.*(price|pricing|cleanup|multiplier)/i.test(m))).toEqual(
      [],
    );
  });
});
