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

import type { ServiceLine } from "@/lib/service-lines";

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

/** "2026-10-01", "10/01/2026", "10/1/26" → YYYY-MM-DD, US month-first. Null
 *  when it is not a real date. */
export function parseImportDate(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) {
    [m, d, y] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (y < 100) y += 2000;
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

export type MappedService = {
  client_external_id: string | null;
  client_name: string | null;
  frequency: ImportFrequency["frequency"];
  interval_weeks: number | null;
  interval_days: number | null;
  price_cents: number;
  preferred_weekdays: number[] | null;
  started_on: string | null;
  dog_count: number | null;
  billing_cadence: "prepaid" | "postpaid" | null;
  /** The service the row names ("30-minute walk"), trimmed, or null when
   *  the file has no Service column or the cell is blank: the plan then
   *  takes the business's default, as every import before the catalog. */
  service_name: string | null;
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
 * built, so the pet-waste shape can be held to what it was:
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
    ...(ctx.service ? { service_id: ctx.service.id } : {}),
    ...(setDays ? { weekdays: m.preferred_weekdays } : {}),
  };
}

export function mapServiceRow(
  raw: Record<string, unknown>,
  mapping: Mapping,
): { mapped: MappedService | null; error: string | null } {
  const client_external_id = cell(raw, mapping, "client_external_id");
  const client_name = cell(raw, mapping, "client_name");
  if (!client_external_id && !client_name) {
    return { mapped: null, error: "Missing the client (map an ID or a name column)" };
  }
  const freqText = cell(raw, mapping, "frequency");
  const dayText = cell(raw, mapping, "service_day");
  // No frequency column at all means weekly, the norm for this trade. A cell
  // that says something we cannot read is refused, quoted, instead.
  const freq = freqText ? parseFrequency(freqText) : { frequency: "weekly" as const };
  if (!freq) return { mapped: null, error: `Frequency not understood: "${freqText}"` };
  const priceText = cell(raw, mapping, "price_per_visit");
  const price = parseMoneyCents(priceText);
  if (price == null || price < 0) {
    return {
      mapped: null,
      error: priceText ? `Price not understood: "${priceText}"` : "Missing price per visit",
    };
  }
  const days = parseWeekdays(dayText ?? freqText);
  const startText = cell(raw, mapping, "start_date");
  const started_on = startText ? parseImportDate(startText) : null;
  if (startText && !started_on)
    return { mapped: null, error: `Start date not understood: "${startText}"` };
  const dogText = cell(raw, mapping, "dog_count");
  const dogs = dogText ? Number(dogText.replace(/[^\d]/g, "")) : NaN;
  const billText = (cell(raw, mapping, "billing") ?? "").toLowerCase();
  return {
    mapped: {
      client_external_id,
      client_name,
      frequency: freq.frequency,
      interval_weeks: freq.intervalWeeks ?? null,
      interval_days: freq.intervalDays ?? null,
      price_cents: price,
      preferred_weekdays: days.length ? days : null,
      started_on,
      dog_count: Number.isFinite(dogs) && dogs > 0 && dogs <= 50 ? dogs : null,
      billing_cadence: billText.startsWith("pre") ? "prepaid" : billText ? "postpaid" : null,
      service_name: cell(raw, mapping, "service"),
    },
    error: null,
  };
}

export type MappedBalance = {
  client_external_id: string | null;
  client_name: string | null;
  amount_cents: number;
  due_on: string | null;
  note: string | null;
};

export function mapBalanceRow(
  raw: Record<string, unknown>,
  mapping: Mapping,
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
  const due_on = dueText ? parseImportDate(dueText) : null;
  if (dueText && !due_on) return { mapped: null, error: `Due date not understood: "${dueText}"` };
  return {
    mapped: {
      client_external_id,
      client_name,
      amount_cents: amount,
      due_on,
      note: cell(raw, mapping, "note"),
    },
    error: null,
  };
}
