// Importing the business, not just the address book.
//
// Until 2026-09-28 an import could bring clients, properties and dogs, and
// nothing else. A Jobber shop with 400 weekly customers came across with zero
// services, zero prices and zero balances (persona review, 2026-09-27), so
// every recurring plan had to be rebuilt by hand before a single visit could
// be scheduled. This module is the pure half of two more import kinds:
//
//   services: one recurring plan per row (frequency, price, service day)
//   balances: one opening balance per row, which becomes an open invoice
//
// and of turning Jobber's Tags into tags rather than notes. The database half
// is in imports.functions.ts; everything here is a pure function so the
// awkward inputs a real export holds can be tested without one.
//
// Since 2026-10-11 a row can also say WHICH service the plan is for (the
// service catalog, docs/other-trades-service-catalog.md, "Imports"): a
// Service column is matched to one of the business's services by name, and a
// name it has not got yet is created with the line its words suggest and no
// price. A walker's "Mon/Wed/Fri", "M-F" or "weekdays" becomes the plan's
// weekday set (subscriptions.weekdays). A pet-waste business's import, with
// or without a Service column, writes the rows it always did: importPlanRow
// below is the one place the plan row is built, and a test holds it to the
// old shape.

import { FIRST_NAME_COLUMNS, LAST_NAME_COLUMNS } from "@/lib/import-leftovers";
import { noVisit, planAnchor, statedMonthDay, type OffWhich } from "@/lib/import-plan-anchor";
import type { ServiceLine } from "@/lib/service-lines";
import { orgLocalDay, orgToday } from "@/lib/org-day";

export type ImportFrequency = {
  frequency: "weekly" | "biweekly" | "twice_weekly" | "monthly" | "one_time" | "every_n_days";
  intervalWeeks?: number;
  intervalDays?: number;
};

const WEEKDAY_WORDS: Array<[RegExp, number]> = [
  [/\bsun(day)?s?\b/i, 0],
  [/\bmon(day)?s?\b/i, 1],
  [/\btue(s|sday)?s?\b/i, 2],
  [/\bwed(nesday)?s?\b/i, 3],
  [/\bthu(r|rs|rsday)?s?\b/i, 4],
  [/\bfri(day)?s?\b/i, 5],
  [/\bsat(urday)?s?\b/i, 6],
];

/** A day word at the start of a range: the three-letter stem with whatever
 *  the export spelled after it ("Mon", "Monday", "Tues", "Thurs"), or a bare
 *  letter M T W R F that is not the start of another word ("Weekly" is not
 *  Wednesday). */
const RANGE_DAY = String.raw`(?:\b(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|rs|r|s|urday)?s?\b|\b([mtwrf])(?![a-z]))`;
const RANGE_RE = new RegExp(
  `${RANGE_DAY}\\s*(?:-|\u2013|\u2014|to|thru|through)\\s*${RANGE_DAY}`,
  "i",
);
const STEM_DAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const LETTER_DAY: Record<string, number> = { m: 1, t: 2, w: 3, r: 4, f: 5 };
/** A cell that is nothing but day codes: "MWF", "M/W/F", "TTh", "MTWThF".
 *  Su, Sa, Th and Tu first so "Th" is not read as Tuesday + nothing. A lone
 *  "S" is left out: it says Saturday or Sunday and we cannot tell which. */
const COMPACT_RE = /^(?:su|sa|th|tu|m|t|w|r|f)+$/i;
const COMPACT_TOKEN = /su|sa|th|tu|m|t|w|r|f/gi;
const COMPACT_DAY: Record<string, number> = {
  su: 0,
  sa: 6,
  th: 4,
  tu: 2,
  m: 1,
  t: 2,
  w: 3,
  r: 4,
  f: 5,
};

/** Weekdays named anywhere in a cell: "Tuesday", "Tue & Fri", "Weekly on
 *  Thursdays"; and, since the catalog, the ways a walker writes a week:
 *  "Mon/Wed/Fri", "weekdays", "M-F", "Mon-Fri", "Tue to Thu", "MWF", "TTh".
 *  0 = Sunday, the numbering subscriptions.preferred_weekdays and
 *  subscriptions.weekdays use. Empty when none are named. */
