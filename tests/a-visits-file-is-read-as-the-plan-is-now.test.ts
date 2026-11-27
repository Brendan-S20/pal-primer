// Rigel's review of #1069 at da4554c6, case by case: plans read off a
// visits file (Housecall Pro's Jobs export, Time To Pet's Visits report)
// with the wrong weekday, the wrong frequency or the wrong price, and visits
// dropped without a word. Rows are shaped like the real exports in
// tests/fixtures/imports.

import { describe, expect, it } from "vitest";

import { mapServiceRow } from "@/lib/import-services";
import { autoMap } from "@/lib/imports.functions";
import {
  planVisitFile,
  visitFileColumns,
  VISITS_COLUMNS,
  VISITS_LEFT_OUT_COLUMN,
  VISITS_NOTES_COLUMN,
  VISITS_PRICE_COLUMN,
  VISITS_SCHEDULE_NOTE_COLUMN,
  VISITS_FREQUENCY_COLUMN,
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
type Job = {
  on: string;
  status?: string;
  name?: string;
  service?: string;
  price?: string;
  recurring?: string;
  note?: string;
  street?: string;
};
const job = (j: Job) => ({
  "Customer name": j.name ?? "Sam Research",
  "Job description": j.service ?? "Pet Waste Cleanup",
  "Job status": j.status ?? (j.on < TODAY ? "Completed" : "Scheduled"),
  "Job scheduled start date": j.on ? `${j.on}T09:00:00-05:00` : "",
  "Total service price": j.price ?? "$18.50",
  Street: j.street ?? "123 Test St",
  Recurring: j.recurring ?? "true",
  Notes: j.note ?? "",
});

function hcp(jobs: Job[]) {
  const cols = visitFileColumns("housecall_pro", HCP)!;
  const read = planVisitFile(jobs.map(job), cols, TODAY, TZ);
  const mapping = autoMap("housecall_pro", [...HCP, ...VISITS_COLUMNS], "services");
  const plans = read.rows.map((r) => mapServiceRow(r as Record<string, string>, mapping, TZ));
  return { ...read, plans: plans.map((p) => p.mapped), errors: plans.map((p) => p.error) };
}

const weeks = (from: string, n: number, step = 7) =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i * step);
    return d.toISOString().slice(0, 10);
  });

describe("the weekday and frequency come from the plan as it is now", () => {
  it("first visit on a Wednesday, then Fridays: weekly on Fridays, no change claimed", () => {
    const r = hcp([{ on: "2026-11-11" }, ...weeks("2026-11-20", 5).map((on) => ({ on }))]);
    expect(r.rows[0][VISITS_FREQUENCY_COLUMN]).toBe("Weekly on Fridays");
    expect(r.errors).toEqual([null]);
    expect(r.plans[0]).toMatchObject({
      frequency: "weekly",
      preferred_weekdays: [5],
      started_on: "2026-11-27",
    });
    expect(r.plans[0]!.schedule_changed).toBeUndefined();
    expect(r.plans[0]!.last_or_changed).toBeUndefined();
  });

  it("every 2 weeks for months, weekly from here on: weekly", () => {
    const past = weeks("2026-06-12", 12, 14).map((on) => ({ on }));
    const ahead = weeks("2026-11-27", 4).map((on) => ({ on }));
    const r = hcp([...past, ...ahead]);
    expect(r.rows[0][VISITS_FREQUENCY_COLUMN]).toBe("Weekly on Fridays");
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", started_on: "2026-11-27" });
  });

  it("every 2 weeks with one visit moved to a Saturday: still every 2 weeks on Fridays", () => {
    const dates = ["2026-10-02", "2026-10-16", "2026-10-31", "2026-11-13", "2026-11-27"];
    const r = hcp([...dates, "2026-12-11", "2026-12-25"].map((on) => ({ on })));
    expect(r.rows[0][VISITS_FREQUENCY_COLUMN]).toBe("Every 2 weeks on Fridays");
    expect(r.plans[0]).toMatchObject({ frequency: "biweekly", preferred_weekdays: [5] });
  });

  it("monthly on the 10th with one visit on the 12th: monthly on the 10th", () => {
    const dates = ["2026-08-10", "2026-09-10", "2026-10-12", "2026-11-10", "2026-12-10"];
    const r = hcp([...dates, "2027-01-10"].map((on) => ({ on })));
    expect(r.rows[0][VISITS_FREQUENCY_COLUMN]).toBe("Monthly on the 10th day of the month");
    expect(r.plans[0]).toMatchObject({ frequency: "monthly", started_on: "2026-12-10" });
  });

  it("monthly on the second Friday: monthly on its next date, and the note says so", () => {
    const dates = ["2026-09-11", "2026-10-09", "2026-11-13", "2026-12-11", "2027-01-08"];
    const r = hcp(dates.map((on) => ({ on })));
    expect(r.rows[0][VISITS_FREQUENCY_COLUMN]).toBe("Monthly on the 11th day of the month");
    expect(r.rows[0][VISITS_SCHEDULE_NOTE_COLUMN]).toContain("monthly on the second Friday");
    expect(r.plans[0]).toMatchObject({ frequency: "monthly", started_on: "2026-12-11" });
  });

  it("every 4 weeks on Fridays is not read as monthly", () => {
    expect(scheduleFromDates(["2026-11-06", "2026-12-04", "2027-01-01"])?.text).toBe(
      "Every 4 weeks on Fridays",
    );
  });
});

