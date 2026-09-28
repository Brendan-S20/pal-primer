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

/** Weekdays named anywhere in a cell: "Tuesday", "Tue & Fri", "Weekly on
 *  Thursdays". 0 = Sunday, the numbering subscriptions.preferred_weekdays
 *  uses. Empty when none are named. */
export function parseWeekdays(text: string | null | undefined): number[] {
  if (!text) return [];
  const out = new Set<number>();
  for (const [re, d] of WEEKDAY_WORDS) if (re.test(text)) out.add(d);
  return [...out].sort((a, b) => a - b);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, other: 2,
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
};

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
    return { mapped: null, error: priceText ? `Price not understood: "${priceText}"` : "Missing price per visit" };
  }
  const days = parseWeekdays(dayText ?? freqText);
  const startText = cell(raw, mapping, "start_date");
  const started_on = startText ? parseImportDate(startText) : null;
  if (startText && !started_on) return { mapped: null, error: `Start date not understood: "${startText}"` };
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
    return { mapped: null, error: amountText ? `Amount not understood: "${amountText}"` : "Missing amount" };
  }
  // Nothing owed is not a row to import; a credit is a different conversation
  // (the credit ledger) and is refused rather than turned into a negative bill.
  if (amount === 0) return { mapped: null, error: "Balance is zero; nothing to carry over" };
  if (amount < 0) return { mapped: null, error: "Balance is a credit; add it as account credit instead" };
  const dueText = cell(raw, mapping, "due_date");
  const due_on = dueText ? parseImportDate(dueText) : null;
  if (dueText && !due_on) return { mapped: null, error: `Due date not understood: "${dueText}"` };
  return {
    mapped: { client_external_id, client_name, amount_cents: amount, due_on, note: cell(raw, mapping, "note") },
    error: null,
  };
}