export function parseWeekdays(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const [re, d] of WEEKDAY_WORDS) if (re.test(text)) out.add(d);
  // "weekdays", "every weekday", "week days": Monday to Friday.
  if (/\bweek ?days?\b/i.test(text)) for (const d of [1, 2, 3, 4, 5]) out.add(d);
  // "Mon-Fri", "M-F", "Tue thru Thu": every day from the first to the second,
  // forward through the week (so "Fri-Mon" is Fri, Sat, Sun, Mon). One dash
  // only: "Mon - Wed - Fri" is a list spelled with dashes, not a range.
  const range =
    (text.match(/-|\u2013|\u2014|\b(?:to|thru|through)\b/gi) ?? []).length === 1
      ? RANGE_RE.exec(text)
      : null;
  if (range) {
    const from = range[1] ? STEM_DAY[range[1].toLowerCase()] : LETTER_DAY[range[2].toLowerCase()];
    const to = range[3] ? STEM_DAY[range[3].toLowerCase()] : LETTER_DAY[range[4].toLowerCase()];
    for (let d = from; ; d = (d + 1) % 7) {
      out.add(d);
      if (d === to) break;
    }
  }
  // "MWF", "M/W/F", "TTh": only when the whole cell is day codes and no word
  // above was found, so "Sat" is read once and "Weekly" is not W + nothing.
  if (out.size === 0) {
    const compact = text.replace(/[\s/,&+.|-]/g, "");
    if (compact && COMPACT_RE.test(compact)) {
      for (const tok of compact.match(COMPACT_TOKEN) ?? []) out.add(COMPACT_DAY[tok.toLowerCase()]);
    }
  }
  return [...out].sort((a, b) => a - b);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  other: 2,
};

/**
 * A frequency as an export spells it, onto the plan's options. Null when the
 * text is present but not understood, so the row is refused with the text
 * quoted rather than silently becoming weekly.
 */
export function parseFrequency(text: string | null | undefined): ImportFrequency | null {
  const s = (text ?? "").toLowerCase().trim();
  if (!s) return null;
  const code = sweepGoPlanCode(s);
  if (code) return code.frequency;
  if (/one[- ]?(time|off)|single|once\b/.test(s)) return { frequency: "one_time" };
  if (/twice (a |per )?week|2x ?(a |per )?week|two times (a |per )?week|semi[- ]?weekly/.test(s)) {
    return { frequency: "twice_weekly" };
  }
  if (/bi-?weekly|fortnight/.test(s)) return { frequency: "biweekly" };
  if (/month/.test(s)) return { frequency: "monthly" };
  const everyN = s.match(/every\s+(\d+|one|two|three|four|five|six|other)\s*(week|wk|day)/);
  if (everyN) {
    const n = /^\d+$/.test(everyN[1]) ? Number(everyN[1]) : NUMBER_WORDS[everyN[1]];
    if (everyN[2].startsWith("day")) {
      return n >= 1 && n <= 90 ? { frequency: "every_n_days", intervalDays: n } : null;
    }
    if (n === 1) return { frequency: "weekly" };
    if (n === 2) return { frequency: "biweekly" };
    return n >= 1 && n <= 26 ? { frequency: "weekly", intervalWeeks: n } : null;
  }
  if (/week|wkly/.test(s)) return { frequency: "weekly" };
  // A bare weekday ("Tuesday") in a frequency column means weekly on it.
  if (parseWeekdays(s).length) return { frequency: "weekly" };
  return null;
}

/** Sweep&Go names a plan by dogs and visits ("Regular Plan - 2d-1xW": two
 *  dogs, once a week; real export, 2026-11-27): "1xW" weekly, "2xW" twice a
 *  week, "bW" every other week, "1xM" monthly. Null when the text holds no
 *  such code; a code with a count HoundStack has no plan for ("3xW") gives
 *  a null frequency, so the row is refused with the text quoted. */
export function sweepGoPlanCode(
  text: string | null | undefined,
): { dogs: number | null; frequency: ImportFrequency | null; label: string | null } | null {
  const m = (text ?? "").match(/(?:^|[\s-])(?:(\d{1,2})d-)?(?:(\d)x([wm])|(b)w)\s*$/i);
  if (!m) return null;
  const [, dogs, times, per, every] = m;
  const n = Number(times);
  const unit = (per ?? "").toLowerCase();
  const frequency: ImportFrequency | null = every
    ? { frequency: "biweekly" }
    : unit === "w" && n === 1
      ? { frequency: "weekly" }
      : unit === "w" && n === 2
        ? { frequency: "twice_weekly" }
        : unit === "m" && n === 1
          ? { frequency: "monthly" }
          : null;
  const label =
    (text ?? "")
      .slice(0, m.index)
      .replace(/[\s-]+$/, "")
      .trim() || null;
  return { dogs: dogs ? Number(dogs) : null, frequency, label };
}

/** "$1,234.50", "1234.5", "(45.00)" → cents. Null when not a number. The
 *  sign is kept: a negative opening balance is a credit. */
export function parseMoneyCents(text: string | null | undefined): number | null {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.includes("-");
  const digits = raw.replace(/[^\d.]/g, "");
  if (!digits || (digits.match(/\./g)?.length ?? 0) > 1) return null;
  const n = Number(digits);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) * (negative ? -1 : 1);
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

