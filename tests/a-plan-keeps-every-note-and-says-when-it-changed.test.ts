// Rigel's review of #1069 at 0545ace1: four cases, on the real export
// columns, that still lost a note, read the wrong plan or added a client.
//
// 1. The same note on 53 visits filled the 4,000-character client note, and
//    the one new gate code at the end was cut off.
// 2. Tuesdays and Fridays, then only Fridays booked (or Fridays, then a
//    Tuesday and a Friday): the change was missed with no word.
// 3. Every four weeks with one visit skipped read as monthly on a weekday.
// 4. A name two clients share, in a file of names alone, added a third.
//
// And two smaller ones from the same review: a Sweep&Go initial cleanup on
// another weekday made a weekly plan look twice weekly, and weekly visits
// followed by two booked two weeks apart said nothing.
//
// At 64eb54c9: twice a week, then two Fridays, read weekly with no warning;
// a note's dates were not sorted; a booked initial cleanup was called moved.

import { describe, expect, it } from "vitest";

import { clientDuplicateIndex, labelClientRows } from "@/lib/import-commit-guard";
import { mapServiceRow, planVisitsNote } from "@/lib/import-services";
import { NOTE_MAX, splitNote } from "@/lib/import-leftovers";
import { autoMap } from "@/lib/imports.functions";
import {
  planVisitFile,
  visitFileColumns,
  VISITS_COLUMNS,
  VISITS_NEXT_COLUMN,
  VISITS_NOTES_COLUMN,
  VISITS_SCHEDULE_NOTE_COLUMN,
} from "@/lib/import-visit-plans";
import { scheduleFromDates } from "@/lib/import-visit-frequency";

const TODAY = "2026-11-27";
const TZ = "America/Detroit";

const HCP = [
  "Customer name",
  "Job description",
  "Job status",
  "Job scheduled start date",
  "Total service price",
  "Street",
  "Recurring",
  "Notes",
];

function hcp(dates: string[], noteOf: (on: string, i: number) => string = () => "") {
  const rows = dates.map((on, i) => ({
    "Customer name": "Sam Research",
    "Job description": "Pet Waste Cleanup",
    "Job status": on < TODAY ? "Completed" : "Scheduled",
    "Job scheduled start date": `${on}T09:00:00-05:00`,
    "Total service price": "$18.50",
    Street: "123 Test St",
    Recurring: "true",
    Notes: noteOf(on, i),
  }));
  const read = planVisitFile(rows, visitFileColumns("housecall_pro", HCP)!, TODAY, TZ);
  const mapping = autoMap("housecall_pro", [...HCP, ...VISITS_COLUMNS], "services");
  const plans = read.rows.map(
    (r) => mapServiceRow(r as Record<string, string>, mapping, TZ).mapped!,
  );
  return { ...read, plans };
}

const SWEEPGO = [
  "Client Type",
  "Status",
  "Job Type",
  "Service Date",
  "Client First Name",
  "Client Last Name",
  "Location Name",
  "Address",
  "Field Tech",
  "Service",
  "Revenue",
];

const every = (from: string, n: number, step = 7) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * step);
    return d.toISOString().slice(0, 10);
  });
const onWeekdays = (from: string, to: string, days: number[]) =>
  every(from, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1, 1).filter((d) =>
    days.includes(new Date(`${d}T00:00:00Z`).getUTCDay()),
  );

