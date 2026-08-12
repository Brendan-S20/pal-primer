import { describe, expect, it } from "vitest";
import {
  DEFAULT_EST_TIME_CONFIG,
  cadenceGapDays,
  computeEstimatedMinutes,
  countPropertyHazards,
  resolveEstTimeConfig,
} from "../src/lib/estimated-time";
import { deriveYardSize } from "../src/lib/yard-size";

describe("computeEstimatedMinutes", () => {
  it("returns null with nothing to estimate from", () => {
    expect(computeEstimatedMinutes({})).toBeNull();
    expect(computeEstimatedMinutes({ boundaryAreaSqm: 0, dogCount: 0 })).toBeNull();
  });

  it("computes a weekly baseline: base + area + extra dogs", () => {
    // 4000 sqft yard (371.6 sqm), 2 dogs: 5 base + 2 area + 2 extra dog = 9
    const min = computeEstimatedMinutes({
      boundaryAreaSqm: 4000 / 10.7639,
      dogCount: 2,
      frequency: "weekly",
    });
    expect(min).toBe(9);
  });

  it("adds hazard minutes", () => {
    const base = computeEstimatedMinutes({ dogCount: 1, frequency: "weekly" })!;
    const hazards = computeEstimatedMinutes({ dogCount: 1, frequency: "weekly", hazardCount: 3 })!;
    expect(hazards - base).toBe(3 * DEFAULT_EST_TIME_CONFIG.perHazardMin);
  });

  it("scales with cadence gap: biweekly and monthly factors", () => {
    const weekly = computeEstimatedMinutes({ dogCount: 2, frequency: "weekly" })!;
    const biweekly = computeEstimatedMinutes({ dogCount: 2, frequency: "biweekly" })!;
    const monthly = computeEstimatedMinutes({ dogCount: 2, frequency: "monthly" })!;
    expect(biweekly).toBe(Math.ceil(7 * 1.25));
    expect(monthly).toBe(Math.ceil(7 * 1.5));
    expect(weekly).toBeLessThan(biweekly);
    expect(biweekly).toBeLessThan(monthly);
  });

  it("treats every-3-weeks like a long gap and every-3-days like weekly", () => {
    expect(cadenceGapDays({ frequency: "weekly", intervalWeeks: 3 })).toBe(21);
    expect(cadenceGapDays({ frequency: "every_n_days", intervalDays: 3 })).toBe(3);
    const everyThreeWeeks = computeEstimatedMinutes({
      dogCount: 1,
      frequency: "weekly",
      intervalWeeks: 3,
    })!;
    expect(everyThreeWeeks).toBe(Math.ceil(5 * 1.5));
  });

  it("doubles for one-time jobs and initial cleanups", () => {
    const weekly = computeEstimatedMinutes({ dogCount: 1, frequency: "weekly" })!;
    const oneTime = computeEstimatedMinutes({ dogCount: 1, frequency: "one_time" })!;
    const initial = computeEstimatedMinutes({
      dogCount: 1,
      frequency: "weekly",
      initialCleanup: true,
    })!;
    expect(oneTime).toBe(weekly * DEFAULT_EST_TIME_CONFIG.initialCleanupFactor);
    expect(initial).toBe(weekly * DEFAULT_EST_TIME_CONFIG.initialCleanupFactor);
  });

  it("honors org config overrides and ignores junk", () => {
    const cfg = resolveEstTimeConfig({ baseMin: 10, perExtraDogMin: "nope", sqftPerMinute: -5 });
    expect(cfg.baseMin).toBe(10);
    expect(cfg.perExtraDogMin).toBe(DEFAULT_EST_TIME_CONFIG.perExtraDogMin);
    expect(cfg.sqftPerMinute).toBe(DEFAULT_EST_TIME_CONFIG.sqftPerMinute);
    expect(computeEstimatedMinutes({ dogCount: 1, frequency: "weekly" }, cfg)).toBe(10);
  });
});

describe("countPropertyHazards", () => {
  it("counts only flagged hazards", () => {
    expect(countPropertyHazards({})).toBe(0);
    expect(
      countPropertyHazards({ aggressive_dog: true, bees_wasps: true, escape_risk: false }),
    ).toBe(2);
  });
});

describe("deriveYardSize", () => {
  it("matches the DB trigger thresholds", () => {
    expect(deriveYardSize(null)).toBeNull();
    expect(deriveYardSize(0)).toBeNull();
    expect(deriveYardSize(100)).toBe("small"); // ~1,076 sqft
    expect(deriveYardSize(600)).toBe("medium"); // ~6,458 sqft
    expect(deriveYardSize(1000)).toBe("large"); // ~10,764 sqft
    expect(deriveYardSize(2100)).toBe("xlarge"); // ~22,604 sqft (over half acre)
  });
});