/**
 * "2026-10-01", "10/01/2026", "10/1/26", "Oct 1, 2026", "1 Oct 2026" →
 * YYYY-MM-DD. A slash date is US month-first unless it cannot be ("25/10/2026"
 * has no 25th month), in which case it is read day-first; "01/02/2026" is
 * January 2 either way, as every export from a US product writes it. A
 * timestamp that carries a time and a zone ("2026-10-01T03:30:00Z") is the
 * date it was on the business's own clock when `tz` is given, so a plan
 * created at 11 pm in Detroit is not dated tomorrow. Null when it is not a
 * real date.
 */
export function parseImportDate(
  text: string | null | undefined,
  tz?: string | null,
): string | null {
  // Time To Pet's reports open a date with its weekday ("Fri Dec 25, 2026
  // 12:00 PM"); the weekday says nothing the date does not.
  const s = (text ?? "")
    .trim()
    .replace(/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+(?=[a-z]{3,9}\.?\s+\d)/i, "");
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = s.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/i,
  );
  const slash = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/);
  const monthFirst = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  const dayFirst = s.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (iso[4] && iso[6] && tz) {
      const local = orgLocalDay(s.replace(" ", "T"), tz);
      if (local) return local;
    }
  } else if (slash) {
    const [a, b] = [Number(slash[1]), Number(slash[2])];
    y = Number(slash[3]);
    if (y < 100) y += 2000;
    // Month-first unless the first number cannot be a month.
    [m, d] = a > 12 && b <= 12 ? [b, a] : [a, b];
  } else if (monthFirst || dayFirst) {
    const name = (monthFirst ? monthFirst[1] : dayFirst![2]).toLowerCase().slice(0, 4);
    const mon = MONTHS[name] ?? MONTHS[name.slice(0, 3)];
    if (!mon) return null;
    m = mon;
    d = Number(monthFirst ? monthFirst[2] : dayFirst![1]);
    y = Number(monthFirst ? monthFirst[3] : dayFirst![3]);
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/** Jobber's Tags cell ("Weekly; Tuesday, VIP") → distinct trimmed tags. */
export function parseTags(text: string | null | undefined): string[] | null {
  if (!text) return null;
  const tags = [
    ...new Set(
      text
        .split(/[;,|]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 60),
    ),
  ];
  return tags.length ? tags.slice(0, 30) : null;
}

type Mapping = Record<string, string | null>;

function cell(raw: Record<string, unknown>, mapping: Mapping, field: string): string | null {
  const src = mapping[field];
  if (!src) return null;
  const v = raw[src];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

export type ImportBillingFrequency =
  "after_each_visit" | "weekly" | "monthly" | "quarterly" | "yearly";

/** The clients.billing_frequency a billing cell names, or null. "Per
 *  visit" (Jobber's Billing type), "after each visit", "each cleanup" are
 *  all billed after each visit; the plan itself is postpaid either way. */
export function parseBillingFrequency(
  text: string | null | undefined,
): ImportBillingFrequency | null {
  const s = (text ?? "").toLowerCase().trim();
  if (!s) return null;
  if (
    /\b(after|per|each|every)\b.*\b(visit|cleanup|clean-up|job|service|walk|session)s?\b/.test(s)
  ) {
    return "after_each_visit";
  }
  if (/\b(per|each|every)\s+(visit|cleanup|job|service)\b/.test(s)) return "after_each_visit";
  if (/quarter/.test(s)) return "quarterly";
  if (/year|annual/.test(s)) return "yearly";
  if (/month/.test(s)) return "monthly";
  if (/week/.test(s)) return "weekly";
  return null;
}

export type MappedService = {
  client_external_id: string | null;
  client_name: string | null;
  /** The client's email, when the file names it (Jobber's Recurring jobs
   *  report does), to tell two clients of one name apart. */
  client_email?: string | null;
  frequency: ImportFrequency["frequency"];
  /** False when the file has no frequency column at all (Jobber's Recurring
   *  jobs report, #857): the plan is weekly on paper, comes in paused, and
   *  the owner sets how often before turning it on. */
  frequency_in_file: boolean;
  interval_weeks: number | null;
  interval_days: number | null;
  price_cents: number;
  preferred_weekdays: number[] | null;
  /** Where the plan's schedule is walked from (subscriptions.started_on).
   *  With visit dates in the file (planAnchor): the date that at least one
   *  other of start, last visit and next visit agrees with on the plan's
   *  frequency, preferring the next visit, so one visit moved by hand does
   *  not move the whole schedule; with no agreement, the file's start date.
   *  Without visit dates, the file's start date. */
  started_on: string | null;
  /** Which date the schedule is walked from, and the visits off that
   *  schedule (moved once in the old system), for the plan's note.
   *  `schedule_changed`: the upcoming visits agree with each other and not
   *  with the last one, so the schedule was changed and the plan follows
   *  the upcoming visits. `dates_disagree`: no two dates agree and nothing
   *  says which is right, so the owner is asked to check. */
  anchor_from?: "next visit" | "visit after next" | "last visit" | "start date";
  off_schedule?: { which: OffWhich; on: string }[];
  schedule_changed?: boolean;
  /** The plan follows the upcoming visits and the last visit is off them,
   *  with no start date to say whether the schedule changed or that one
   *  visit was moved. */
  last_or_changed?: boolean;
  dates_disagree?: boolean;
  /** The booked visit after the next one, when the file has it. */
  visit_after_next?: string | null;
  /** The day the plan stops (subscriptions.ends_on): the old system's
   *  schedule end date (Jobber's "Schedule end date"). */
  ends_on?: string | null;
  /** The file's own start date, kept for the plan's note when the plan is
   *  walked from a visit instead. */
  file_started_on?: string | null;
  /** The last completed visit and the next booked one, when the file has
   *  them (a Jobber import joined with its Visits report). A plan holds no
   *  last-visit date of its own, so both are also written in its note. */
  last_visit?: string | null;
  next_visit?: string | null;
  dog_count: number | null;
  billing_cadence: "prepaid" | "postpaid" | null;
  /** How often the client is billed, when the file's billing column says
   *  (clients.billing_frequency): "after each visit", "per visit" and
   *  "per cleanup" are after_each_visit; a weekly, monthly, quarterly or
   *  yearly word is that. Null when the column is absent or says something
   *  else, and the client keeps what they have.' */
  billing_frequency: ImportBillingFrequency | null;
  /** The service the row names ("30-minute walk"), trimmed, or null when
   *  the file has no Service column or the cell is blank: the plan then
   *  takes the business's default, as every import before the catalog. */
  service_name: string | null;
  /** The street the old system did the plan at (Jobber's "Service street"),
   *  so a client with two addresses gets the plan on the right one. Only
   *  present when the file names one. */
  service_street?: string | null;
  /** Who the old system assigned the visits to (Jobber's "Visits assigned
   *  to"), matched to a team member by name at commit. Only present when
   *  the file names one. */
  assigned_to?: string | null;
};

/** The same bound as services_name_length. A longer cell is cut, not
 *  refused: the plan is the thing being imported, the name is a label. */
const SERVICE_NAME_MAX = 80;

/**
 * The line a service's own name suggests, for one the import has to create.
 * The words are the ones the trades use for themselves; a name that says
 * nothing ("Standard", "Plan A") goes on the business's only line when it
 * has only one, else on `other`, where the owner can move it.
 */
export function inferServiceLine(name: string, orgLines: readonly ServiceLine[]): ServiceLine {
  const s = name.toLowerCase();
  if (/\b(walks?|walking|strolls?|hikes?)\b/.test(s)) return "dog_walking";
  if (
    /\b(sit|sits|sitting|sitter|drop[- ]?ins?|overnights?|boarding|house ?visits?|feeding|check[- ]?ins?)\b/.test(
      s,
    )
  )
    return "pet_sitting";
  if (/\b(grooms?|grooming|baths?|nails?|trims?|brush(ing)?|de-?shed(ding)?|shampoo)\b/.test(s))
    return "mobile_grooming";
  if (
    /\b(train|trains|training|trainer|lesson|lessons|obedience|behavior|behaviour|puppy)\b/.test(s)
  )
    return "training";
  if (/\b(waste|scoop(s|ing)?|poop|pooper|doody|doo|clean(s|ing|up)?|clean-up|yards?)\b/.test(s))
    return "pet_waste";
  return orgLines.length === 1 ? orgLines[0] : "other";
}

/** A length written into the name: "30-minute walk" is 30, "Drop-in (20
 *  min)" is 20, "1 hr walk" is 60, "1.5 hour groom" is 90. Null when the name
 *  does not say; a suggested number is the one that ships unread. */
export function durationFromName(name: string): number | null {
  const s = name.toLowerCase();
  const mins = /(\d{1,3})\s*-?\s*(?:min|mins|minute|minutes)\b/.exec(s);
  const hours = /(\d{1,2}(?:\.\d{1,2})?)\s*-?\s*(?:hr|hrs|hour|hours)\b/.exec(s);
  let n: number | null = null;
  if (mins) n = Number(mins[1]);
  else if (hours) n = Math.round(Number(hours[1]) * 60);
  return n !== null && n >= 1 && n <= 720 ? n : null;
}

/** What the import creates for a service name it has not seen: the row
 *  Settings → Services would save, with no price. */
export function newServiceDraft(
  name: string,
  orgLines: readonly ServiceLine[],
): {
  name: string;
  service_line: ServiceLine;
  price_unit: "visit";
  base_price_cents: null;
  extra_pet_cents: 0;
  default_duration_min: number | null;
  active: true;
} {
  const trimmed = name.trim().slice(0, SERVICE_NAME_MAX);
  const line = inferServiceLine(trimmed, orgLines);
  return {
    name: trimmed,
    service_line: line,
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: 0,
    // A cleanup takes as long as the yard; a walk as long as its name says.
    default_duration_min: line === "pet_waste" ? null : durationFromName(trimmed),
    active: true,
  };
}

/** One of the business's services, as the import matches a row to it. */
export type ImportService = { id: string; name: string; service_line: string };

/** The business's service a row names, by name, case and spaces aside. Null
 *  when the row names none; undefined when it names one the business has
 *  not got (the caller creates it). */
export function matchImportService(
  name: string | null,
  services: readonly ImportService[],
): ImportService | null | undefined {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) return null;
  return services.find((s) => s.name.trim().toLowerCase() === key);
}

/**
 * The subscriptions row an imported plan becomes. This is the ONE place it is
 * built, so the pet-waste shape can be held to what it was. Since #857 every
 * imported plan is PAUSED (the owner's rule, Nov 10 2026: "Imported schedules
 * start paused until the owner turns them on"), so no visit is generated by
 * the import; resumeSubscription puts it on the schedule. Otherwise:
 *
 *   * no service on the row, or the business's pet-waste service: exactly the
 *     row every import before the catalog wrote (the database fills the
 *     default service on insert, tg_subscriptions_service), plus service_id
 *     when the row named it;
 *   * any other service, weekly, with days named: the days become the plan's
 *     weekday set (one visit on each, migration 20261010010000) and the
 *     preferred day is left empty, since the set IS the schedule.
 */
export function importPlanRow(
  m: MappedService,
  ctx: {
    orgId: string;
    clientId: string;
    propertyId: string;
    zoneId: string | null;
    isResidential: boolean;
    dogCount: number | null;
    service: ImportService | null;
    /** The team member the old system assigned the visits to, when the
     *  file named one that matches (staffByName). */
    staffId?: string | null;
    /** When the import runs (ISO), for price_overridden_at. */
    now: string;
  },
): Record<string, unknown> {
  const setDays =
    !!ctx.service &&
    ctx.service.service_line !== "pet_waste" &&
    m.frequency === "weekly" &&
    (m.interval_weeks ?? 1) === 1 &&
    !!m.preferred_weekdays?.length;
  return {
    organization_id: ctx.orgId,
    client_id: ctx.clientId,
    property_id: ctx.propertyId,
    account_type: ctx.isResidential ? "residential" : "commercial",
    frequency: m.frequency,
    interval_weeks: m.frequency === "weekly" ? m.interval_weeks : null,
    interval_days: m.frequency === "every_n_days" ? m.interval_days : null,
    price_cents: m.price_cents,
    dog_count: ctx.isResidential ? ctx.dogCount : null,
    unit_count: ctx.isResidential ? null : 1,
    zone_id: ctx.zoneId ?? null,
    billing_cadence: m.billing_cadence ?? "postpaid",
    preferred_weekdays: setDays ? null : m.preferred_weekdays,
    // The price came from the old system, not the rate card, so it is
    // recorded as set by hand.
    price_overridden_at: ctx.now,
    ...(m.started_on ? { started_on: m.started_on } : {}),
    ...(m.ends_on ? { ends_on: m.ends_on } : {}),
    ...(ctx.service ? { service_id: ctx.service.id } : {}),
    ...(ctx.staffId ? { assigned_staff_id: ctx.staffId } : {}),
    ...(setDays ? { weekdays: m.preferred_weekdays } : {}),
    status: "paused",
    paused_at: ctx.now,
  };
}

const squashStreet = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Which of the client's addresses a plan goes on: the one whose street is
 *  the file's service street (case and punctuation aside; "12 Example Lane"
 *  matches "12 Example Lane, Apt 2"), else the first. `matched` is false
 *  when the file named a street none of them has, so the commit can say. */
