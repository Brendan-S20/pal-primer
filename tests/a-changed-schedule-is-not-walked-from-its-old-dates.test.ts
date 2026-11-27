// Rigel's review of #1069 at f874e012, defect by defect: a new monthly job
// scheduled on the wrong day, a changed schedule walked from its old dates,
// one moved visit with no start date read as a move, placeholders refused,
// a stray other-phone value refusing a row, words that are about someone
// else suggesting the client's field, and Jobber's schedule end and closed
// dates. Rows are shaped like the real Jobber Recurring jobs report.

import { describe, expect, it } from "vitest";

import { noVisit, planAnchor, statedMonthDay } from "@/lib/import-plan-anchor";
import { importPlanRow, mapServiceRow, planVisitsNote } from "@/lib/import-services";
import { suggestFields } from "@/lib/import-column-map";
import { mergeJobberVisits, JOBBER_AFTER_NEXT_COLUMN } from "@/lib/import-jobber-visits";
import {
  autoMap,
  fieldNamesForEntity,
  mapClientRow,
  TARGET_FIELDS_BY_ENTITY,
} from "@/lib/imports.functions";

const mapping = {
  client_name: "Client name",
  frequency: "Visit frequency",
  price_per_visit: "Total ($)",
  start_date: "Schedule start date",
  last_visit: "Last",
  next_visit: "Next",
  visit_after_next: "After",
  end_date: "Schedule end date",
  closed_date: "Closed date",
};
const row = (over: Record<string, string>) => ({
  "Client name": "Dana Placeholder",
  "Visit frequency": "Monthly on the 10th day of the month",
  "Total ($)": "40.0",
  "Schedule start date": "",
  Last: "-",
  Next: "-",
  After: "",
  "Schedule end date": "",
  "Closed date": "-",
  ...over,
});
const plan = (over: Record<string, string>) => {
  const res = mapServiceRow(row(over), mapping);
  expect(res.error).toBeNull();
  return res.mapped!;
};

describe("1. a new monthly job is scheduled on the day its frequency names", () => {
  it("start Dec 1, monthly on the 10th, next Dec 10, nothing done: the 10th", () => {
    const m = plan({ "Schedule start date": "Dec 01, 2026", Next: "2026-12-10" });
    expect(m.started_on).toBe("2026-12-10");
    expect(m.anchor_from).toBe("next visit");
  });
  it("reads the named day off the frequency", () => {
    expect(statedMonthDay("Monthly on the 10th day of the month")).toBe(10);
    expect(statedMonthDay("Monthly on the 1st")).toBe(1);
    expect(statedMonthDay("Monthly on the last day of the month")).toBe(31);
    expect(statedMonthDay("Monthly")).toBeNull();
    expect(statedMonthDay("Weekly on Tuesdays")).toBeNull();
  });
});

describe("2. a changed schedule follows the upcoming visits", () => {
  it("done on Fridays, now booked on Thursdays: the plan follows the bookings and says why", () => {
    const m = plan({
      "Visit frequency": "Every 2 weeks on Thursdays",
      "Schedule start date": "Sep 04, 2026",
      Last: "2026-11-13",
      Next: "2026-12-03",
      After: "2026-12-17",
    });
    expect(m).toMatchObject({ started_on: "2026-12-03", schedule_changed: true });
    const note = planVisitsNote("Jobber", m)!;
    expect(note).toContain("the schedule was changed in Jobber");
    expect(note).not.toContain("moved once");
  });
  it("even when the frequency text still names the old day", () => {
    const m = plan({
      "Schedule start date": "Sep 10, 2026",
      Last: "2026-11-10",
      Next: "2026-12-15",
      After: "2027-01-15",
    });
    expect(m).toMatchObject({ started_on: "2026-12-15", schedule_changed: true });
  });
  it("one moved visit with the one after it back on schedule is still a move", () => {
    const m = plan({
      "Schedule start date": "Sep 10, 2026",
      Last: "2026-11-10",
      Next: "2026-12-12",
      After: "2027-01-10",
    });
    expect(m.started_on).toBe("2026-11-10");
    expect(m.schedule_changed).toBeUndefined();
    expect(planVisitsNote("Jobber", m)).toContain("likely moved once in Jobber");
  });
  it("the Jobber merge carries the second upcoming visit", () => {
    const visits = [
      { "Job #": "3", Date: "Jan 10, 2027", "Visit completed date": "-" },
      { "Job #": "3", Date: "Dec 10, 2026", "Visit completed date": "-" },
      { "Job #": "3", Date: "Feb 10, 2027", "Visit completed date": "-" },
      { "Job #": "3", Date: "Nov 10, 2026", "Visit completed date": "Nov 10, 2026" },
    ];
    const [r] = mergeJobberVisits([{ "Job #": "3" }], visits, "2026-11-27");
    expect(r[JOBBER_AFTER_NEXT_COLUMN]).toBe("2027-01-10");
  });
});

