// Last visit and next visit for a Jobber plan import.
//
// Jobber's Recurring jobs report (Insights > Reports > Recurring jobs) has
// how often ("Visit frequency"), the price ("Total ($)" on a per-visit job)
// and when the schedule began, but no last or next visit. Its Visits report
// has one row per visit with the same "Job #", the visit's "Date", and a
// "Visit completed date" that is "-" until the visit is completed. Both
// columns were read off real exports from a Jobber trial on 2026-11-27.
//
// This joins the two files in the browser, before the preview: each plan row
// gains the job's last completed visit and its next visit still to come, as
// two named columns the services mapping reads (last_visit, next_visit). No
// value is made up: a job with no completed visit gets no last visit, and a
// job with nothing scheduled from today on gets no next visit.

import { parseImportDate } from "@/lib/import-services";

export const JOBBER_LAST_VISIT_COLUMN = "Last visit (Visits report)";
export const JOBBER_NEXT_VISIT_COLUMN = "Next visit (Visits report)";

const JOB = "Job #";
const DATE = "Date";
const COMPLETED = "Visit completed date";

type Row = Record<string, unknown>;

/** True when the headers are Jobber's Visits report: a Job #, a visit Date
 *  and the completed date column. */
export function isJobberVisitsReport(headers: readonly string[]): boolean {
  const lc = new Set(headers.map((h) => h.trim().toLowerCase()));
  return [JOB, DATE, COMPLETED].every((h) => lc.has(h.toLowerCase()));
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function isCompleted(v: unknown): boolean {
  const s = str(v);
  return s !== "" && s !== "-";
}

export type JobberVisitDates = { last: string | null; next: string | null };

/** Per Job #: the latest visit Date that was completed, and the earliest
 *  visit Date on or after `today` (YYYY-MM-DD) that was not. A visit in the
 *  past that was never completed is neither. Rows whose Date cannot be read
 *  are skipped. */
export function jobberVisitDates(
  visitRows: readonly Row[],
  today: string,
): Map<string, JobberVisitDates> {
  const out = new Map<string, JobberVisitDates>();
  for (const r of visitRows) {
    const job = str(r[JOB]);
    const day = parseImportDate(str(r[DATE]));
    if (!job || !day) continue;
    const d = out.get(job) ?? { last: null, next: null };
    if (isCompleted(r[COMPLETED])) {
      if (!d.last || day > d.last) d.last = day;
    } else if (day >= today) {
      if (!d.next || day < d.next) d.next = day;
    }
    out.set(job, d);
  }
  return out;
}

/** The plan rows with the two visit columns added from the Visits report,
 *  matched by Job #. A plan whose job has no visits in the report keeps
 *  both blank. */
export function mergeJobberVisits(
  planRows: readonly Row[],
  visitRows: readonly Row[],
  today: string,
): Row[] {
  const dates = jobberVisitDates(visitRows, today);
  return planRows.map((r) => {
    const d = dates.get(str(r[JOB]));
    return {
      ...r,
      [JOBBER_LAST_VISIT_COLUMN]: d?.last ?? "",
      [JOBBER_NEXT_VISIT_COLUMN]: d?.next ?? "",
    };
  });
}

/** The owner's mapping after the Visits report is added (`on`) or taken
 *  away: every other column keeps the destination the owner gave it. Added,
 *  the two visit columns go to last and next visit unless those already
 *  read another column; taken away, any field that read them is let go. */
export function withVisitMapping(
  mapping: Record<string, string | null>,
  on: boolean,
): Record<string, string | null> {
  const next = { ...mapping };
  const visitColumns = [JOBBER_LAST_VISIT_COLUMN, JOBBER_NEXT_VISIT_COLUMN];
  if (on) {
    if (!next.last_visit) next.last_visit = JOBBER_LAST_VISIT_COLUMN;
    if (!next.next_visit) next.next_visit = JOBBER_NEXT_VISIT_COLUMN;
    return next;
  }
  for (const [field, col] of Object.entries(next)) {
    if (col && visitColumns.includes(col)) next[field] = null;
  }
  return next;
}