export function pickPlanProperty<P extends { street: string | null }>(
  props: readonly P[],
  serviceStreet: string | null | undefined,
): { prop: P | null; matched: boolean } {
  if (!props.length) return { prop: null, matched: false };
  const want = squashStreet(serviceStreet);
  if (!want) return { prop: props[0], matched: true };
  // Sweep&Go's subscriptions export writes the whole address in one cell
  // ("101 Test Lane, Austin, Texas 78701"), so a file street that begins
  // with the property's street matches too, after an exact match.
  const hit =
    props.find((p) => squashStreet(p.street) === want) ??
    props.find((p) => squashStreet(p.street).startsWith(`${want} `)) ??
    props.find((p) => {
      const have = squashStreet(p.street);
      return !!have && want.startsWith(`${have} `);
    });
  return hit ? { prop: hit, matched: true } : { prop: props[0], matched: false };
}

/** The one client called `name` (lowercased) with a service address at
 *  `street`, or null when no street is given or not exactly one of them is
 *  there: two clients of one name are told apart by where they live, never
 *  guessed. */
export function clientAtStreet(
  clients: readonly {
    id: string;
    display_name: string | null;
    streets?: { street: string | null }[];
  }[],
  name: string,
  street: string | null | undefined,
): string | null {
  if (!squashStreet(street)) return null;
  const hits = clients.filter(
    (c) =>
      (c.display_name ?? "").trim().toLowerCase() === name &&
      pickPlanProperty(c.streets ?? [], street).matched &&
      (c.streets ?? []).length > 0,
  );
  return hits.length === 1 ? hits[0].id : null;
}

