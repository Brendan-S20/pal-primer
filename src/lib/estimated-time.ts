// Auto-calculated estimated service time (client detail refactor).
//
// The estimate is derived, never hand-entered: property boundary area, dog
// count, cadence, hazards, and initial-cleanup status feed a small formula
// whose constants are org-tunable (organizations.est_time_config overrides
// the defaults below). A manual value on properties.service_duration_min is
// treated as an authorized override and must carry a reason.

export interface EstTimeConfig {
  /** Minutes every visit starts with. */
  baseMin: number;
  /** One extra minute per this many square feet of boundary area. */
  sqftPerMinute: number;
  /** Extra minutes per dog after the first. */
  perExtraDogMin: number;
  /** Extra minutes per flagged hazard. */
  perHazardMin: number;
  /** Multiplier when visits are two weeks apart. */
  biweeklyFactor: number;
  /** Multiplier when visits are a month (or 3+ weeks) apart. */
  monthlyFactor: number;
  /** Multiplier for one-time jobs / initial cleanups. */
  initialCleanupFactor: number;
}

export const DEFAULT_EST_TIME_CONFIG: EstTimeConfig = {
  baseMin: 5,
  sqftPerMinute: 2000,
  perExtraDogMin: 2,
  perHazardMin: 2,
  biweeklyFactor: 1.25,
  monthlyFactor: 1.5,
  initialCleanupFactor: 2,
};

export function resolveEstTimeConfig(raw: unknown): EstTimeConfig {
  const cfg = { ...DEFAULT_EST_TIME_CONFIG };
  if (raw && typeof raw === "object") {
    for (const key of Object.keys(cfg) as (keyof EstTimeConfig)[]) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) cfg[key] = v;
    }
  }
  return cfg;
}

export const SQFT_PER_SQM = 10.7639;

export interface EstTimeInput {
  boundaryAreaSqm?: number | null;
  dogCount?: number | null;
  frequency?: string | null;
  intervalWeeks?: number | null;
  intervalDays?: number | null;
  hazardCount?: number | null;
  /** One-time jobs and first visits accumulate more waste. */
  initialCleanup?: boolean;
}

/** Days between visits for a given cadence (used to scale accumulation). */
export function cadenceGapDays(input: Pick<EstTimeInput, "frequency" | "intervalWeeks" | "intervalDays">): number {
  switch (input.frequency) {
    case "twice_weekly":
      return 3;
    case "weekly":
      return 7 * Math.max(1, input.intervalWeeks ?? 1);
    case "biweekly":
      return 14;
    case "every_n_days":
      return Math.max(1, input.intervalDays ?? 7);
    case "monthly":
      return 30;
    default:
      return 7;
  }
}

/**
 * Estimated on-site minutes for one visit. Returns a whole number of
 * minutes (rounded up), or null when there is nothing to estimate from
 * (no area and no dogs).
 */
export function computeEstimatedMinutes(input: EstTimeInput, config?: EstTimeConfig): number | null {
  const cfg = config ?? DEFAULT_EST_TIME_CONFIG;
  const areaSqft = input.boundaryAreaSqm ? input.boundaryAreaSqm * SQFT_PER_SQM : 0;
  const dogs = Math.max(0, input.dogCount ?? 0);
  if (areaSqft <= 0 && dogs <= 0) return null;

  let minutes = cfg.baseMin;
  if (areaSqft > 0 && cfg.sqftPerMinute > 0) minutes += areaSqft / cfg.sqftPerMinute;
  if (dogs > 1) minutes += (dogs - 1) * cfg.perExtraDogMin;
  minutes += Math.max(0, input.hazardCount ?? 0) * cfg.perHazardMin;

  const gap = cadenceGapDays(input);
  if (gap >= 21) minutes *= cfg.monthlyFactor;
  else if (gap >= 10) minutes *= cfg.biweeklyFactor;

  if (input.initialCleanup || input.frequency === "one_time") minutes *= cfg.initialCleanupFactor;

  return Math.max(1, Math.ceil(minutes));
}

/** Count the flagged hazard booleans on a property row. */
export function countPropertyHazards(p: {
  invisible_fence?: boolean | null;
  escape_risk?: boolean | null;
  dog_in_yard_during_service?: boolean | null;
  aggressive_dog?: boolean | null;
  bees_wasps?: boolean | null;
  sharp_objects?: boolean | null;
  slippery_surfaces?: boolean | null;
  do_not_enter_if_dog_out?: boolean | null;
}): number {
  return [
    p.invisible_fence,
    p.escape_risk,
    p.dog_in_yard_during_service,
    p.aggressive_dog,
    p.bees_wasps,
    p.sharp_objects,
    p.slippery_surfaces,
    p.do_not_enter_if_dog_out,
  ].filter(Boolean).length;
}
