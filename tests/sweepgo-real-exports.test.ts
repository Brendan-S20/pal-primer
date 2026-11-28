// Real Sweep&Go exports, from a 15-day trial on an inbox HoundStack controls
// (2026-11-27, no card, files unedited in tests/fixtures/imports). Each file
// is read the way the page reads it: tableFromCsv on Papa's raw cells, the
// vendor and kind of file detected from the headers, the Completed Jobs
// report turned into one plan per client and service. Every column of every
// file has a decided destination: a field, a helper the row mapper reads, or
// a leftover kept with the row and shown to the owner.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import {
  autoMap,
  detectImportEntity,
  detectImportSource,
  isVerifiedSource,
  mapClientRow,
  type ImportEntity,
} from "@/lib/imports.functions";
import { tableFromCsv } from "@/lib/import-file-table";
import { plansFromVisits, visitFileColumns, VISITS_COLUMNS } from "@/lib/import-visit-plans";
import { consumedColumns, leftoverColumns } from "@/lib/import-leftovers";
import { mapServiceRow, sweepGoPlanCode } from "@/lib/import-services";

const FIXTURES = join(import.meta.dirname, "fixtures", "imports");
const TODAY = "2026-11-27";
const TZ = "America/Chicago";

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
  return { fields, helpers: helpers.sort(), kept: [...kept].sort() };
}

