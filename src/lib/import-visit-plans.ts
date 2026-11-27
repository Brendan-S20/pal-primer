// Plans from a file of visits: Housecall Pro's Jobs export and Time To Pet's
// Visits report.
//
// Neither vendor exports a recurring plan with a frequency column (real files
// from both trials, 2026-11-27, in tests/fixtures/imports). Housecall Pro's
// Jobs export writes one row per occurrence of a recurring job, a year ahead:
// "Customer name", "Job description", "Job status" (Completed or Scheduled),
// "Job scheduled start date", "Total service price", "Street". Time To Pet's
// Visits report writes one row per visit: "Start", "Client", "Service",
// "Status", "Service Revenue", "Staff".
//
// This reads such a file, in the browser before the mapping step, as one row
// per client, service and address. The row is that plan's next visit (or its
// last), with every column the file has, plus six columns read off the
// dates: how often, the first, last and next visit, the one after that, and
// how many visits the file holds. How often is the spacing of the visits ("Weekly on Fridays",
// "Every 2 weeks on Fridays"); a plan with one visit in the file takes it from
// the service's own name ("Every Other Week Pet Waste Cleanup") and says so.
// Nothing is made up: a plan with no completed visit has no last visit.
//
// Rigel's review at da4554c6 found the plan read off the wrong visits and
// rows dropped without a word. Now (planVisitFile):
//
// - How often, the weekday and the price come from the plan's upcoming
//   visits when it has three or more, else from all of them: a schedule
//   changed in the old system is read as it is now. The price is the most
//   common one with its fees (Time To Pet's pet, holiday, after-hours and
//   weekend fees), not whichever row came first.
// - A job Housecall Pro marks not recurring is a one-off, not a plan.
// - A plan with no regular pattern, or one visit and a name that does not
//   say how often, is not imported; the page says so and why.
// - A plan with no visit booked while the file runs past its last one may
//   have ended: it comes in paused (as every imported plan does), and the
//   page and the plan's note say to check it.
// - Canceled and undated visits are listed on the plan and on the page, and
//   every visit's note is kept on the plan, not only the chosen row's.

import {
  VISITS_LEFT_OUT_COLUMN,
  VISITS_NOTES_COLUMN,
  VISITS_SCHEDULE_NOTE_COLUMN,
} from "@/lib/import-leftovers";
import {
  parseFrequency,
  parseImportDate,
  parseMoneyCents,
  sweepGoPlanCode,
  type ImportFrequency,
} from "@/lib/import-services";
import {
  frequencyFromName,
  mostCommon,
  scheduleFromDates,
  weekday,
} from "@/lib/import-visit-frequency";

export { frequencyFromDates } from "@/lib/import-visit-frequency";

export const VISITS_FREQUENCY_COLUMN = "How often (from the visits)";
export const VISITS_FIRST_COLUMN = "First visit (from the visits)";
export const VISITS_LAST_COLUMN = "Last visit (from the visits)";
export const VISITS_NEXT_COLUMN = "Next visit (from the visits)";
export const VISITS_AFTER_NEXT_COLUMN = "Visit after next (from the visits)";
export const VISITS_COUNT_COLUMN = "Visits in the file";
export const VISITS_PRICE_COLUMN = "Price per visit (from the visits)";
export { VISITS_LEFT_OUT_COLUMN, VISITS_NOTES_COLUMN, VISITS_SCHEDULE_NOTE_COLUMN };
export const VISITS_COLUMNS = [
  VISITS_FREQUENCY_COLUMN,
  VISITS_FIRST_COLUMN,
  VISITS_LAST_COLUMN,
  VISITS_NEXT_COLUMN,
  VISITS_AFTER_NEXT_COLUMN,
  VISITS_COUNT_COLUMN,
  VISITS_PRICE_COLUMN,
  VISITS_NOTES_COLUMN,
  VISITS_LEFT_OUT_COLUMN,
  VISITS_SCHEDULE_NOTE_COLUMN,
] as const;