describe("1. a long run of visit notes is kept, not cut", () => {
  const GATE =
    "Side gate sticks; lift it before you pull. Two dogs, both friendly, let them sniff.";
  it("the same note on 52 visits is kept once, and the new one at the end is kept too", () => {
    const dates = every("2025-12-05", 53);
    const r = hcp(dates, (_, i) =>
      i === 52 ? "NEW gate code 9026 from this date" : `${GATE} Code 1111.`,
    );
    const notes = r.rows[0][VISITS_NOTES_COLUMN];
    expect(notes).toContain(`52 visits, ${dates[0]} to ${dates[51]}: ${GATE} Code 1111.`);
    expect(notes).toContain(`${dates[52]}: NEW gate code 9026 from this date`);
    expect(notes.length).toBeLessThan(400);
  });

  it("a note's dates run first to last, with a canceled first visit too", () => {
    const dates = every("2026-11-13", 53);
    const rows = dates.map((on, i) => ({
      "Customer name": "Sam Research",
      "Job description": "Pet Waste Cleanup",
      "Job status": i === 0 ? "Canceled" : on < TODAY ? "Completed" : "Scheduled",
      "Job scheduled start date": `${on}T09:00:00-05:00`,
      "Total service price": "$18.50",
      Street: "123 Test St",
      Recurring: "true",
      Notes: GATE,
    }));
    const read = planVisitFile(rows, visitFileColumns("housecall_pro", HCP)!, TODAY, TZ);
    expect(read.rows[0][VISITS_NOTES_COLUMN]).toBe(
      `53 visits, 2026-11-13 to ${dates[52]}: ${GATE}`,
    );
  });

  it("a plan note longer than one note holds is split, with nothing lost", () => {
    const text = Array.from({ length: 120 }, (_, i) => `2026-01-${i}: note number ${i} here.`)
      .join("; ")
      .concat(" NEW gate code 9026");
    const parts = splitNote(text);
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.length <= NOTE_MAX)).toBe(true);
    expect(parts[0]).toMatch(/^\(1 of 2\) /);
    expect(parts[1]).toMatch(/^\(2 of 2\) .*NEW gate code 9026$/);
    const words = (s: string) =>
      s
        .replace(/\(\d of \d\) /g, "")
        .split(/[\s;]+/)
        .filter(Boolean);
    expect(words(parts.join(" "))).toEqual(words(text));
    expect(splitNote("short")).toEqual(["short"]);
  });
});

describe("2. a twice-weekly plan that changed is not missed", () => {
  it("Tuesdays and Fridays, then only Fridays booked: weekly on Fridays", () => {
    const before = onWeekdays("2026-09-01", "2026-11-26", [2, 5]);
    const r = hcp([...before, "2026-12-04", "2026-12-11"]);
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", preferred_weekdays: [5] });
    // Two Fridays cannot say whether a Tuesday was skipped: flagged (64eb54c9).
    expect(r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).toMatch(
      /on Fridays only.*a visit is skipped, or the plan is now weekly/,
    );
    expect(r.left.some((l) => l.includes("the plan is now weekly"))).toBe(true);
  });

  it("Tuesdays and Fridays, then Nov 27 and Dec 4 (Dec 1 not booked): flagged", () => {
    const before = onWeekdays("2026-09-01", "2026-11-26", [2, 5]);
    const r = hcp([...before, "2026-11-27", "2026-12-04"]);
    const warn = r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN];
    expect(warn).toMatch(/next two visits \(2026-11-27 and 2026-12-04\) are on Fridays only/);
    expect(warn).toMatch(/twice a week on tuesdays and fridays/);
    expect(warn).toMatch(/check it before you turn the plan on/);
    expect(r.left.some((l) => l.includes("the plan is now weekly"))).toBe(true);
  });

  it("Fridays, then a Tuesday and a Friday booked: imported, with a warning on it", () => {
    const r = hcp([...every("2026-09-04", 12), "2026-12-01", "2026-12-04"]);
    const warn = r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN];
    expect(warn).toMatch(
      /next two visits \(2026-12-01 and 2026-12-04\) do not follow its earlier visits \(weekly on fridays\)/,
    );
    expect(warn).toMatch(/check it before you turn the plan on/);
    expect(r.left.some((l) => l.includes("may have changed"))).toBe(true);
  });

  it("Tuesdays and Fridays, still booked on both: twice a week, no warning", () => {
    const before = onWeekdays("2026-09-01", "2026-11-26", [2, 5]);
    const r = hcp([...before, "2026-12-01", "2026-12-04"]);
    expect(r.plans[0]).toMatchObject({ frequency: "twice_weekly" });
    expect(r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).toBe("");
  });

  it("weekly, then two booked two weeks apart: weekly, with a warning that says why", () => {
    const r = hcp([...every("2026-09-04", 12), "2026-12-04", "2026-12-18"]);
    expect(r.plans[0]).toMatchObject({ frequency: "weekly" });
    expect(r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).toMatch(
      /2 weeks apart.*a visit is skipped, or the plan is now every 2 weeks/,
    );
  });
});

