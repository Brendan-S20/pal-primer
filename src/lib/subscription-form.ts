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
  earliest_time?: string | null;
  latest_time?: string | null;
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
  /** Arrival window start, "HH:MM" or "" for anytime. */
  earliestTime: string;
  /** Arrival window end, "HH:MM" or "" for anytime. */
  latestTime: string;
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

/**
 * Single source of truth for "this service is over" (UX round 4: ended
 * services kept showing as active). A service is ended when its status is
 * canceled, or its end date has been reached even if the status flip hasn't
 * happened yet (ended from an older build, or ends_on arrived while the row
 * still said active). `today` is an ISO date (YYYY-MM-DD); pass it in so
 * callers share one "now" per render.
 */
export function isServiceEnded(
  s: { status?: string | null; ends_on?: string | null },
  today: string,
): boolean {
  if (s.status === "canceled") return true;
  return s.ends_on != null && s.ends_on !== "" && s.ends_on <= today;
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
    // Postgres time comes back as HH:MM:SS; the form (and input[type=time]) use HH:MM.
    earliestTime: s.earliest_time ? s.earliest_time.slice(0, 5) : "",
    latestTime: s.latest_time ? s.latest_time.slice(0, 5) : "",
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
    earliestTime: "",
    latestTime: "",
  };
}

// ── "why is there no upcoming visit, and can I do anything about it" ────────
//
// Extracted from ServicesTab so it can be tested. It was inline, and it was
// wrong in the one case that mattered: a one-time service booked for TODAY had
// no visit yet (saving a service has never generated visits — the nightly run
// does), and the banner said "Its one-time visit is in the past" while the
// generate button was explicitly withheld from one_time services. A false
// explanation and no way out, on the emergency booking.

export type ServiceScheduleState = {
  /** Sentence shown in the amber banner, or null for no banner. */
  reason: string | null;
  /** Whether to offer "Generate schedule". */
  canGenerate: boolean;
};

export function serviceScheduleState(
  s: {
    frequency: string;
    status: string;
    started_on?: string | null;
  },
  opts: {
    today: string;
    /** Earliest scheduled visit on or after today, if any. */
    nextVisit?: string | null;
    ended: boolean;
    paused: boolean;
  },
): ServiceScheduleState {
  const { today, nextVisit, ended, paused } = opts;
  if (ended || paused || s.status !== "active" || nextVisit) {
    return { reason: null, canGenerate: false };
  }

  const startsLater = !!s.started_on && s.started_on > today;
  const isOneTime = s.frequency === "one_time";
  // Its day has not gone by, so the visit is missing rather than expired.
  const oneTimeStillAhead = isOneTime && !!s.started_on && s.started_on >= today;

  const reason = startsLater
    ? `Starts ${s.started_on}; visits appear once it begins`
    : isOneTime
      ? oneTimeStillAhead
        ? `Its visit on ${s.started_on} hasn't been scheduled yet`
        : "Its one-time visit is in the past"
      : "Schedule hasn't been generated yet";

  // Generating a past-dated one-time service does nothing, so offering the
  // button there would just look broken.
  const canGenerate = !startsLater && (!isOneTime || oneTimeStillAhead);
  return { reason, canGenerate };
}