type Row = Record<string, unknown>;
export type VisitFileColumns = {
  client: string;
  /** The last name, when the file keeps it apart from `client`; the plan
   *  then finds its client by both (mapServiceRow reads them by name). */
  clientLast?: string | null;
  service: string | null;
  date: string;
  status: string | null;
  street: string | null;
  /** Housecall Pro's "Recurring" (true or false): false is a one-off job. */
  recurring?: string | null;
  /** The visit's price, and fees charged on top of it. */
  price?: string | null;
  fees?: string[];
  note?: string | null;
  /** Sweep&Go's "Job Type": an "Initial" cleanup is priced on its own, so
   *  its price is not the plan's. */
  kind?: string | null;
};

type Spec = {
  signature: string[];
  client: string[];
  clientLast?: string[];
  service: string[];
  date: string[];
  status: string[];
  street: string[];
  recurring?: string[];
  price?: string[];
  fees?: string[];
  note?: string[];
  kind?: string[];
};

/** The visit files read off real exports, per source. A file is one of these
 *  when it carries every signature column. */
const VISIT_FILES: Record<string, Spec[]> = {
  housecall_pro: [
    {
      signature: ["Job scheduled start date", "Customer name"],
      client: ["Customer name"],
      service: ["Job description", "Job name"],
      date: ["Job scheduled start date"],
      status: ["Job status"],
      street: ["Street"],
      recurring: ["Recurring"],
      price: ["Total service price", "Job amount"],
      note: ["Notes"],
    },
  ],
  // Sweep&Go's Reports > Completed Jobs (real, 2026-11-27): "Service Date",
  // "Client First Name", "Client Last Name", "Address", "Status"
  // (dispatched, completed), "Service" (the plan code, "2d-1xW"),
  // "Revenue", "Field Tech", "Job Type" (Initial or Regular).
  sweepgo: [
    {
      signature: ["Service Date", "Client First Name", "Field Tech"],
      client: ["Client First Name"],
      clientLast: ["Client Last Name"],
      service: ["Service"],
      date: ["Service Date"],
      status: ["Status"],
      street: ["Address"],
      price: ["Revenue"],
      kind: ["Job Type"],
    },
  ],
  time_to_pet: [
    // Reporting > Schedule > Visits.
    {
      signature: ["Start", "Client", "Service"],
      client: ["Client"],
      service: ["Service"],
      date: ["Start"],
      status: ["Status"],
      street: [],
      price: ["Service Revenue"],
      fees: ["Pet Fees", "Holiday Fees", "After Hours Fees", "Weekend Fees"],
      note: ["Note"],
    },
    // Not Reporting > Schedule > Upcoming First/Last Visits: it lists the
    // first and last visit of each trip, so its one date is the end of a
    // schedule, not the next visit. It has no price either.
  ],
};

/** The client, service, date, status and address columns of a visits file
 *  from `source`, or null when the headers are not one. */
export function visitFileColumns(
  source: string,
  headers: readonly string[],
): VisitFileColumns | null {
  const one = (n: string) => headers.find((h) => h.trim().toLowerCase() === n.toLowerCase());
  const find = (names: readonly string[] = []) => names.map(one).find(Boolean) ?? null;
  for (const spec of VISIT_FILES[source] ?? []) {
    if (!spec.signature.every((s) => one(s))) continue;
    const fees = (spec.fees ?? []).map(one).filter((h): h is string => !!h);
    return {
      client: find(spec.client)!,
      service: find(spec.service),
      date: find(spec.date)!,
      status: find(spec.status),
      street: find(spec.street),
      ...(spec.clientLast ? { clientLast: find(spec.clientLast) } : {}),
      ...(spec.recurring ? { recurring: find(spec.recurring) } : {}),
      ...(spec.price ? { price: find(spec.price) } : {}),
      ...(fees.length ? { fees } : {}),
      ...(spec.note ? { note: find(spec.note) } : {}),
      ...(spec.kind ? { kind: find(spec.kind) } : {}),
    };
  }
  return null;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const DONE = /complet|done|finished/i;
const CALLED_OFF = /cancel|no[- ]?show|skipped|declined|deleted/i;
const NOT_RECURRING = /^(false|no|n|0)$/i;
const INITIAL = /initial|first|one[- ]?time/i;
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

type Visit = {
  row: Row;
  on: string | null;
  status: string;
  done: boolean;
  cents: number | null;
  note: string;
  /** An initial or first cleanup, priced on its own. */
  initial: boolean;
};

const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
/** The weekdays a run of visits falls on, when it falls on them week after
 *  week (walks Monday to Friday), Monday first; else none. */
function weekdaysOf(dates: readonly string[]): string[] {
  const days = [...new Set(dates.map(weekday))];
  const days7 = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const tight = dates.every((d, i) => i === 0 || days7(d) - days7(dates[i - 1]) <= 3);
  if (days.length < 3 || dates.length < days.length * 2 || !tight) return [];
  return days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAYS[d]);
}

