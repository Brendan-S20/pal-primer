// Pure mapping between a subscription record and the client-detail edit form's
// field values (QA finding #8: the form showed hardcoded defaults — weekly,
// $25, 1 dog, no property/zone — instead of the existing subscription's real
// values, a silent data-loss risk on save). Kept pure so it can be unit-tested
// without a browser.

import { formatWeekdaySet } from "@/lib/weekday-set";

export type WalkWindow = { earliestTime: string; latestTime: string };

/** Sibling plans, one per arrival window: walk times (#410) and a sitter's
 *  drop-in times (#411). `noun` names the visit in the message. */
export function arrivalWindowsProblem(
  windows: readonly WalkWindow[],
  max: number,
  noun: string,
): string | null {
  if (windows.length < 1 || windows.length > max) return `Choose between 1 and ${max} ${noun} times.`;
  const seen = new Set<string>();
  for (const window of windows) {
    if (
      ![window.earliestTime, window.latestTime].every((time) =>
        /^([01]\d|2[0-3]):[0-5]\d$/.test(time),
      )
    )
      return `Set an earliest and latest arrival for each ${noun} time.`;
    if (window.earliestTime >= window.latestTime)
      return `Each ${noun}'s earliest arrival must be before its latest arrival.`;
    const key = `${window.earliestTime}/${window.latestTime}`;
    if (seen.has(key)) return `Each ${noun} time must have a different arrival window.`;
    seen.add(key);
  }
  return null;
}

/** Each extra walk time becomes a separate plan with its own arrival window. */
export function walkWindowsProblem(windows: readonly WalkWindow[]): string | null {
  return arrivalWindowsProblem(windows, 6, "walk");
}

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
  /** The days a set-days plan runs on (0 = Sunday); null for every other. */
  weekdays?: number[] | null;
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
  /** The days a "Set days each week" plan runs on (0 = Sunday). */
  weekdays: number[];
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

// The scheduling choices the UI offers (spec): calendar-monthly and
// every-4-weeks are different things, so both exist side by side.
// "set_days" is a weekday set (subscriptions.weekdays, migration
// 20261010010000): stored as frequency weekly with the days beside it.
export type ScheduleChoice =
  | "weekly"
  | "every_n_weeks"
  | "twice_weekly"
  | "set_days"
  | "monthly"
  | "every_x_days"
  | "one_time";

/** Map a stored record to the UI scheduling choice. */
export function scheduleChoiceFromRecord(s: {
  frequency: string;
  interval_weeks?: number | null;
  weekdays?: number[] | null;
}): ScheduleChoice {
  if (s.weekdays?.length) return "set_days";
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
    case "set_days":
      // The days ride beside it, in subscriptions.weekdays.
      return { frequency: "weekly" };
    case "monthly":
      return { frequency: "monthly" };
    case "every_x_days":
      return { frequency: "every_n_days", intervalDays: Math.max(1, opts.intervalDays ?? 7) };
    case "one_time":
      return { frequency: "one_time" };
  }
}

/** Human label for a stored subscription's cadence. A set-days plan reads as
 *  its days ("Mon–Fri", "Mon, Wed, Fri") in `locale`, the formatters' locale
 *  (lib/i18n `intlLocaleFor`). */