describe("one-off jobs and jobs with no pattern are not plans", () => {
  it("a job Housecall Pro marks not recurring is listed, not imported", () => {
    const r = hcp([
      ...weeks("2026-11-13", 4).map((on) => ({ on })),
      { on: "2026-12-01", service: "Pet Waste Cleanup", price: "$98.50", recurring: "false" },
    ]);
    expect(r.rows).toHaveLength(1);
    // The one-off's $98.50 is not the plan's price.
    expect(r.plans[0]).toMatchObject({ frequency: "weekly", price_cents: 1850 });
    expect(r.left).toEqual([
      'Sam Research, 2026-12-01, "Pet Waste Cleanup", $98.50: a one-time job, not a recurring plan, so it is not imported. Add it by hand as a one-off visit.',
    ]);
  });

  it("one $150 job named once, with Recurring left on: not a weekly plan", () => {
    const r = hcp([{ on: "2026-12-03", service: "One-time Yard Cleanup", price: "$150.00" }]);
    expect(r.rows).toEqual([]);
    expect(r.left[0]).toMatch(
      /one visit \(2026-12-03\), and the service name does not say how often/,
    );
  });

  it("two jobs ten weeks apart: no plan every 10 weeks", () => {
    const r = hcp([{ on: "2026-09-18" }, { on: "2026-11-27" }]);
    expect(r.rows).toEqual([]);
    expect(r.left[0]).toMatch(/2 visits \(2026-09-18 to 2026-11-27\) with no regular spacing/);
  });
});

describe("the price is the plan's, with its fees", () => {
  it("one dearer visit in the plan does not set its price", () => {
    const r = hcp(
      weeks("2026-11-27", 4).map((on, i) => ({ on, price: i === 0 ? "$98.50" : "$18.50" })),
    );
    expect(r.rows[0][VISITS_PRICE_COLUMN]).toBe("18.50");
    expect(r.plans[0]!.price_cents).toBe(1850);
  });

  it("Time To Pet's fees are added to the visit's price", () => {
    const headers = [
      "Start",
      "Client",
      "Service",
      "Status",
      "Service Revenue",
      "Pet Fees",
      "Weekend Fees",
      "Note",
    ];
    const cols = visitFileColumns("time_to_pet", headers)!;
    expect(cols.fees).toEqual(["Pet Fees", "Weekend Fees"]);
    const rows = weeks("2026-11-27", 3).map((d) => ({
      // Time To Pet writes "Nov 27, 2026 12:00 PM".
      Start: `${new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} 12:00 PM`,
      Client: "Sam Research (Biscuit Test)",
      Service: "Weekly Pet Waste Cleanup",
      Status: "Scheduled",
      "Service Revenue": "$18.50",
      "Pet Fees": "$5.00",
      "Weekend Fees": "$0.00",
      Note: "",
    }));
    const read = planVisitFile(rows, cols, TODAY, TZ);
    expect(read.rows[0][VISITS_PRICE_COLUMN]).toBe("23.50");
    const mapping = autoMap("time_to_pet", [...headers, ...VISITS_COLUMNS], "services");
    expect(mapping.price_per_visit).toBe(VISITS_PRICE_COLUMN);
    expect(mapServiceRow(read.rows[0] as Record<string, string>, mapping, TZ).mapped).toMatchObject(
      { price_cents: 2350 },
    );
  });
});

describe("nothing is dropped without a word", () => {
  it("a plan with nothing booked while the file runs on is flagged as maybe ended", () => {
    const r = hcp([
      ...weeks("2026-11-13", 4).map((on) => ({ on })),
      ...weeks("2026-10-02", 5).map((on) => ({
        on,
        name: "Jordan Sample",
        street: "456 Example Ave",
      })),
    ]);
    expect(r.rows).toHaveLength(2);
    const jordan = r.rows.find((x) => x["Customer name"] === "Jordan Sample")!;
    expect(jordan[VISITS_SCHEDULE_NOTE_COLUMN]).toContain(
      "No visit is booked after 2026-10-30, though the file runs to 2026-12-04, so this plan may have ended",
    );
    expect(r.left).toEqual([
      expect.stringMatching(
        /^Jordan Sample, "Pet Waste Cleanup" at 456 Example Ave: No visit is booked after 2026-10-30/,
      ),
    ]);
  });

  it("canceled and undated visits are listed on the page and on the plan", () => {
    const r = hcp([
      ...weeks("2026-11-13", 4).map((on) => ({ on })),
      { on: "2026-11-20", status: "Canceled" },
      { on: "", status: "Scheduled" },
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0][VISITS_LEFT_OUT_COLUMN]).toBe("2026-11-20 (Canceled), no date (Scheduled)");
    expect(r.left).toEqual([
      'Sam Research, "Pet Waste Cleanup" at 123 Test St: 2 visits canceled or with no date (2026-11-20 (Canceled), no date (Scheduled)), not counted toward the plan.',
    ]);
  });

  it("a visit with no client is listed", () => {
    const r = hcp([
      ...weeks("2026-11-27", 3).map((on) => ({ on })),
      { on: "2026-12-01", name: "" },
    ]);
    expect(r.left).toEqual([
      'A visit with no client (2026-12-01, "Pet Waste Cleanup"): not imported.',
    ]);
  });

  it("a note on a completed visit is kept on the plan", () => {
    const r = hcp([
      { on: "2026-11-13", note: "Gate code changed to 4411" },
      ...weeks("2026-11-20", 4).map((on) => ({ on })),
    ]);
    expect(r.rows[0][VISITS_NOTES_COLUMN]).toBe("2026-11-13: Gate code changed to 4411");
  });
});