/** Whether `dates` fall on a weekly (every k weeks) or monthly-by-date
 *  schedule read from earlier visits, walked from `from`. Another kind of
 *  schedule is taken to fit. */
function fitsSchedule(text: string, from: string, dates: readonly string[]): boolean {
  const day = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
  const w = text.match(/^(?:Weekly|Every (\d+) weeks) on (\w+)$/);
  if (w) {
    const step = 7 * Number(w[1] ?? 1);
    const wd = DAYS.indexOf(w[2]);
    return dates.every((d) => weekday(d) === wd && (day(d) - day(from)) % step === 0);
  }
  const m = text.match(/^Monthly on the (\d+)\w\w day of the month$/);
  if (m) return dates.every((d) => Number(d.slice(8, 10)) === Number(m[1]));
  return true;
}

/** "1d-3xW" in words: "3 times a week". */
function codeWords(code: string): string {
  const m = code.match(/(\d)x([wm])\s*$/i);
  if (!m) return /bw\s*$/i.test(code) ? "every 2 weeks" : `"${code}"`;
  const per = m[2].toLowerCase() === "w" ? "a week" : "a month";
  return m[1] === "1" ? `once ${per}` : m[1] === "2" ? `twice ${per}` : `${m[1]} times ${per}`;
}

/** Whether two frequencies are the same plan (every 2 weeks is biweekly). */
function sameFrequency(a: ImportFrequency, b: ImportFrequency): boolean {
  const weeks = (f: ImportFrequency) =>
    f.frequency === "biweekly" ? 2 : f.frequency === "weekly" ? (f.intervalWeeks ?? 1) : null;
  if (weeks(a) != null || weeks(b) != null) return weeks(a) === weeks(b);
  return a.frequency === b.frequency;
}

/** One row per client, service and address, as described above, and the
 *  visits and plans not imported, each with the reason (`left`), for the
 *  page to show. `today` is the business's day (YYYY-MM-DD); `tz` reads a
 *  timestamp with a zone on the business's clock. */
