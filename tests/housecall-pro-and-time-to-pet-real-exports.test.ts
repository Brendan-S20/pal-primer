// Real Housecall Pro and Time To Pet exports, from 14-day trials on inboxes
// HoundStack controls (2026-11-27, no card, files unedited in
// tests/fixtures/imports). Each file is read the way the page reads it:
// tableFromCsv on Papa's raw cells, the vendor and kind of file detected from
// the headers, a visits file turned into one plan per client and service.
// Every column of every file has a decided destination: a field, a helper the
// row mapper reads, or a leftover kept with the row and shown to the owner.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import {
  autoMap,
  detectImportEntity,
  detectImportSource,
  mapClientRow,
  mapDogRow,
  type ImportEntity,
} from "@/lib/imports.functions";
import { tableFromCsv } from "@/lib/import-file-table";
import {
  frequencyFromDates,
  plansFromVisits,
  visitFileColumns,
  VISITS_COLUMNS,
} from "@/lib/import-visit-plans";
import { consumedColumns, leftoverColumns } from "@/lib/import-leftovers";
import { mapBalanceRow, mapServiceRow, parseImportDate } from "@/lib/import-services";

const FIXTURES = join(import.meta.dirname, "fixtures", "imports");
const TODAY = "2026-11-27";
const TZ = "America/Detroit";

/** One real file as the page reads it, with its mapping. */
function load(name: string) {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  const cells = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const table = tableFromCsv(cells);
  const source = detectImportSource(table.headers);
  const entity = detectImportEntity(table.headers);
  const vc = entity === "services" && source ? visitFileColumns(source, table.headers) : null;
  const headers = vc ? [...table.headers, ...VISITS_COLUMNS] : table.headers;
  const rows = vc ? plansFromVisits(table.rows, vc, TODAY, TZ) : table.rows;
  const mapping = autoMap(source ?? "generic_csv", headers, (entity ?? "clients") as ImportEntity);
  return { ...table, headers, rows, source, entity, mapping };
}

/** Each mapped field's column, and proof no column is dropped. */
function destinations(f: ReturnType<typeof load>) {
  const e = f.entity as ImportEntity;
  const consumed = new Set(consumedColumns(e, f.mapping, f.headers));
  const kept = new Set(leftoverColumns(e, f.mapping, f.headers));
  expect(f.headers.filter((h) => !consumed.has(h) && !kept.has(h))).toEqual([]);
  const fields = Object.fromEntries(Object.entries(f.mapping).filter(([, v]) => v));
  const helpers = [...consumed].filter((h) => !Object.values(f.mapping).includes(h));
  return { fields, helpers, kept: [...kept] };
}