/** The active team member a name names (case and spacing aside), or null
 *  when none or more than one does. */
export function staffByName<S extends { id: string; display_name: string | null }>(
  staff: readonly S[],
  name: string | null | undefined,
): S | null {
  const want = (name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!want) return null;
  const hits = staff.filter(
    (s) => (s.display_name ?? "").toLowerCase().replace(/\s+/g, " ").trim() === want,
  );
  return hits.length === 1 ? hits[0] : null;
}

const byName = (raw: Record<string, unknown>, names: readonly string[]) => {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const key = Object.keys(raw).find((k) => want.has(k.trim().toLowerCase()));
  return key ? String(raw[key] ?? "").trim() : "";
};
function splitName(raw: Record<string, unknown>): string | null {
  const name = [byName(raw, FIRST_NAME_COLUMNS), byName(raw, LAST_NAME_COLUMNS)]
    .filter(Boolean)
    .join(" ");
  return name || null;
}

const ENDED_STATUS = /^(cancell?ed|terminated|ended|closed|inactive|archived|expired)$/i;
const PER_VISIT = /\b(per|each|every|a)\s+(cleanup|clean-up|visit|service|job|walk|session)\b/i;

export function mapServiceRow(
  raw: Record<string, unknown>,
  mapping: Mapping,
  tz?: string | null,
): { mapped: MappedService | null; error: string | null } {
  const client_external_id = cell(raw, mapping, "client_external_id");
  // A file that splits the name (Sweep&Go's Completed Jobs: "Client First
  // Name", "Client Last Name") gives it whole when no column is mapped.
  const client_name = cell(raw, mapping, "client_name") ?? splitName(raw);
  const client_email =
    cell(raw, mapping, "client_email")
      ?.split(/[;,\s]+/)[0]
      ?.toLowerCase() ?? null;
  if (!client_external_id && !client_name && !client_email) {
    return { mapped: null, error: "Missing the client (map an ID, a name or an email column)" };
  }
  // A plan cancelled in the old system is not a live plan (Sweep&Go's
  // subscriptions "Status": Active, Paused, Pending or Canceled).
  const statusText = cell(raw, mapping, "plan_status");
  if (statusText && ENDED_STATUS.test(statusText)) {
    return {
      mapped: null,
      error: `"${statusText}" in the old system, so it is not imported as a live plan. Add it by hand if it starts again.`,
    };
  }
  // What the price is per (Sweep&Go's "Revenue Type": "per cleanup"). A
  // price per month or per billing period is not a price per visit.
  const basisText = cell(raw, mapping, "price_basis");
  if (basisText && !PER_VISIT.test(basisText)) {
    return {
      mapped: null,
      error: `The price is "${basisText}", not per visit. Add this plan by hand with its price per visit.`,
    };
  }
  const freqText = cell(raw, mapping, "frequency");
  const dayText = cell(raw, mapping, "service_day");
  // No frequency column at all: the plan is weekly on paper and comes in
  // paused for the owner to set (frequency_in_file: false). A cell that says
  // something we cannot read is refused, quoted, instead.
  const freq = freqText ? parseFrequency(freqText) : { frequency: "weekly" as const };
  if (!freq) return { mapped: null, error: `Frequency not understood: "${freqText}"` };
  const priceText = cell(raw, mapping, "price_per_visit");
  const billText = (cell(raw, mapping, "billing") ?? "").toLowerCase();
  // Jobber's "Fixed price" billing puts the amount per billing period in
  // Total ($) (a weekly job at 80.00 billed monthly reads 80.00; real
  // export, 2026-11-27). Taking it as a per-visit price would bill the
  // client four times over, so the row is refused with the reason.
  if (/\bfixed\b/.test(billText)) {
    return {
      mapped: null,
      error: `Billed as a fixed price, so "${priceText ?? ""}" is the amount per billing period, not per visit. Add this plan by hand with its price per visit.`,
    };
  }
  const price = parseMoneyCents(priceText);
  if (price == null || price < 0) {
    return {
      mapped: null,
      error: priceText ? `Price not understood: "${priceText}"` : "Missing price per visit",
    };
  }
  // A zero price is a free visit, not the plan's price (Sweep&Go's Completed
  // Jobs lists the first "Initial" cleanup at 0.00; real export,
  // 2026-11-27). A plan at $0 would bill nothing, so it is refused.
  if (price === 0) {
    return {
      mapped: null,
      error: `The price is "${priceText}" in the file, so it is not the plan's price. Add this plan by hand with its price per visit.`,
    };
  }
  const days = parseWeekdays(dayText ?? freqText);
  const startText = cell(raw, mapping, "start_date");
  const file_started_on = startText ? parseImportDate(startText, tz) : null;
  if (startText && !file_started_on)
    return { mapped: null, error: `Start date not understood: "${startText}"` };
  // A job closed in the old system is not a live plan (Jobber's "Closed
  // date" is "-" while the job is open).
  const closedText = noVisit(cell(raw, mapping, "closed_date"));
  if (closedText) {
    const closed = parseImportDate(closedText, tz);
    return {
      mapped: null,
      error: `Closed in the old system${closed ? ` on ${closed}` : ` ("${closedText}")`}, so it is not imported as a live plan. Add it by hand if it starts again.`,
    };
  }
  const endText = noVisit(cell(raw, mapping, "end_date"));
  const ends_on = endText ? parseImportDate(endText, tz) : null;
  if (endText && !ends_on) return { mapped: null, error: `End date not understood: "${endText}"` };
  if (ends_on && ends_on < orgToday(tz ?? undefined)) {
    return {
      mapped: null,
      error: `The schedule ended on ${ends_on} in the old system, so it is not imported as a live plan.`,
    };
  }
  // "-", "N/A", "Never", "TBD" or "None" in a visit column is no visit, not
  // a reason to refuse the row.
  const lastText = noVisit(cell(raw, mapping, "last_visit"));
  const last_visit = lastText ? parseImportDate(lastText, tz) : null;
  if (lastText && !last_visit)
    return { mapped: null, error: `Last visit not understood: "${lastText}"` };
  const nextText = noVisit(cell(raw, mapping, "next_visit"));
  const next_visit = nextText ? parseImportDate(nextText, tz) : null;
  if (nextText && !next_visit)
    return { mapped: null, error: `Next visit not understood: "${nextText}"` };
  const afterText = noVisit(cell(raw, mapping, "visit_after_next"));
  const visit_after_next = afterText ? parseImportDate(afterText, tz) : null;
  if (afterText && !visit_after_next)
    return { mapped: null, error: `Visit after next not understood: "${afterText}"` };
  const anchor = planAnchor({
    frequency: freq.frequency,
    intervalWeeks: freq.intervalWeeks ?? null,
    intervalDays: freq.intervalDays ?? null,
    weekdays: days,
    frequencyInFile: !!mapping.frequency,
    start: file_started_on,
    last: last_visit,
    next: next_visit,
    afterNext: visit_after_next,
    monthDay: statedMonthDay(freqText),
  });
  const started_on = anchor.on;
  const serviceStreet = cell(raw, mapping, "service_street");
  const assignedTo = cell(raw, mapping, "assigned_to")?.split(/[;,]/)[0]?.trim() || null;
  const dogText = cell(raw, mapping, "dog_count");
  const dogCode = sweepGoPlanCode(dogText);
  const dogs = dogCode
    ? (dogCode.dogs ?? NaN)
    : dogText
      ? Number(dogText.replace(/[^\d]/g, ""))
      : NaN;
  // "Regular Plan - 2d-1xW" is the plan "Regular Plan"; the code is its
  // dogs and frequency, read above.
  const serviceText = cell(raw, mapping, "service");
  const serviceName = sweepGoPlanCode(serviceText)?.label ?? serviceText;
  return {
    mapped: {
      client_external_id,
      client_name,
      client_email,
      frequency: freq.frequency,
      frequency_in_file: !!mapping.frequency,
      interval_weeks: freq.intervalWeeks ?? null,
      interval_days: freq.intervalDays ?? null,
      price_cents: price,
      preferred_weekdays: days.length ? days : null,
      started_on,
      // Only a row with a visit date carries these, so a file without them
      // maps to exactly the plan it always did.
      ...(last_visit || next_visit
        ? {
            file_started_on,
            last_visit,
            next_visit,
            anchor_from: anchor.from ?? undefined,
            off_schedule: anchor.off,
            ...(visit_after_next ? { visit_after_next } : {}),
            ...(anchor.changed ? { schedule_changed: true } : {}),
            ...(anchor.lastOrChanged ? { last_or_changed: true } : {}),
            ...(anchor.unsure ? { dates_disagree: true } : {}),
          }
        : {}),
      ...(ends_on ? { ends_on } : {}),
      dog_count: Number.isFinite(dogs) && dogs > 0 && dogs <= 50 ? dogs : null,
      billing_cadence: billText.startsWith("pre") ? "prepaid" : billText ? "postpaid" : null,
      // How often the client is invoiced: the file's own billing frequency
      // column when it has one (Jobber: "Monthly on the last day of the
      // month" beside a "Per visit" billing type), else the billing cell.
      billing_frequency:
        parseBillingFrequency(cell(raw, mapping, "billing_frequency")) ??
        parseBillingFrequency(billText),
      service_name: serviceName,
      ...(serviceStreet ? { service_street: serviceStreet } : {}),
      ...(assignedTo ? { assigned_to: assignedTo } : {}),
    },
    error: null,
  };
}