export function formatFrequency(
  s: {
    frequency: string;
    interval_weeks?: number | null;
    interval_days?: number | null;
    weekdays?: number[] | null;
  },
  locale?: string,
): string {
  if (s.weekdays?.length) return formatWeekdaySet(s.weekdays, locale);
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

/** The SERVICE column of a client's visit list: what was booked ("Bath &
 *  brush", "Weekly cleanup"), not only whether it repeats. A groom used to
 *  read "One time service" there with its real name only in the sub-line
 *  (R2-31, groom-r2-08). Falls back to the cadence when the plan has no
 *  catalog service. */
export function visitServiceLabel(
  s: { frequency?: string | null; services?: { name?: string | null } | null } | null | undefined,
): string {
  if (!s) return "-";
  const name = s.services?.name?.trim();
  if (name) return name;
  return `${s.frequency === "one_time" ? "One time" : "Recurring"} service`;
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

// ── ending a service (#676) ────────────────────────────────────────────────
//
// "End service…" used to be offered only once a service had started. A
// one_time visit (often prepaid) has started_on = the visit date, so until
// that day the card offered Delete — which the server refuses as soon as
// the service has history (a canceled visit, a prepaid invoice) with "End
// it instead of deleting", pointing at a control that was not there. And
// the server refused an end date before started_on, so even a hand-built
// request could not end it.
//
// Now every service that has not ended can be ended, and a service that has
// not started yet can be ended before its start date: it simply never runs.

/** Whether the card offers "End service…". Any service that is not over. */
export function canEndService(
  s: { status?: string | null; ends_on?: string | null },
  today: string,
): boolean {
  return !isServiceEnded(s, today);
}

/**
 * What endSubscription writes, or why it refuses. `today` is an ISO date.
 * - A started service cannot end before it started (that would rewrite
 *   history the visits already describe).
 * - A service that has not started yet may end on any day from today: no
 *   visit of it has happened, so nothing is rewritten.
 * - The status is canceled at once when the end is today or earlier, or
 *   when it falls before the start (the service will never run, so nothing
 *   is left for it to bill). Otherwise it stays active until the end date.
 */
export function endServiceDecision(input: {
  startedOn: string | null;
  effectiveDate: string;
  today: string;
}): { ok: true; status: "canceled" | "active" } | { ok: false; error: string } {
  const { startedOn, effectiveDate, today } = input;
  const hasStarted = !!startedOn && startedOn <= today;
  if (startedOn && effectiveDate < startedOn) {
    if (hasStarted) return { ok: false, error: "End date can't be before the service started" };
    if (effectiveDate < today) return { ok: false, error: "End date can't be in the past" };
    return { ok: true, status: "canceled" };
  }
  return { ok: true, status: effectiveDate <= today ? "canceled" : "active" };
}

/**
 * The words on the End service drawer. Says what happens to visits, to
 * billing, and — for a prepaid service — to money already paid, because
 * "end" next to a payment reads like "refund" to an owner and it is not.
 */
export function endServiceCopy(s: {
  billing_cadence?: string | null;
  frequency?: string | null;
}): { description: string; money: string } {
  const visits =
    s.frequency === "one_time"
      ? "The visit is removed if it hasn't happened by the end date"
      : "Scheduled visits after the end date are removed";
  const description = `${visits}, and the service stops billing. Its history stays on the client. Nothing is deleted.`;
  const money =
    s.billing_cadence === "prepaid"
      ? "Money already paid is not refunded automatically. It stays on the client's account; to give it back, refund the payment from its invoice on the Billing tab."
      : "Visits already completed are still billed as usual. Nothing is refunded automatically.";
  return { description, money };
}

/** Hydrate the form from an existing subscription — every field mirrors the record.
 *
 * `today` is the ORG's today (useOrgToday), not manufactured here: this file
 * has no hook access and the one thing every private copy of "what day is
 * it" got wrong was answering with the device's or the server's clock. */
export function subscriptionToFormValues(s: SubscriptionRecord, today: string): SubscriptionFormValues {
  return {
    propertyId: s.property_id ?? "",
    frequency: s.frequency,
    priceDollars: (s.price_cents / 100).toFixed(2),
    dogCount: String(s.dog_count ?? 1),
    unitCount: String(s.unit_count ?? 1),
    zoneId: s.zone_id ?? "",
    billingCadence: s.billing_cadence === "prepaid" ? "prepaid" : "postpaid",
    preferredWeekdays: s.preferred_weekdays ?? [],
    weekdays: s.weekdays ?? [],
    startedOn: s.started_on ?? today,
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
  /** The ORG's today (useOrgToday); see subscriptionToFormValues. */
  today: string;
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
    weekdays: [],
    startedOn: opts.today,
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

// ── the query-side twin of isServiceEnded ──────────────────────────────────
//
// This rule has now been got wrong in four separate places: listClients,
// admin_generate_seasonal_deepcleans (in SQL, where it billed), the property
// service-time estimate, and the client portal's "your plan". Every one of
// them asked `status = 'active'` and stopped there.
//
// The schema does not record ending as a status. endSubscription writes
// `ends_on` and LEAVES status 'active' — so "status is active" answers a
// different question from "this service is still running", and the difference
// only shows up once a tenant ends something. Booking a one-off visit creates
// that state deliberately (ends_on = the visit date), which is what finally
// made all four visible.
//
// A PostgREST `.or()` string rather than a predicate, because these are
// database queries and filtering after the fact would still pick the wrong
// single row under `.limit(1)`.
export function liveServiceOrFilter(todayISO: string): string {
  return `ends_on.is.null,ends_on.gte.${todayISO}`;
}