describe("3. every four weeks with a visit skipped stays every four weeks", () => {
  it("Oct 28, Nov 25, Dec 23 and Feb 17 is every 4 weeks on Wednesdays", () => {
    const dates = ["2026-10-28", "2026-11-25", "2026-12-23", "2027-02-17"];
    expect(scheduleFromDates(dates)?.text).toBe("Every 4 weeks on Wednesdays");
    const r = hcp(dates);
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", interval_weeks: 4 });
    expect(r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).not.toMatch(/fourth Wednesday/);
  });

  it("with two upcoming visits too", () => {
    const dates = ["2026-08-05", "2026-09-02", "2026-09-30", "2026-11-25", "2026-12-23"];
    expect(scheduleFromDates(dates)?.text).toBe("Every 4 weeks on Wednesdays");
    expect(hcp([...dates, "2027-01-20"]).plans[0]).toMatchObject({ interval_weeks: 4 });
  });

  it("the second Friday with a month skipped is still monthly", () => {
    const dates = ["2026-10-09", "2026-11-13", "2027-01-08", "2027-02-12"];
    expect(scheduleFromDates(dates)?.text).toMatch(/^Monthly on the/);
  });
});

describe("4. a name two clients share is skipped, not added again", () => {
  it("skips the row and says why", () => {
    const idx = clientDuplicateIndex(
      [
        { id: "a", display_name: "Sam Research" },
        { id: "b", display_name: "Sam Research" },
      ] as any,
      "sweepgo",
    );
    idx.nameAlone = true;
    const [label] = labelClientRows([{ display_name: "Sam Research" } as any], idx, "sweepgo");
    expect(label).toMatchObject({ action: "skip", targetId: null });
    expect(label!.reason).toMatch(/More than one of your clients has this name/);
  });
});

describe("smaller: an initial cleanup is not on the plan's schedule", () => {
  it("a Tuesday initial, then two Friday regular visits: weekly on Fridays", () => {
    const jobs = [
      { on: "2026-12-01", kind: "Initial", revenue: "98.00" },
      { on: "2026-12-04", kind: "Regular", revenue: "23.00" },
      { on: "2026-12-11", kind: "Regular", revenue: "23.00" },
    ];
    const rows = jobs.map((j) => ({
      "Client Type": "Residential",
      Status: "dispatched",
      "Job Type": j.kind,
      "Service Date": j.on,
      "Client First Name": "Dana",
      "Client Last Name": "Placeholder",
      "Location Name": "",
      Address: "101 Test Lane, Austin",
      "Field Tech": "Import Research",
      Service: "1d-1xW",
      Revenue: j.revenue,
    }));
    const read = planVisitFile(rows, visitFileColumns("sweepgo", SWEEPGO)!, TODAY, TZ);
    const mapping = autoMap("sweepgo", [...SWEEPGO, ...VISITS_COLUMNS], "services");
    const plan = mapServiceRow(read.rows[0] as Record<string, string>, mapping, TZ).mapped!;
    expect(plan).toMatchObject({ frequency: "weekly", preferred_weekdays: [5] });
    expect(plan.price_cents).toBe(2300);
    // The initial cleanup is a one-off to add, not a moved visit (64eb54c9).
    expect(read.rows[0][VISITS_NEXT_COLUMN]).toBe("2026-12-04");
    expect(planVisitsNote("Sweep&Go", plan)).not.toMatch(/moved/);
    expect(read.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).toMatch(
      /initial cleanup booked for 2026-12-01 is not on the plan's schedule.*Add it as a one-time visit/,
    );
    expect(read.left.some((l) => l.includes("initial cleanup booked for 2026-12-01"))).toBe(true);
  });
});