export function planVisitFile(
  rows: readonly Row[],
  cols: VisitFileColumns,
  today: string,
  tz?: string | null,
): { rows: Row[]; left: string[] } {
  const left: string[] = [];
  const groups = new Map<string, { label: string; service: string; visits: Visit[] }>();
  const clientOf = (row: Row) =>
    [str(row[cols.client]), cols.clientLast ? str(row[cols.clientLast]) : ""]
      .filter(Boolean)
      .join(" ");
  const centsOf = (row: Row) => {
    const base = cols.price ? parseMoneyCents(str(row[cols.price])) : null;
    if (base == null) return null;
    return (cols.fees ?? []).reduce((t, f) => t + (parseMoneyCents(str(row[f])) ?? 0), base);
  };
  for (const row of rows) {
    const client = clientOf(row);
    const dateText = str(row[cols.date]);
    const on = dateText ? parseImportDate(dateText, tz) : null;
    const service = cols.service ? str(row[cols.service]) : "";
    const status = cols.status ? str(row[cols.status]) : "";
    const cents = centsOf(row);
    const what = [on ?? (dateText ? `"${dateText}"` : "no date"), service && `"${service}"`]
      .filter(Boolean)
      .join(", ");
    if (!client) {
      left.push(`A visit with no client (${what}): not imported.`);
      continue;
    }
    if (cols.recurring && NOT_RECURRING.test(str(row[cols.recurring]))) {
      const price = cents ? `, ${money(cents)}` : "";
      left.push(
        `${client}, ${what}${price}: a one-time job, not a recurring plan, so it is not imported. Add it by hand as a one-off visit.`,
      );
      continue;
    }
    const street = cols.street ? str(row[cols.street]) : "";
    const key = [client, service, street].map((x) => x.toLowerCase()).join("\u0000");
    const label = `${client}${service ? `, "${service}"` : ""}${street ? ` at ${street}` : ""}`;
    const g = groups.get(key) ?? { label, service, visits: [] };
    g.visits.push({
      row,
      on,
      status,
      done: on ? (cols.status ? DONE.test(status) : on < today) : false,
      cents,
      note: cols.note ? str(row[cols.note]) : "",
      initial: cols.kind ? INITIAL.test(str(row[cols.kind])) : false,
    });
    groups.set(key, g);
  }

  const usableOf = (vs: Visit[]) => vs.filter((v) => v.on && !CALLED_OFF.test(v.status));
  const allUsable = [...groups.values()].flatMap((g) => usableOf(g.visits));
  const fileHasUpcoming = allUsable.some((v) => !v.done && v.on! >= today);
  const fileLast =
    allUsable
      .map((v) => v.on!)
      .sort()
      .at(-1) ?? null;

  const out: Row[] = [];
  for (const { label, service, visits } of groups.values()) {
    const usable = usableOf(visits).sort((a, b) => (a.on! < b.on! ? -1 : a.on! > b.on! ? 1 : 0));
    const leftOut = visits
      .filter((v) => !usable.includes(v))
      .map((v) => `${v.on ?? "no date"}${v.status ? ` (${v.status})` : ""}`);
    if (!usable.length) {
      left.push(
        `${label}: every visit is canceled or has no date (${leftOut.join(", ")}), so no plan is imported.`,
      );
      continue;
    }
    const dates = [...new Set(usable.map((v) => v.on!))];
    const last = usable.filter((v) => v.done).at(-1) ?? null;
    const upcoming = usable.filter((v) => !v.done && v.on! >= today);
    const next = upcoming[0] ?? null;
    const afterNext = upcoming.find((v) => v.on! > (next?.on ?? "")) ?? null;
    const anchor = next?.on ?? dates.at(-1)!;
    const ahead = [...new Set(upcoming.map((v) => v.on!))];
    // The plan as it is now: three upcoming visits that agree say it; two
    // say it when the visits done before do not fit them (Fridays until
    // now, then Tuesdays; every 2 weeks, then weekly). Else all the dates.
    const done = [...new Set(usable.filter((v) => v.on! < (next?.on ?? "~")).map((v) => v.on!))];
    const before = scheduleFromDates(done);
    const twoAhead = ahead.length === 2 ? scheduleFromDates(ahead, anchor) : null;
    const schedule =
      (ahead.length >= 3 ? scheduleFromDates(ahead, anchor) : null) ??
      (twoAhead && before && !before.note && !fitsSchedule(before.text, done.at(-1)!, ahead)
        ? twoAhead
        : null) ??
      scheduleFromDates(dates, anchor);
    const fromName = schedule ? null : frequencyFromName(service, anchor);
    if (!schedule && !fromName) {
      left.push(
        dates.length === 1
          ? `${label}: one visit (${dates[0]}), and the service name does not say how often, so no plan is imported. Add it by hand if it repeats.`
          : weekdaysOf(dates).length >= 3
            ? `${label}: ${dates.length} visits (${dates[0]} to ${dates.at(-1)}) on ${weekdaysOf(dates).join(", ")} each week. A plan here repeats weekly on one day, twice a week, or every few days, so no plan is imported. Add it by hand with its schedule.`
            : `${label}: ${dates.length} visits (${dates[0]} to ${dates.at(-1)}) with no regular spacing, so no plan is imported. Add it by hand with its schedule.`,
      );
      continue;
    }
    // A Sweep&Go plan code ("1d-2xW") says how often the plan is: one a
    // plan here cannot repeat (three times a week, twice a month) is not
    // imported, and one the visits disagree with is not guessed at.
    const code = sweepGoPlanCode(service);
    if (code && !code.frequency) {
      left.push(
        `${label}: the plan code "${service}" says ${codeWords(service)}, which a plan here does not repeat, so it is not imported. Add it by hand with its schedule.`,
      );
      continue;
    }
    const read = parseFrequency(schedule?.text ?? fromName ?? "");
    if (code?.frequency && read && !sameFrequency(code.frequency, read)) {
      left.push(
        `${label}: the plan code "${service}" says ${codeWords(service)}, but its visits are ${(schedule?.text ?? fromName ?? "").toLowerCase()}, so it is not imported. Add it by hand with the schedule that is right.`,
      );
      continue;
    }
    // An initial cleanup is priced on its own; with only those priced, the
    // plan's price per visit is not in the file.
    const regular = usable.filter((v) => !v.initial);
    if (!regular.some((v) => v.cents && v.cents > 0) && usable.some((v) => v.initial && v.cents)) {
      const firsts = usable.filter((v) => v.initial && v.cents).map((v) => money(v.cents!));
      left.push(
        `${label}: only the initial cleanup has a price (${firsts.join(", ")}), and that is not the plan's price per visit, so it is not imported. Add it by hand with its price.`,
      );
      continue;
    }
    const notes = [schedule?.note];
    if (!next && fileHasUpcoming && fileLast && fileLast > dates.at(-1)!) {
      const ended = `No visit is booked after ${dates.at(-1)}, though the file runs to ${fileLast}, so this plan may have ended in the old system. It comes in paused; check it before you turn it on.`;
      notes.push(ended);
      left.push(`${label}: ${ended}`);
    }
    if (leftOut.length) {
      left.push(
        `${label}: ${leftOut.length === 1 ? "a visit" : `${leftOut.length} visits`} canceled or with no date (${leftOut.join(", ")}), not counted toward the plan.`,
      );
    }
    const priced = (vs: Visit[]) => vs.map((v) => v.cents).filter((c): c is number => !!c && c > 0);
    const plain = (vs: Visit[]) => vs.filter((v) => !v.initial);
    const prices = priced(plain(upcoming)).length ? priced(plain(upcoming)) : priced(plain(usable));
    const visitNotes = [
      ...new Set(
        [...usable, ...visits.filter((v) => !usable.includes(v))]
          .filter((v) => v.note)
          .map((v) => `${v.on ?? "no date"}: ${v.note}`),
      ),
    ];
    const row = (next ?? last ?? usable.at(-1)!).row;
    // No price above zero on any visit: the chosen visit's own price, so
    // the plan import refuses a $0 price by name rather than as missing.
    const rowPrice = cols.price ? str(row[cols.price]) : "";
    out.push({
      ...row,
      [VISITS_FREQUENCY_COLUMN]: schedule?.text ?? fromName ?? "",
      [VISITS_FIRST_COLUMN]: dates[0],
      [VISITS_LAST_COLUMN]: last?.on ?? "",
      [VISITS_NEXT_COLUMN]: next?.on ?? "",
      [VISITS_AFTER_NEXT_COLUMN]: afterNext?.on ?? "",
      [VISITS_COUNT_COLUMN]: String(usable.length),
      [VISITS_PRICE_COLUMN]: prices.length ? (mostCommon(prices).value / 100).toFixed(2) : rowPrice,
      [VISITS_NOTES_COLUMN]: visitNotes.join("; "),
      [VISITS_LEFT_OUT_COLUMN]: leftOut.join(", "),
      [VISITS_SCHEDULE_NOTE_COLUMN]: notes.filter(Boolean).join(" "),
    });
  }
  return { rows: out, left };
}

/** The plan rows of planVisitFile alone. */
export function plansFromVisits(
  rows: readonly Row[],
  cols: VisitFileColumns,
  today: string,
  tz?: string | null,
): Row[] {
  return planVisitFile(rows, cols, today, tz).rows;
}
