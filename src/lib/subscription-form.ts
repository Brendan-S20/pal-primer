// Pure mapping between a subscription record and the client-detail edit form's
// field values (QA finding #8: the form showed hardcoded defaults — weekly,
// $25, 1 dog, no property/zone — instead of the existing subscription's real
// values, a silent data-loss risk on save). Kept pure so it can be unit-tested
// without a browser.

export type SubscriptionRecord = {
  id: string;
  frequency: string;
  price_cents: number;
  dog_count: number | null;
  unit_count: number | null;
  zone_id: string | null;
  property_id: string | null;
  billing_cadence: string | null;
  preferred_weekdays: number[] | null;
  started_on?: string | null;
  ends_on?: string | null;
  interval_weeks?: number | null;
  interval_days?: number | null;
};

export type SubscriptionFormValues = {
  propertyId: string;
  frequency: string;
  priceDollars: string;
  dogCount: string;
  unitCount: string;
  zoneId: string;
  billingCadence: "postpaid" | "prepaid";
  preferredWeekdays: number[];
  /** ISO date (YYYY-MM-DD). For one_time this is the visit date. */
  startedOn: string;
  /** ISO date or "" for no end date. Visits stop generating after it. */
  endsOn: string;
  /** Every N weeks (weekly frequency only); "" = every week. */
  intervalWeeks: string;
  /** Every X days (every_n_days frequency only). */
  intervalDays: string;
};

// The five scheduling choices the UI offers (spec): calendar-monthly and
// every-4-weeks are different things, so both exist side by side.
export type ScheduleChoice =
  | "weekly"
  | "every_n_weeks"
  | "twice_weekly"
  | "monthly"
  | "every_x_days"
  | "one_time";

/** Map a stored record to the UI scheduling choice. */
export function scheduleChoiceFromRecord(s: {
  frequency: string;
  interval_weeks?: number | null;
}): ScheduleChoice {
  if (s.frequency === "biweekly") return "every_n_weeks";
  if (s.frequency === "weekly" && (s.interval_weeks ?? 1) > 1) return "every_n_weeks";
  if (s.frequency === "every_n_days") return "every_x_days";
  if (s.frequency === "weekly") return "weekly";
  if (s.frequency === "twice_weekly") return "twice_weekly";
  if (s.frequency === "monthly") return "monthly";
  return "one_time";
}

/** Map a UI choice (+ intervals) back to frequency + interval columns. */
export function scheduleChoiceToFields(
  choice: ScheduleChoice,
  opts: { intervalWeeks?: number; intervalDays?: number },
): { frequency: string; intervalWeeks?: number; intervalDays?: number } {
  switch (choice) {
    case "weekly":
      return { frequency: "weekly" };
    case "every_n_weeks": {
      const n = Math.max(2, opts.intervalWeeks ?? 2);
      // N=2 keeps the legacy biweekly value so existing reporting stays put.
      return n === 2 ? { frequency: "biweekly" } : { frequency: "weekly", intervalWeeks: n };
    }
    case "twice_weekly":
      return { frequency: "twice_weekly" };
    case "monthly":
      return { frequency: "monthly" };
    case "every_x_days":
      return { frequency: "every_n_days", intervalDays: Math.max(1, opts.intervalDays ?? 7) };
    case "one_time":
      return { frequency: "one_time" };
  }
}

/** Human label for a stored subscription's cadence. */
export function formatFrequency(s: {
  frequency: string;
  interval_weeks?: number | null;
  interval_days?: number | null;
}): string {
  switch (s.frequency) {
    case "weekly":
      return (s.interval_weeks ?? 1) > 1 ? `Every ${s.interval_weeks} weeks` : "Weekly";
    case "biweekly":
      return "Every 2 weeks";
    case "twice_weekly":
      return "Twice weekly";
    case "monthly":
      return "Monthly (calendar)";
    case "every_n_days":
      return `Every ${s.interval_days ?? "?"} days`;
    case "one_time":
      return "One time";
    default:
      return s.frequency;
  }
}

function localTodayISO(): string {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/** Hydrate the form from an existing subscription — every field mirrors the record. */
export function subscriptionToFormValues(s: SubscriptionRecord): SubscriptionFormValues {
  return {
    propertyId: s.property_id ?? "",
    frequency: s.frequency,
    priceDollars: (s.price_cents / 100).toFixed(2),
    dogCount: String(s.dog_count ?? 1),
    unitCount: String(s.unit_count ?? 1),
    zoneId: s.zone_id ?? "",
    billingCadence: s.billing_cadence === "prepaid" ? "prepaid" : "postpaid",
    preferredWeekdays: s.preferred_weekdays ?? [],
    startedOn: s.started_on ?? localTodayISO(),
    endsOn: s.ends_on ?? "",
    intervalWeeks: s.interval_weeks && s.interval_weeks > 1 ? String(s.interval_weeks) : "",
    intervalDays: s.interval_days ? String(s.interval_days) : "",
  };
}

/**
 * Blank "add new subscription" defaults. Auto-selects the property when the
 * client has exactly one (and that property's zone), so a new subscription
 * isn't silently created with no property attached.
 */
export function blankSubscriptionFormValues(opts: {
  properties: Array<{ id: string; zone_id?: string | null }>;
}): SubscriptionFormValues {
  const onlyProperty = opts.properties.length === 1 ? opts.properties[0] : null;
  return {
    propertyId: onlyProperty?.id ?? "",
    frequency: "weekly",
    priceDollars: "",
    dogCount: "1",
    unitCount: "1",
    zoneId: onlyProperty?.zone_id ?? "",
    billingCadence: "postpaid",
    preferredWeekdays: [],
    startedOn: localTodayISO(),
    endsOn: "",
    intervalWeeks: "",
    intervalDays: "",
  };
}
