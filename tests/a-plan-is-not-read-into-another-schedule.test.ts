// Rigel's reviews of #1069 at 8ee24911 and 23d432bc: plans read off a visits
// file onto the wrong schedule, or with a note saying visits moved that did
// not; a Sweep&Go plan code that says one thing while the visits say
// another; the initial cleanup's price taken as the plan's; a unit number
// matched to the street without it; and a file of names alone that made a
// second copy of every client. Rows are shaped like the real exports in
// tests/fixtures/imports.

import { describe, expect, it } from "vitest";

import { clientDuplicateIndex, findExistingClient } from "@/lib/import-commit-guard";
import { mapServiceRow, pickPlanProperty, planVisitsNote } from "@/lib/import-services";
import { autoMap } from "@/lib/imports.functions";
import { planVisitFile, visitFileColumns, VISITS_COLUMNS } from "@/lib/import-visit-plans";
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

function hcp(dates: string[]) {
  const rows = dates.map((on) => ({
    "Customer name": "Sam Research",
    "Job description": "Pet Waste Cleanup",
    "Job status": on < TODAY ? "Completed" : "Scheduled",
    "Job scheduled start date": `${on}T09:00:00-05:00`,
    "Total service price": "$18.50",
    Street: "123 Test St",
    Recurring: "true",
    Notes: "",
  }));
  const read = planVisitFile(rows, visitFileColumns("housecall_pro", HCP)!, TODAY, TZ);
  const mapping = autoMap("housecall_pro", [...HCP, ...VISITS_COLUMNS], "services");
  const plans = read.rows.map(
    (r) => mapServiceRow(r as Record<string, string>, mapping, TZ).mapped!,
  );
  return { ...read, plans, notes: plans.map((p) => planVisitsNote("Housecall Pro", p)) };
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
type Job = { on: string; code?: string; kind?: string; revenue?: string };
function sweepgo(jobs: Job[]) {
  const rows = jobs.map((j) => ({
    "Client Type": "Residential",
    Status: j.on < TODAY ? "completed" : "dispatched",
    "Job Type": j.kind ?? "Regular",
    "Service Date": j.on,
    "Client First Name": "Dana",
    "Client Last Name": "Placeholder",
    "Location Name": "",
    Address: "101 Test Lane, Austin",
    "Field Tech": "Import Research",
    Service: j.code ?? "1d-1xW",
    Revenue: j.revenue ?? "23.00",
  }));
  const read = planVisitFile(rows, visitFileColumns("sweepgo", SWEEPGO)!, TODAY, TZ);
  const mapping = autoMap("sweepgo", [...SWEEPGO, ...VISITS_COLUMNS], "services");
  return {
    ...read,
    plans: read.rows.map((r) => mapServiceRow(r as Record<string, string>, mapping, TZ)),
  };
}

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

describe("the schedule is the one the visits keep", () => {
  it("monthly on the second Friday: no visit on a second Friday is called moved", () => {
    const r = hcp([
      "2026-10-09",
      "2026-11-13",
      "2026-12-11",
      "2027-01-08",
      "2027-02-12",
      "2027-03-12",
    ]);
    expect(r.plans[0]).toMatchObject({ frequency: "monthly", started_on: "2026-12-11" });
    expect(r.plans[0].off_schedule).toEqual([]);
    expect(r.notes[0]).not.toMatch(/moved/);
  });

  it("walks Monday to Friday, or Monday to Saturday, are not daily", () => {
    for (const days of [
      [1, 2, 3, 4, 5],
      [1, 2, 3, 4, 5, 6],
    ]) {
      const r = hcp(onWeekdays("2026-11-02", "2026-12-18", days));
      expect(r.rows).toEqual([]);
      expect(r.left[0]).toMatch(/on Mondays, Tuesdays, Wednesdays, Thursdays, Fridays.* each week/);
      expect(r.left[0]).toMatch(/so no plan is imported/);
    }
    expect(scheduleFromDates(every("2026-11-02", 21, 1))?.text).toBe("Every 1 days");
  });

  it("Fridays until now, then two Tuesdays booked: weekly on Tuesdays from the first", () => {
    const r = hcp([...every("2026-09-04", 12), "2026-12-01", "2026-12-08"]);
    expect(r.plans[0]).toMatchObject({
      frequency: "weekly",
      preferred_weekdays: [2],
      started_on: "2026-12-01",
    });
    expect(r.notes[0]).not.toMatch(/likely moved/);
  });

  it("every 2 weeks until now, then two visits a week apart: weekly", () => {
    const r = hcp([...every("2026-08-14", 8, 14), "2026-11-27", "2026-12-04"]);
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", started_on: "2026-11-27" });
    expect(r.notes[0]).not.toMatch(/likely moved/);
  });

  it("weekly, with two booked visits two weeks apart (one skipped): still weekly", () => {
    const r = hcp([...every("2026-10-02", 8), "2026-12-04", "2026-12-18"]);
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", preferred_weekdays: [5] });
  });

  it("every 4 weeks across a short February is not monthly on the 5th", () => {
    expect(scheduleFromDates(["2027-01-08", "2027-02-05", "2027-03-05"])?.text).toBe(
      "Every 4 weeks on Fridays",
    );
    expect(scheduleFromDates(["2027-01-05", "2027-02-05", "2027-03-05"])?.text).toBe(
      "Monthly on the 5th day of the month",
    );
  });
});

describe("Sweep&Go's Completed Jobs: the plan code and the price", () => {
  it("1d-2xW on Tuesdays and Fridays is twice a week", () => {
    const dates = onWeekdays("2026-11-03", "2026-12-18", [2, 5]);
    const r = sweepgo(dates.map((on) => ({ on, code: "1d-2xW" })));
    expect(r.plans[0].mapped).toMatchObject({
      frequency: "twice_weekly",
      preferred_weekdays: [2, 5],
    });
  });

  it("codes a plan here cannot repeat are listed, not imported", () => {
    for (const [code, words] of [
      ["1d-3xW", "3 times a week"],
      ["1d-5xW", "5 times a week"],
      ["1d-2xM", "twice a month"],
    ]) {
      const r = sweepgo(every("2026-11-06", 6).map((on) => ({ on, code })));
      expect(r.rows).toEqual([]);
      expect(r.left[0]).toContain(`the plan code "${code}" says ${words}, which a plan here`);
    }
  });

  it("a code the visits disagree with is not guessed at", () => {
    const r = sweepgo(every("2026-11-06", 6).map((on) => ({ on, code: "1d-2xW" })));
    expect(r.rows).toEqual([]);
    expect(r.left[0]).toMatch(/says twice a week, but its visits are weekly on fridays/);
  });

  it("the initial cleanup's price is not the plan's", () => {
    const r = sweepgo([
      { on: "2026-11-27", kind: "Initial", revenue: "98.00" },
      ...every("2026-12-04", 3).map((on) => ({ on })),
    ]);
    expect(r.plans[0].mapped).toMatchObject({ frequency: "weekly", price_cents: 2300 });
  });

  it("with only the initial cleanup priced, the plan is listed for a price", () => {
    const r = sweepgo([
      { on: "2026-11-27", kind: "Initial", revenue: "98.00" },
      ...every("2026-12-04", 3).map((on) => ({ on, revenue: "0.00" })),
    ]);
    expect(r.rows).toEqual([]);
    expect(r.left[0]).toMatch(/only the initial cleanup has a price \(\$98\.00\)/);
  });

  it("a visits file row with no frequency is not weekly from the file", () => {
    const mapping = autoMap("sweepgo", [...SWEEPGO, ...VISITS_COLUMNS], "services");
    const row = {
      "Client First Name": "Dana",
      "Client Last Name": "Placeholder",
      Service: "Regular",
      "Price per visit (from the visits)": "23.00",
      "How often (from the visits)": "",
    };
    expect(mapServiceRow(row, mapping, TZ).mapped).toMatchObject({ frequency_in_file: false });
  });
});

describe("addresses and names", () => {
  it("a unit is not the street without it", () => {
    const props = [{ street: "303 Fixture Court" }];
    expect(pickPlanProperty(props, "303 Fixture Court Unit 4").matched).toBe(false);
    expect(pickPlanProperty(props, "303 Fixture Court #4").matched).toBe(false);
    expect(
      pickPlanProperty([{ street: "303 Fixture Court Apt 4" }], "303 Fixture Court").matched,
    ).toBe(false);
    // Sweep&Go's whole address in one cell still finds the street.
    expect(pickPlanProperty(props, "303 Fixture Court, Austin, Texas 78701").matched).toBe(true);
  });

  it("in a file of names alone, a name is the one client who has it, never a second copy", () => {
    const idx = clientDuplicateIndex(
      [
        { id: "a", display_name: "Sam Research", primary_email: "sam@example.test" },
        { id: "b", display_name: "Lee Testcase" },
        { id: "c", display_name: "Lee Testcase" },
      ] as any,
      "sweepgo",
    );
    // In a file with an email, phone or address column, a name alone is
    // never a match (an-import-went-in-twice.test.ts).
    expect(findExistingClient({ display_name: "Sam Research" }, idx)).toBeNull();
    // In a file of names alone (Sweep&Go's Referral Sources), it is.
    idx.nameAlone = true;
    expect(findExistingClient({ display_name: "Sam Research" }, idx)).toEqual({
      id: "a",
      by: "name",
    });
    // Two of that name: nothing says which, so no match is guessed.
    expect(findExistingClient({ display_name: "Lee Testcase" }, idx)).toBeNull();
    // A row with an address is matched by name and address, as before.
    expect(
      findExistingClient({ display_name: "Sam Research", street: "1 Other St" }, idx),
    ).toBeNull();
  });
});