describe("5. with no start date, disagreeing dates are not called a move", () => {
  it("the named day settles it: last on the 10th, next on the 12th", () => {
    const m = plan({ Last: "2026-11-10", Next: "2026-12-12" });
    expect(m.started_on).toBe("2026-11-10");
    expect(m.dates_disagree).toBeUndefined();
  });
  it("with no named day, the owner is asked to check instead", () => {
    const m = plan({ "Visit frequency": "Monthly", Last: "2026-11-10", Next: "2026-12-12" });
    expect(m.dates_disagree).toBe(true);
    const note = planVisitsNote("Jobber", m)!;
    expect(note).toContain("do not agree on this schedule");
    expect(note).not.toContain("moved once");
  });
  it("planAnchor alone, no visit after next, no start: unsure", () => {
    const a = planAnchor({
      frequency: "monthly",
      intervalWeeks: null,
      intervalDays: null,
      weekdays: [],
      frequencyInFile: true,
      start: null,
      last: "2026-11-10",
      next: "2026-12-12",
    });
    expect(a.unsure).toBe(true);
  });
});

describe("placeholders in a visit column are no visit", () => {
  it.each(["TBD", "N/A.", "Not scheduled", "null", "0", "00/00/0000", "-", "Never"])("%s", (v) => {
    expect(noVisit(v)).toBeNull();
    expect(mapServiceRow(row({ Last: v, Next: v, After: v }), mapping).error).toBeNull();
  });
  it("a real date is kept", () => expect(noVisit("2026-12-10")).toBe("2026-12-10"));
});

describe("Jobber's schedule end date and closed date", () => {
  it("a future end date becomes the plan's end, and the note says so", () => {
    const m = plan({ "Schedule start date": "Sep 10, 2026", "Schedule end date": "Mar 09, 2099" });
    expect(m.ends_on).toBe("2099-03-09");
    const r = importPlanRow(m, {
      orgId: "o",
      clientId: "c",
      propertyId: "p",
      zoneId: null,
      isResidential: true,
      dogCount: null,
      service: null,
      now: "2026-11-27T00:00:00Z",
    });
    expect(r.ends_on).toBe("2099-03-09");
    expect(planVisitsNote("Jobber", m)).toContain("It ends 2099-03-09");
  });
  it("no end date: no ends_on on the plan", () => {
    const m = plan({ "Schedule start date": "Sep 10, 2026" });
    expect(m.ends_on).toBeUndefined();
  });
  it("an end date already past is refused with the reason", () => {
    const res = mapServiceRow(row({ "Schedule end date": "Jan 05, 2020" }), mapping);
    expect(res.error).toBe(
      "The schedule ended on 2020-01-05 in the old system, so it is not imported as a live plan.",
    );
  });
  it("a closed job is refused with the reason", () => {
    const res = mapServiceRow(row({ "Closed date": "Nov 20, 2026" }), mapping);
    expect(res.error).toMatch(/^Closed in the old system on 2026-11-20/);
  });
});

describe("3. the other phone columns", () => {
  const map = autoMap(
    "jobber",
    ["Display Name", "Main Phone #s", "Mobile Phone #s", "E-mails"],
    "clients",
  );
  const base = { "Display Name": "Sam Research", "E-mails": "sam@example.test" };
  it("a full number in Mobile fills a blank Phone", () => {
    const { mapped, error } = mapClientRow(
      { ...base, "Main Phone #s": "", "Mobile Phone #s": "(313) 555-0199" },
      map,
    );
    expect(error).toBeNull();
    expect(mapped!.primary_phone).toBe("+13135550199");
  });
  it.each(["555-0100", "call neighbor first"])("%s in Mobile does not refuse the row", (v) => {
    const { mapped, error } = mapClientRow(
      { ...base, "Main Phone #s": "", "Mobile Phone #s": v },
      map,
    );
    expect(error).toBeNull();
    expect(mapped!.primary_phone).toBeNull();
  });
  it("with nothing on Phone, Mobile is not read for it", () => {
    const { mapped } = mapClientRow(
      { ...base, "Main Phone #s": "", "Mobile Phone #s": "(313) 555-0199" },
      { ...map, primary_phone: null },
    );
    expect(mapped!.primary_phone).toBeNull();
  });
});

describe("4. a column about someone else is not suggested as the client's field", () => {
  it.each([
    "Vet Phone",
    "Emergency Contact Phone",
    "Referral Email",
    "Previous Address",
    "Spouse Name",
    "Deposit Amount",
  ])("%s", (h) => {
    const headers = ["Customer Full Name", h];
    const { mapping: m } = suggestFields(
      autoMap("generic_csv", headers, "clients"),
      headers,
      TARGET_FIELDS_BY_ENTITY.clients,
      fieldNamesForEntity("clients"),
    );
    expect(Object.entries(m).filter(([, v]) => v === h)).toEqual([]);
  });
});
