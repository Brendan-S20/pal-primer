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

import { parseFrequency, parseImportDate } from "@/lib/import-services";

export const VISITS_FREQUENCY_COLUMN = "How often (from the visits)";
export const VISITS_FIRST_COLUMN = "First visit (from the visits)";
export const VISITS_LAST_COLUMN = "Last visit (from the visits)";
export const VISITS_NEXT_COLUMN = "Next visit (from the visits)";
export const VISITS_AFTER_NEXT_COLUMN = "Visit after next (from the visits)";
export const VISITS_COUNT_COLUMN = "Visits in the file";
export const VISITS_COLUMNS = [
  VISITS_FREQUENCY_COLUMN,
  VISITS_FIRST_COLUMN,
  VISITS_LAST_COLUMN,
  VISITS_NEXT_COLUMN,
  VISITS_AFTER_NEXT_COLUMN,
  VISITS_COUNT_COLUMN,
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
};

type Spec = { [K in keyof VisitFileColumns]-?: string[] } & { signature: string[] };

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
      clientLast: [],
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
      clientLast: [],
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
  const find = (names: string[]) =>
    names
      .map((n) => headers.find((h) => h.trim().toLowerCase() === n.toLowerCase()))
      .find(Boolean) ?? null;
  for (const spec of VISIT_FILES[source] ?? []) {
    if (!spec.signature.every((s) => find([s]))) continue;
    return {
      client: find(spec.client)!,
      service: find(spec.service),
      date: find(spec.date)!,
      status: find(spec.status),
      street: find(spec.street),
      ...(spec.clientLast.length ? { clientLast: find(spec.clientLast) } : {}),
    };
  }
  return null;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
const weekday = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const dayOfMonth = (iso: string) => Number(iso.slice(8, 10));
const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

function mostCommon(nums: number[]): number {
  const counts = new Map<number, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
}

/** How often a run of visit dates (sorted, distinct) recurs, in the words
 *  the plan import reads ("Weekly on Fridays"), or null when two dates are
 *  not enough or the spacing has no pattern. */
export function frequencyFromDates(dates: readonly string[]): string | null {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => dayNumber(d) - dayNumber(dates[i]));
  const doms = new Set(dates.map(dayOfMonth));
  if (doms.size === 1 && gaps.every((g) => g >= 28 && g <= 31)) {
    return `Monthly on the ${ordinal(dayOfMonth(dates[0]))} day of the month`;
  }
  const days = [...new Set(dates.map(weekday))].sort((a, b) => a - b);
  if (days.length === 1) {
    const g = mostCommon(gaps);
    const on = `on ${DAY_NAMES[days[0]]}s`;
    if (g === 7) return `Weekly ${on}`;
    if (g % 7 === 0) return `Every ${g / 7} weeks ${on}`;
    return `Every ${g} days`;
  }
  if (days.length === 2 && mostCommon(gaps) < 7) {
    return `Twice a week on ${DAY_NAMES[days[0]]}s and ${DAY_NAMES[days[1]]}s`;
  }
  return null;
}

/** The service's own name read as a frequency, on the weekday of its one
 *  visit: "Every Other Week Pet Waste Cleanup" on a Friday is "Every 2
 *  weeks on Fridays". Null when the name says nothing about how often. */
function frequencyFromName(name: string, dates: readonly string[]): string | null {
  const f = parseFrequency(name);
  if (!f || f.frequency === "one_time") return null;
  const day = dates.length ? DAY_NAMES[weekday(dates[0])] : null;
  const on = day ? ` on ${day}s` : "";
  const said = `, from the service name "${name}"`;
  if (f.frequency === "weekly" && (f.intervalWeeks ?? 1) > 1) {
    return `Every ${f.intervalWeeks} weeks${on}${said}`;
  }
  if (f.frequency === "weekly") return `Weekly${on}${said}`;
  if (f.frequency === "biweekly") return `Every 2 weeks${on}${said}`;
  if (f.frequency === "monthly") {
    const dom = dates.length ? ` on the ${ordinal(dayOfMonth(dates[0]))} day of the month` : "";
    return `Monthly${dom}${said}`;
  }
  if (f.frequency === "every_n_days") return `Every ${f.intervalDays} days${said}`;
  return null;
}

const DONE = /complet|done|finished/i;
const CALLED_OFF = /cancel|no[- ]?show|skipped|declined|deleted/i;

/** One row per client, service and address, as described above. `today`
 *  is the business's day (YYYY-MM-DD); `tz` reads a timestamp with a zone
 *  on the business's clock. Rows with no client or no readable date are
 *  left out of the plan they would belong to. */
export function plansFromVisits(
  rows: readonly Row[],
  cols: VisitFileColumns,
  today: string,
  tz?: string | null,
): Row[] {
  type Visit = { row: Row; on: string; done: boolean };
  const groups = new Map<string, Visit[]>();
  const clientOf = (row: Row) =>
    [str(row[cols.client]), cols.clientLast ? str(row[cols.clientLast]) : ""]
      .filter(Boolean)
      .join(" ");
  for (const row of rows) {
    const client = clientOf(row);
    const on = parseImportDate(str(row[cols.date]), tz);
    const status = cols.status ? str(row[cols.status]) : "";
    if (!client || !on || CALLED_OFF.test(status)) continue;
    const key = [
      client,
      cols.service ? str(row[cols.service]) : "",
      cols.street ? str(row[cols.street]) : "",
    ]
      .map((s) => s.toLowerCase())
      .join("\u0000");
    const list = groups.get(key) ?? [];
    list.push({ row, on, done: cols.status ? DONE.test(status) : on < today });
    groups.set(key, list);
  }
  const out: Row[] = [];
  for (const visits of groups.values()) {
    visits.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
    const dates = [...new Set(visits.map((v) => v.on))];
    const last = visits.filter((v) => v.done).at(-1) ?? null;
    const upcoming = visits.filter((v) => !v.done && v.on >= today);
    const next = upcoming[0] ?? null;
    const afterNext = upcoming.find((v) => v.on > (next?.on ?? "")) ?? null;
    const row = (next ?? last ?? visits.at(-1)!).row;
    const service = cols.service ? str(row[cols.service]) : "";
    out.push({
      ...row,
      [VISITS_FREQUENCY_COLUMN]:
        frequencyFromDates(dates) ?? frequencyFromName(service, dates) ?? "",
      [VISITS_FIRST_COLUMN]: dates[0],
      [VISITS_LAST_COLUMN]: last?.on ?? "",
      [VISITS_NEXT_COLUMN]: next?.on ?? "",
      [VISITS_AFTER_NEXT_COLUMN]: afterNext?.on ?? "",
      [VISITS_COUNT_COLUMN]: String(visits.length),
    });
  }
  return out;
}