/** The plan's dates from the old system, for the client's office note:
 *  when it started there, its last completed visit, its next booked visit,
 *  which of them the plan's schedule is walked from, and the day it ends.
 *  Null when the row had none of these (the start date alone is already
 *  the plan's). */
export function planVisitsNote(
  sourceLabel: string,
  m: Pick<
    MappedService,
    | "file_started_on"
    | "last_visit"
    | "next_visit"
    | "started_on"
    | "anchor_from"
    | "off_schedule"
    | "schedule_changed"
    | "last_or_changed"
    | "dates_disagree"
    | "visit_after_next"
    | "ends_on"
  >,
): string | null {
  const ends = m.ends_on
    ? ` It ends ${m.ends_on}, as it did in ${sourceLabel}; clear the end date on the plan to keep it going.`
    : "";
  if (!m.last_visit && !m.next_visit) {
    return ends ? `Imported plan from ${sourceLabel}.${ends}` : null;
  }
  const parts = [
    m.file_started_on ? `started there ${m.file_started_on}` : null,
    `last visit ${m.last_visit ?? "none completed"}`,
    `next visit ${m.next_visit ?? "none booked"}`,
    m.visit_after_next ? `the one after ${m.visit_after_next}` : null,
  ].filter(Boolean);
  const from =
    m.anchor_from ??
    (m.started_on === m.next_visit
      ? "next visit"
      : m.started_on === m.last_visit
        ? "last visit"
        : "start date");
  const offList = (m.off_schedule ?? []).map((o) => `${o.which} ${o.on}`).join(", ");
  const why = m.schedule_changed
    ? ` The upcoming visits are on a different schedule from the last visit (${m.last_visit}), so the schedule was changed in ${sourceLabel} and the plan follows the upcoming visits.`
    : m.last_or_changed
      ? ` The last visit (${m.last_visit}) is off the schedule of the upcoming visits: it was moved once, or the schedule was changed in ${sourceLabel}. The plan follows the upcoming visits.`
      : m.dates_disagree
        ? ` The dates from ${sourceLabel} do not agree on this schedule (${offList}), and nothing in the file says which is right; check the plan's visits before you turn it on.`
        : (m.off_schedule ?? [])
            .map(
              (o) =>
                ` The ${o.which} (${o.on}) is off that schedule, so it was likely moved once in ${sourceLabel}; check the plan's visits after you turn it on.`,
            )
            .join("");
  return `Imported plan from ${sourceLabel}: ${parts.join("; ")}. The plan's schedule is set from the ${from} (${m.started_on}).${why}${ends}`;
}

