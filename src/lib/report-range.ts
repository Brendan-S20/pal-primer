// The Reports page's date range: its presets, and how a day in it is shown.
//
// QA row 43: the page offered two date fields and nothing else, and printed
// the range as "2026-09-16 → 2026-10-15". The common question is "how did this
// month go" or "how did last month go", so those are one tap, and the dates
// read the way the person's own locale writes them.
//
// Days are built from the LOCAL calendar. The old default used
// `toISOString().slice(0, 10)`, which is the UTC day: from 7pm in Chicago that
// is already tomorrow.

export type ReportRange = { from: string; to: string };
export type ReportPreset = "last30" | "thisMonth" | "lastMonth";

export const REPORT_PRESETS: { id: ReportPreset; label: string }[] = [
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "last30", label: "Last 30 days" },
];

function isoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function presetRange(preset: ReportPreset, today: Date = new Date()): ReportRange {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case "thisMonth":
      return { from: isoDay(new Date(y, m, 1)), to: isoDay(today) };
    case "lastMonth":
      // Day 0 of this month is the last day of the previous one.
      return { from: isoDay(new Date(y, m - 1, 1)), to: isoDay(new Date(y, m, 0)) };
    case "last30": {
      const from = new Date(y, m, today.getDate() - 29);
      return { from: isoDay(from), to: isoDay(today) };
    }
  }
}

/** Which preset a range is, if it is one, so its button can show as chosen. */
export function matchingPreset(range: ReportRange, today: Date = new Date()): ReportPreset | null {
  for (const p of REPORT_PRESETS) {
    const r = presetRange(p.id, today);
    if (r.from === range.from && r.to === range.to) return p.id;
  }
  return null;
}

/** "Oct 1, 2026" in en-US, "1 oct 2026" in es, and so on. A YYYY-MM-DD day
 *  is anchored at noon so no time zone can move it across midnight. */
export function formatReportDay(day: string, locale?: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T12:00:00`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(locale ?? [], { month: "short", day: "numeric", year: "numeric" });
}
