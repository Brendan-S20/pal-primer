// One visit moved by hand in Jobber must not move every visit after it
// (Rigel's review of #1069, 2026-11-27). He moved one visit in the real
// Visits export and the plan was walked from it: an every-2-weeks plan landed
// on the wrong weeks, a monthly plan on the wrong day of the month. These run
// the same edits on the real exports in tests/fixtures/imports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { autoMap } from "@/lib/imports.functions";
import { mapServiceRow, planVisitsNote } from "@/lib/import-services";
import { planAnchor, sameSchedule } from "@/lib/import-plan-anchor";
import {
  JOBBER_AFTER_NEXT_COLUMN,
  JOBBER_LAST_VISIT_COLUMN,
  JOBBER_NEXT_VISIT_COLUMN,
  mergeJobberVisits,
  withVisitMapping,
} from "@/lib/import-jobber-visits";

type Row = Record<string, string>;
const FIXTURES = join(import.meta.dirname, "fixtures", "imports");
const TODAY = "2026-11-27";
function fixture(name: string): { headers: string[]; rows: Row[] } {
  const parsed = Papa.parse<Row>(readFileSync(join(FIXTURES, name), "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

const plans = fixture("jobber-recurring-jobs.csv");
const visits = fixture("jobber-visits.csv");
const mapping = autoMap(
  "jobber",
  [...plans.headers, JOBBER_LAST_VISIT_COLUMN, JOBBER_NEXT_VISIT_COLUMN],
  "services",
);

/** The real Visits export with one job's visit on `from` moved to `to`. */
function moved(job: string, from: string, to: string): Row[] {
  let hit = 0;
  const out = visits.rows.map((r) => {
    if (r["Job #"] !== job || r.Date !== from) return r;
    hit++;
    return { ...r, Date: to };
  });
  expect(hit).toBe(1);
  return out;
}

function planFor(client: string, visitRows: Row[]) {
  const joined = mergeJobberVisits(plans.rows, visitRows, TODAY) as Row[];
  const res = mapServiceRow(
    joined.find((r) => r["Client name"] === client)!,
    mapping,
  );
  expect(res.error).toBeNull();
  return res.mapped!;
}

describe("a plan whose next visit was moved once is walked from its regular schedule", () => {
  it("every 2 weeks on Fridays, Nov 27 done on Saturday Nov 28: still Fridays on the right weeks", () => {
    const m = planFor("Marcus Fixture", moved("2", "Nov 27, 2026", "Nov 28, 2026"));
    expect(m).toMatchObject({
      next_visit: "2026-11-28",
      last_visit: "2026-11-13",
      started_on: "2026-11-13",
      anchor_from: "last visit",
      off_schedule: [{ which: "next visit", on: "2026-11-28" }],
    });
    // Nov 13 + 14 days is Nov 27, then Dec 11: Jobber's regular Fridays.
    expect(planVisitsNote("Jobber", m)).toMatch(
      /set from the last visit \(2026-11-13\)\. The next visit \(2026-11-28\) is off that schedule, so it was likely moved once in Jobber/,
    );
  });

  it("monthly on the 10th, Dec 10 moved to Dec 12: still the 10th", () => {
    const m = planFor("Dana Placeholder", moved("3", "Dec 10, 2026", "Dec 12, 2026"));
    expect(m).toMatchObject({ started_on: "2026-11-10", anchor_from: "last visit" });
    expect(m.off_schedule).toEqual([{ which: "next visit", on: "2026-12-12" }]);
  });

  it("weekly on Tuesdays, Dec 1 moved to Wednesday Dec 2: still Tuesdays, from the last one", () => {
    const m = planFor("Priya Sample", moved("1", "Dec 01, 2026", "Dec 02, 2026"));
    expect(m).toMatchObject({ started_on: "2026-11-03", anchor_from: "last visit" });
    expect(m.off_schedule).toEqual([{ which: "next visit", on: "2026-12-02" }]);
  });

  it("a moved last visit is not trusted either", () => {
    const m = planFor("Marcus Fixture", moved("2", "Nov 13, 2026", "Nov 14, 2026"));
    expect(m).toMatchObject({ started_on: "2026-11-27", anchor_from: "next visit" });
    expect(m.off_schedule).toEqual([{ which: "last visit", on: "2026-11-14" }]);
  });

  it("the unedited export still walks every plan from its next visit, with nothing off schedule", () => {
    for (const [client, next] of [
      ["Priya Sample", "2026-12-01"],
      ["Marcus Fixture", "2026-11-27"],
      ["Dana Placeholder", "2026-12-10"],
    ]) {
      const m = planFor(client, visits.rows);
      expect(m).toMatchObject({ started_on: next, anchor_from: "next visit", off_schedule: [] });
      expect(planVisitsNote("Jobber", m)).not.toMatch(/off that schedule/);
    }
  });

  it("a whole schedule moved since it began follows the visits, not the old start date", () => {
    // Every one of Dana's visits moved from the 10th to the 12th.
    const all = visits.rows.map((r) =>
      r["Job #"] === "3" ? { ...r, Date: r.Date.replace(" 10,", " 12,") } : r,
    );
    const m = planFor("Dana Placeholder", all);
    expect(m).toMatchObject({ started_on: "2026-12-12", anchor_from: "next visit" });
    expect(m.off_schedule).toEqual([]);
  });
});

describe("the schedule test itself", () => {
  const weekly = { frequency: "weekly" as const, weekdays: [2] };
  it("reads weeks, intervals and days of the month", () => {
    expect(sameSchedule("2026-11-03", "2026-12-01", weekly)).toBe(true);
    expect(sameSchedule("2026-11-03", "2026-12-02", weekly)).toBe(false);
    const every2 = { frequency: "biweekly" as const, weekdays: [5] };
    expect(sameSchedule("2026-11-13", "2026-11-27", every2)).toBe(true);
    expect(sameSchedule("2026-11-13", "2026-11-20", every2)).toBe(false);
    const every3 = { frequency: "weekly" as const, intervalWeeks: 3, weekdays: [1] };
    expect(sameSchedule("2026-11-02", "2026-11-23", every3)).toBe(true);
    expect(sameSchedule("2026-11-02", "2026-11-16", every3)).toBe(false);
    const monthly = { frequency: "monthly" as const };
    expect(sameSchedule("2026-10-31", "2026-11-30", monthly)).toBe(true);
    expect(sameSchedule("2026-11-10", "2026-12-12", monthly)).toBe(false);
    const tenDays = { frequency: "every_n_days" as const, intervalDays: 10 };
    expect(sameSchedule("2026-11-01", "2026-11-21", tenDays)).toBe(true);
    expect(sameSchedule("2026-11-01", "2026-11-22", tenDays)).toBe(false);
  });

  it("with no two dates agreeing, the plan keeps the file's start date", () => {
    const a = planAnchor({
      frequency: "weekly",
      intervalWeeks: null,
      intervalDays: null,
      weekdays: [],
      frequencyInFile: true,
      start: "2026-09-01",
      last: "2026-11-05",
      next: "2026-12-04",
    });
    expect(a).toMatchObject({ on: "2026-09-01", from: "start date" });
    expect(a.off.map((o) => o.which)).toEqual(["next visit", "last visit"]);
  });
});

describe('"-", "N/A" or "Never" in a visit column is no visit, not a refused row', () => {
  const generic = {
    client_name: "Client",
    frequency: "Frequency",
    price_per_visit: "Price",
    last_visit: "Last Service",
    next_visit: "Next Cleanup",
  };
  for (const blank of ["-", "N/A", "n/a", "Never", "None", "—"]) {
    it(`"${blank}"`, () => {
      const res = mapServiceRow(
        {
          Client: "Sam Research",
          Frequency: "Weekly",
          Price: "18",
          "Last Service": blank,
          "Next Cleanup": blank,
        },
        generic,
      );
      expect(res.error).toBeNull();
      expect(res.mapped).toMatchObject({ frequency: "weekly", price_cents: 1800 });
      expect(res.mapped!.last_visit).toBeUndefined();
    });
  }
  it("a date that cannot be read is still refused, quoted", () => {
    const res = mapServiceRow(
      { Client: "Sam", Frequency: "Weekly", Price: "18", "Last Service": "last spring" },
      generic,
    );
    expect(res.error).toBe('Last visit not understood: "last spring"');
  });
});

describe("adding or removing the Visits report keeps the owner's own choices", () => {
  const owner = { ...mapping, last_visit: null, next_visit: null, price_per_visit: "Subtotal ($)" };
  it("added: only the visit fields change", () => {
    const next = withVisitMapping(owner, true);
    expect(next).toEqual({
      ...owner,
      last_visit: JOBBER_LAST_VISIT_COLUMN,
      next_visit: JOBBER_NEXT_VISIT_COLUMN,
      visit_after_next: JOBBER_AFTER_NEXT_COLUMN,
    });
  });
  it("added when the owner already chose a column for last visit: that choice stays", () => {
    const next = withVisitMapping({ ...owner, last_visit: "Closed date" }, true);
    expect(next.last_visit).toBe("Closed date");
    expect(next.next_visit).toBe(JOBBER_NEXT_VISIT_COLUMN);
  });
  it("removed: the visit fields are let go and the price column stays the owner's", () => {
    const next = withVisitMapping(withVisitMapping(owner, true), false);
    expect(next).toEqual(owner);
  });
});