describe("Housecall Pro", () => {
  it("customers: every column has a destination", () => {
    const f = load("housecall-pro-customers.csv");
    expect([f.source, f.entity, f.skipped]).toEqual(["housecall_pro", "clients", []]);
    const d = destinations(f);
    expect(d.fields).toEqual({
      display_name: "Display Name",
      account_type: "Customer Type",
      primary_email: "Email",
      primary_phone: "Mobile Number",
      external_id: "ID",
      notes: "Notes",
      tags: "Tags",
      lead_source: "Lead Source",
      archived: "Do Not Service",
      street: "Address_1 Street Line 1",
      city: "Address_1 City",
      region: "Address_1 State",
      postal_code: "Address_1 Postal Code",
    });
    expect(d.helpers.sort()).toEqual([
      "Address_1 Street Line 2",
      "Company",
      "First Name",
      "Last Name",
    ]);
    expect(d.kept).toEqual(
      expect.arrayContaining([
        "Home Number",
        "Work Number",
        "Last service date",
        "Lifetime value",
        "Address_1 Notes",
      ]),
    );
    const m = mapClientRow(f.rows[0], f.mapping);
    expect(m.error).toBeNull();
    // ="247896075" in the file is the id 247896075.
    expect(m.mapped).toMatchObject({
      display_name: "Sam Research",
      external_id: "247896075",
      primary_phone: "+13135550142",
      street: "701 S Harrison Ave",
      city: "Kankakee",
      region: "IL",
      postal_code: "60901",
      active: true,
    });
  });

  it("jobs: 80 visit rows are two plans, each with how often, price, last and next visit", () => {
    const f = load("housecall-pro-jobs.csv");
    expect([f.source, f.entity]).toEqual(["housecall_pro", "services"]);
    expect(f.rows).toHaveLength(2);
    expect(destinations(f).fields).toMatchObject({
      client_name: "Customer name",
      client_email: "Customer email",
      service: "Job description",
      assigned_to: "Assigned employees",
      service_street: "Street",
      price_per_visit: "Total service price",
      frequency: "How often (from the visits)",
      start_date: "First visit (from the visits)",
      last_visit: "Last visit (from the visits)",
      next_visit: "Next visit (from the visits)",
    });
    const plans = f.rows.map((r) => mapServiceRow(r as Record<string, string>, f.mapping, TZ));
    expect(plans.map((p) => p.error)).toEqual([null, null]);
    expect(plans.map((p) => p.mapped)).toEqual([
      expect.objectContaining({
        client_name: "Sam Research",
        frequency: "weekly",
        price_cents: 1850,
        preferred_weekdays: [5],
        last_visit: "2026-11-13",
        next_visit: "2026-11-27",
        service_street: "123 Test St",
        service_name: "Weekly Pet Waste Cleanup",
      }),
      expect.objectContaining({
        client_name: "Jordan Sample",
        frequency: "biweekly",
        price_cents: 3200,
        preferred_weekdays: [5],
        last_visit: "2026-11-20",
        next_visit: "2026-12-04",
        service_street: "456 Example Ave",
      }),
    ]);
  });

  it("invoices: what is due, per customer", () => {
    const f = load("housecall-pro-invoices.csv");
    expect([f.source, f.entity]).toEqual(["housecall_pro", "balances"]);
    expect(destinations(f).fields).toMatchObject({
      client_name: "Customer",
      amount: "Due",
      note: "Description",
    });
    const rows = f.rows.map(
      (r) => mapBalanceRow(r as Record<string, string>, f.mapping, TZ).mapped,
    );
    expect(rows).toEqual([
      expect.objectContaining({ client_name: "Sam Research", amount_cents: 1850 }),
      expect.objectContaining({ client_name: "Jordan Sample", amount_cents: 3200 }),
    ]);
  });
});