describe("Sweep&Go", () => {
  it("is a verified source: its presets come from the real files", () => {
    expect(isVerifiedSource("sweepgo")).toBe(true);
  });

  it("Client List CSV: every column has a destination, No data is empty", () => {
    const f = load("sweepgo-client-list.csv");
    expect([f.source, f.entity, f.skipped]).toEqual(["sweepgo", "clients", []]);
    const d = destinations(f);
    expect(d.fields).toEqual({
      primary_email: "Email",
      primary_phone: "Cell Phone Number",
      archived: "Status",
      lead_source: "Referral Source",
      street: "Address",
      city: "City",
      region: "State",
      postal_code: "Zip Code",
    });
    expect(d.helpers).toEqual(expect.arrayContaining(["First Name", "Last Name"]));
    expect(d.kept).toEqual(
      expect.arrayContaining(["Referral Source Details", "SMS Messaging Consent", "Created At"]),
    );
    const rows = f.rows.map((r) => mapClientRow(r, f.mapping));
    expect(rows.map((r) => r.error)).toEqual([null, null, null, null]);
    expect(rows.map((r) => r.mapped!.display_name)).toEqual([
      "Morgan Example",
      "Lee Testcase",
      "Sam Research",
      "Dana Placeholder",
    ]);
    // "(512) 555 - 0105" is a phone; Lee has only a home phone, and it is used.
    expect(rows.map((r) => r.mapped!.primary_phone)).toEqual([
      "+15125550105",
      "+15125550104",
      "+15125550103",
      "+15125550102",
    ]);
    expect(rows[3].mapped).toMatchObject({
      primary_email: "dana.placeholder@example.test",
      street: "101 Test Lane",
      city: "Austin",
      postal_code: "78701",
      lead_source: "Yard Sign",
      active: true,
    });
  });

  it("Residential Subscriptions: summary lines skipped, every column has a destination", () => {
    const f = load("sweepgo-residential-subscriptions.csv");
    expect([f.source, f.entity]).toEqual(["sweepgo", "services"]);
    expect(f.skipped.map((s) => s.reason)).toEqual([
      'A totals line ("Total:")',
      'A summary line, not a row of data ("Cleanup Subscriptions:")',
      'A summary line, not a row of data ("Additional Service Subscriptions:")',
    ]);
    expect(f.rows).toHaveLength(4);
    const d = destinations(f);
    expect(d.fields).toMatchObject({
      client_name: "Client Name",
      frequency: "Subs. Name",
      price_per_visit: "Revenue",
      price_basis: "Revenue Type",
      plan_status: "Status",
      start_date: "Start Date",
      end_date: "End Date",
      dog_count: "Subs. Name",
      billing: "Billing Option",
      billing_frequency: "Billing Interval",
      service_street: "Address",
      service: "Subs. Name",
    });
    expect(d.kept).toEqual(
      expect.arrayContaining([
        "Tip",
        "End of Billing Period",
        "Termination Reason",
        "Termination Comment",
      ]),
    );
  });

  it("each plan code gives its dogs and how often; the canceled plan is refused", () => {
    const f = load("sweepgo-residential-subscriptions.csv");
    const plans = f.rows.map((r) => mapServiceRow(r, f.mapping, TZ));
    expect(plans.map((p) => p.mapped && p.mapped.client_name)).toEqual([
      "Dana Placeholder",
      "Sam Research",
      "Lee Testcase",
      null,
    ]);
    expect(plans.slice(0, 3).map((p) => p.mapped)).toEqual([
      expect.objectContaining({
        frequency: "weekly",
        dog_count: 2,
        price_cents: 2300,
        service_name: "Regular Plan",
        billing_cadence: "postpaid",
      }),
      expect.objectContaining({ frequency: "twice_weekly", dog_count: 1, price_cents: 1600 }),
      expect.objectContaining({ frequency: "biweekly", dog_count: 3, price_cents: 3100 }),
    ]);
    expect(plans[3].error).toBe(
      '"Canceled" in the old system, so it is not imported as a live plan. Add it by hand if it starts again.',
    );
  });

  it("a price that is not per cleanup is refused, not imported as one", () => {
    const f = load("sweepgo-residential-subscriptions.csv");
    const res = mapServiceRow({ ...f.rows[0], "Revenue Type": "per month" }, f.mapping, TZ);
    expect(res.error).toBe(
      'The price is "per month", not per visit. Add this plan by hand with its price per visit.',
    );
  });

  it("Completed Jobs: one plan per client from first and last name; its $0 first cleanup is refused", () => {
    const f = load("sweepgo-completed-jobs.csv");
    expect([f.source, f.entity]).toEqual(["sweepgo", "services"]);
    expect(f.rows).toHaveLength(1);
    const d = destinations(f);
    expect(d.helpers).toEqual(expect.arrayContaining(["Client First Name", "Client Last Name"]));
    expect(d.kept).toEqual(expect.arrayContaining(["Client Type", "Job Type", "Location Name"]));
    // The one job in the file is the free initial cleanup, at 0.00.
    const res = mapServiceRow(f.rows[0] as Record<string, string>, f.mapping, TZ);
    expect(res.error).toBe(
      'The price is "0.00" in the file, so it is not the plan\'s price. Add this plan by hand with its price per visit.',
    );
    const priced = mapServiceRow(
      { ...f.rows[0], Revenue: "23.00", "Price per visit (from the visits)": "23.00" },
      f.mapping,
      TZ,
    );
    expect(priced.error).toBeNull();
    expect(priced.mapped).toMatchObject({
      client_name: "Dana Placeholder",
      dog_count: 2,
      frequency: "weekly",
      price_cents: 2300,
      next_visit: "2026-11-27",
      service_street: "101 Test Lane, Austin",
      assigned_to: "Import Research",
    });
  });

  it("Referral Sources: a clients file, every column has a destination", () => {
    const f = load("sweepgo-referral-sources.csv");
    expect([f.source, f.entity]).toEqual(["sweepgo", "clients"]);
    const d = destinations(f);
    expect(d.fields).toMatchObject({ display_name: "Client Name", lead_source: "Referral Source" });
    expect(d.kept).toEqual(
      expect.arrayContaining(["Signup Date", "Referral Detail", "Tracking Link"]),
    );
  });
});

describe("Sweep&Go plan codes", () => {
  it.each([
    ["Regular Plan - 2d-1xW", 2, "weekly", "Regular Plan"],
    ["Regular Plan - 1d-2xW", 1, "twice_weekly", "Regular Plan"],
    ["Regular Plan - 3d-bW", 3, "biweekly", "Regular Plan"],
    ["Regular Plan - 1d-1xM", 1, "monthly", "Regular Plan"],
    ["2d-1xW", 2, "weekly", null],
  ])("%s", (text, dogs, frequency, label) => {
    expect(sweepGoPlanCode(text)).toEqual({ dogs, frequency: { frequency }, label });
  });
  it("text with no code is not read as one", () => {
    expect(sweepGoPlanCode("Weekly Pet Waste Cleanup")).toBeNull();
  });
});