export type MappedBalance = {
  client_external_id: string | null;
  client_name: string | null;
  amount_cents: number;
  due_on: string | null;
  note: string | null;
  /** The client's street, to tell apart two clients of one name. */
  service_street?: string | null;
};

export function mapBalanceRow(
  raw: Record<string, unknown>,
  mapping: Mapping,
  tz?: string | null,
): { mapped: MappedBalance | null; error: string | null } {
  const client_external_id = cell(raw, mapping, "client_external_id");
  const client_name = cell(raw, mapping, "client_name");
  if (!client_external_id && !client_name) {
    return { mapped: null, error: "Missing the client (map an ID or a name column)" };
  }
  const amountText = cell(raw, mapping, "amount");
  const amount = parseMoneyCents(amountText);
  if (amount == null) {
    return {
      mapped: null,
      error: amountText ? `Amount not understood: "${amountText}"` : "Missing amount",
    };
  }
  // Nothing owed is not a row to import; a credit is a different conversation
  // (the credit ledger) and is refused rather than turned into a negative bill.
  if (amount === 0) return { mapped: null, error: "Balance is zero; nothing to carry over" };
  if (amount < 0)
    return { mapped: null, error: "Balance is a credit; add it as account credit instead" };
  const dueText = cell(raw, mapping, "due_date");
  const due_on = dueText ? parseImportDate(dueText, tz) : null;
  if (dueText && !due_on) return { mapped: null, error: `Due date not understood: "${dueText}"` };
  return {
    mapped: {
      client_external_id,
      client_name,
      amount_cents: amount,
      due_on,
      note: cell(raw, mapping, "note"),
      ...(cell(raw, mapping, "service_street")
        ? { service_street: cell(raw, mapping, "service_street") }
        : {}),
    },
    error: null,
  };
}