describe("Time To Pet", () => {
  it("client list: the group-label row is skipped and repeats are told apart", () => {
    const f = load("time-to-pet-client-list.csv");
    expect([f.source, f.entity]).toEqual(["time_to_pet", "clients"]);
    expect(f.skipped).toEqual([
      {
        line: 2,
        reason:
          "Column group labels, not a row of data (Primary Contact, Address, Emergency Contact, Other)",
      },
    ]);
    expect(f.headers).toEqual(
      expect.arrayContaining(["Email (Emergency Contact)", "Primary Phone (Emergency Contact)"]),
    );
    expect(destinations(f).fields).toMatchObject({
      display_name: "Full Name",
      primary_email: "Email",
      primary_phone: "Primary Phone",
      lead_source: "How did you find us?",
      gate_code: "Access Instructions",
      street: "Address 1",
      city: "City",
      region: "State",
      postal_code: "Zip Code",
      notes: "Private Note",
      pets: "Pet Names",
      archived: "Client Inactive?",
    });
    expect(f.rows.map((r) => mapClientRow(r, f.mapping).mapped?.display_name)).toEqual([
      "Jordan Sample",
      "Sam Research",
    ]);
  });

  for (const file of ["time-to-pet-petlist-pets.csv", "time-to-pet-pets-with-client-fields.csv"]) {
    it(`${file}: dogs with their owner; pet type and deceased are read`, () => {
      const f = load(file);
      expect([f.source, f.entity, f.skipped[0]?.line]).toEqual(["time_to_pet", "dogs", 2]);
      const d = destinations(f);
      expect(d.fields).toMatchObject({ name: "Name", breed: "Breed", notes: "Notes" });
      expect(d.helpers).toEqual(expect.arrayContaining(["Pet Type", "Pet Deceased?"]));
      expect(f.rows.map((r) => mapDogRow(r, f.mapping).mapped?.name)).toEqual([
        "Biscuit Test",
        "Pickle Test",
      ]);
      const cat = { ...f.rows[0], "Pet Type": "Cat" };
      expect(mapDogRow(cat, f.mapping).error).toBe(
        'Not a dog ("Cat"); add it by hand if you care for it',
      );
      const gone = { ...f.rows[0], "Pet Deceased?": "Yes" };
      expect(mapDogRow(gone, f.mapping).error).toBe("Marked deceased in the old system");
    });
  }

  it("sales report: the date range and totals lines are skipped, balances read", () => {
    const f = load("time-to-pet-sales-report.csv");
    expect([f.source, f.entity]).toEqual(["time_to_pet", "balances"]);
    expect(f.skipped).toEqual([
      {
        line: 2,
        reason: 'A report heading, not a row of data ("November 01, 2026 - November 30, 2026")',
      },
      { line: 5, reason: 'A totals line ("Totals:")' },
    ]);
    expect(destinations(f).fields).toMatchObject({
      client_name: "Client",
      amount: "Balance Due",
      due_date: "Due Date",
    });
    const rows = f.rows.map(
      (r) => mapBalanceRow(r as Record<string, string>, f.mapping, TZ).mapped,
    );
    expect(rows).toEqual([
      expect.objectContaining({ amount_cents: 12950, due_on: "2026-11-13" }),
      expect.objectContaining({ amount_cents: 3200, due_on: "2026-11-20" }),
    ]);
  });

  it("visits: eight visits are two plans", () => {
    const f = load("time-to-pet-visits.csv");
    expect([f.source, f.entity, f.rows.length]).toEqual(["time_to_pet", "services", 2]);
    expect(destinations(f).fields).toMatchObject({
      client_name: "Client",
      service: "Service",
      price_per_visit: "Service Revenue",
      assigned_to: "Staff",
      frequency: "How often (from the visits)",
    });
    const plans = f.rows.map((r) => mapServiceRow(r as Record<string, string>, f.mapping, TZ));
    expect(plans.map((p) => p.error)).toEqual([null, null]);
    expect(plans[0].mapped).toMatchObject({
      frequency: "weekly",
      price_cents: 1850,
      last_visit: "2026-11-20",
      next_visit: "2026-11-27",
    });
    // One visit in the file: how often comes from the service's name, and
    // the plan is set from that visit.
    expect(f.rows[1]["How often (from the visits)"]).toBe(
      'Every 2 weeks on Fridays, from the service name "Every Other Week Pet Waste Cleanup"',
    );
    expect(plans[1].mapped).toMatchObject({
      frequency: "biweekly",
      price_cents: 3200,
      started_on: "2026-11-20",
    });
  });

  it("the first/last visit report and the rates file are not plan files", () => {
    expect(load("time-to-pet-first-last-visit-report.csv").entity).not.toBe("services");
    expect(load("time-to-pet-service-rates.csv").entity).not.toBe("services");
  });
});

describe("the pieces", () => {
  it("a lone row with no group labels is data", () => {
    const t = tableFromCsv([
      ["Name", "City"],
      ["Sam", "Detroit"],
    ]);
    expect([t.rows, t.skipped]).toEqual([[{ Name: "Sam", City: "Detroit" }], []]);
  });

  it('="1" is 1, and a repeat with no group label is numbered', () => {
    const t = tableFromCsv([
      ["ID", "Email", "Email"],
      ['="1"', "a@x.co", "b@x.co"],
    ]);
    expect(t.headers).toEqual(["ID", "Email", "Email (2)"]);
    expect(t.rows[0]).toEqual({ ID: "1", Email: "a@x.co", "Email (2)": "b@x.co" });
  });

  it("a leading weekday is read", () => {
    expect(parseImportDate("Fri Dec 25, 2026 12:00 PM")).toBe("2026-12-25");
  });

  it("how often, from the dates", () => {
    expect(frequencyFromDates(["2026-11-06", "2026-11-13", "2026-11-20"])).toBe(
      "Weekly on Fridays",
    );
    expect(frequencyFromDates(["2026-11-06", "2026-11-20", "2026-12-04"])).toBe(
      "Every 2 weeks on Fridays",
    );
    expect(frequencyFromDates(["2026-10-10", "2026-11-10", "2026-12-10"])).toBe(
      "Monthly on the 10th day of the month",
    );
    expect(frequencyFromDates(["2026-11-02", "2026-11-05", "2026-11-09", "2026-11-12"])).toBe(
      "Twice a week on Mondays and Thursdays",
    );
    expect(frequencyFromDates(["2026-11-06"])).toBeNull();
  });
});
