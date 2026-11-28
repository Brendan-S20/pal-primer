// The mapping step lists every column of the owner's file, a few of its
// values, and where it goes, and the owner can change it before anything is
// saved (Brendan, 2026-11-27). These run on the real Jobber exports in
// tests/fixtures/imports.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Papa from "papaparse";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ColumnMappingTable } from "@/components/imports/ColumnMappingTable";
import {
  autoMap,
  fieldNamesForEntity,
  TARGET_FIELDS_BY_ENTITY,
  type ImportEntity,
} from "@/lib/imports.functions";
import {
  assignColumn,
  dropField,
  fieldsByColumn,
  sampleValues,
  suggestFields,
} from "@/lib/import-column-map";
import { helperRole, leftoverColumns } from "@/lib/import-leftovers";
import {
  JOBBER_AFTER_NEXT_COLUMN,
  JOBBER_LAST_VISIT_COLUMN,
  JOBBER_NEXT_VISIT_COLUMN,
  mergeJobberVisits,
} from "@/lib/import-jobber-visits";

type Row = Record<string, string>;
const FIXTURES = join(import.meta.dirname, "fixtures", "imports");
function fixture(name: string): { headers: string[]; rows: Row[] } {
  const parsed = Papa.parse<Row>(readFileSync(join(FIXTURES, name), "utf8"), {
    header: true,
    skipEmptyLines: true,
  });
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

/** Each column's destination as the screen shows it: its fields, a helper
 *  role, or kept as a note. */
function destinations(
  entity: ImportEntity,
  headers: string[],
  mapping: Record<string, string | null>,
) {
  const by = fieldsByColumn(mapping, headers, TARGET_FIELDS_BY_ENTITY[entity]);
  const kept = new Set(leftoverColumns(entity, mapping, headers));
  return Object.fromEntries(
    headers.map((h) => {
      const fields = by.get(h) ?? [];
      if (fields.length) return [h, fields.join("+")];
      const role = helperRole(entity, h);
      if (role) return [h, "helper"];
      expect(kept.has(h)).toBe(true);
      return [h, "note"];
    }),
  );
}

describe("Jobber's Clients export (real), column by column", () => {
  const { headers, rows } = fixture("jobber-clients-export.csv");
  const mapping = autoMap("jobber", headers, "clients");

  it("gives every column a destination: a live field, a helper, or a note the owner sees", () => {
    expect(destinations("clients", headers, mapping)).toEqual({
      "J-ID": "external_id",
      "Created Date": "note",
      "Is Company?": "account_type",
      "Display Name": "display_name",
      "Company Name": "helper",
      Title: "note",
      "First Name": "helper",
      "Last Name": "helper",
      "Main Phone #s": "primary_phone",
      "E-mails": "primary_email",
      Tags: "tags",
      "Billing Street 1": "helper",
      "Billing Street 2": "helper",
      "Billing City": "helper",
      "Billing State": "helper",
      "Billing Country": "helper",
      "Billing Zip code": "helper",
      "Work Phone #s": "note",
      "Mobile Phone #s": "note",
      "Home Phone #s": "note",
      "Fax Phone #s": "note",
      "Other Phone #s": "note",
      "Service Property Name": "label",
      "Service Street 1": "street",
      "Service Street 2": "helper",
      "Service City": "city",
      "Service State": "region",
      "Service Country": "country",
      "Service Zip code": "postal_code",
      "Text Message Enabled Phone #": "note",
      "Receives automatic visit reminders?": "note",
      "Receives automatic job follow-ups?": "note",
      "Receives automatic quote follow-ups?": "note",
      "Receives automatic invoice follow-ups?": "note",
      Archived: "archived",
      "Lead Source": "lead_source",
      "PFS[Lawn Size]": "note",
      "PFB[Locked Gate]": "note",
      "PFB[Dog]": "note",
    });
  });

  it("shows the owner a few real values per column", () => {
    expect(sampleValues(rows, "Display Name")).toEqual([
      "Sam Research",
      "Priya Sample",
      "Marcus Fixture",
    ]);
    expect(sampleValues(rows, "Service Country")).toEqual(["United States"]);
    expect(sampleValues(rows, "Fax Phone #s")).toEqual([]);
  });

  it("says what a helper column is read for", () => {
    expect(helperRole("clients", "First Name")).toMatch(/first \+ last/);
    expect(helperRole("clients", "Billing City")).toMatch(/service address is blank/);
    expect(helperRole("clients", "Tags")).toBeNull();
  });
});

describe("Jobber's Recurring jobs report with its Visits report (real), column by column", () => {
  const { headers, rows } = fixture("jobber-recurring-jobs.csv");
  const visits = fixture("jobber-visits.csv");
  const joinedHeaders = [
    ...headers,
    JOBBER_LAST_VISIT_COLUMN,
    JOBBER_NEXT_VISIT_COLUMN,
    JOBBER_AFTER_NEXT_COLUMN,
  ];
  const joined = mergeJobberVisits(rows, visits.rows, "2026-11-27") as Row[];
  const mapping = autoMap("jobber", joinedHeaders, "services");

  it("gives every column a destination", () => {
    expect(destinations("services", joinedHeaders, mapping)).toEqual({
      "Job #": "note",
      "Job title": "note",
      "Client name": "client_name",
      "Client email": "client_email",
      "Client phone": "note",
      "Service property name": "note",
      "Service street": "service_street",
      "Service city": "note",
      "Service province": "note",
      "Service ZIP": "note",
      "Billing street": "note",
      "Billing city": "note",
      "Billing province": "note",
      "Billing ZIP": "note",
      "Billing type": "billing",
      "Visit frequency": "frequency",
      "Billing frequency": "billing_frequency",
      "Automatic invoicing": "note",
      "Visits assigned to": "assigned_to",
      "Line items": "service",
      "Subtotal ($)": "note",
      "Discount ($)": "note",
      "Tax ($)": "note",
      "Job revenue ($)": "note",
      "Total ($)": "price_per_visit",
      "Completed visits": "note",
      "Number of invoices": "note",
      "Created date": "note",
      "Schedule start date": "start_date",
      "Schedule end date": "end_date",
      "Closed date": "closed_date",
      [JOBBER_LAST_VISIT_COLUMN]: "last_visit",
      [JOBBER_NEXT_VISIT_COLUMN]: "next_visit",
      [JOBBER_AFTER_NEXT_COLUMN]: "visit_after_next",
    });
    // The service day is read from the frequency ("Weekly on Tuesdays").
    expect(sampleValues(joined, "Visit frequency")).toContain("Weekly on Tuesdays");
  });
});

describe("the owner changes where a column goes", () => {
  const fields = TARGET_FIELDS_BY_ENTITY.clients;
  const headers = ["Name", "Cell", "Home", "Notes"];
  const start = { display_name: "Name", primary_phone: "Home", notes: "Notes" };

  it("sending a column to a field takes the field from the column that had it", () => {
    const next = assignColumn(start, "Cell", "primary_phone", fields);
    expect(next.primary_phone).toBe("Cell");
    expect(fieldsByColumn(next, headers, fields).get("Home")).toEqual([]);
    expect(leftoverColumns("clients", next, headers)).toEqual(["Home"]);
  });

  it("keeping a column as a note clears every field it fed", () => {
    const two = { ...start, tags: "Notes" };
    const next = assignColumn(two, "Notes", null, fields);
    expect(next.notes).toBeNull();
    expect(next.tags).toBeNull();
    expect(leftoverColumns("clients", next, headers)).toEqual(["Cell", "Notes"]);
  });

  it("a column that feeds two fields keeps its second when its first changes", () => {
    const sf = TARGET_FIELDS_BY_ENTITY.services;
    const m = { frequency: "Visit frequency", service_day: "Visit frequency" };
    const next = assignColumn(m, "Visit frequency", "start_date", sf);
    expect(next).toMatchObject({
      frequency: null,
      service_day: "Visit frequency",
      start_date: "Visit frequency",
    });
    expect(dropField(next, "service_day").service_day).toBeNull();
  });
});

describe("a CSV no preset knows still gets every column and a suggested field", () => {
  const headers = [
    "Customer Full Name",
    "Email Address",
    "Cell Phone",
    "Street Address",
    "Town",
    "Zip Code",
    "Pet Name",
    "Favorite Color",
  ];

  it("suggests a field for each column whose name says it, and leaves the rest as notes", () => {
    const base = autoMap("generic_csv", headers, "clients");
    const { mapping, suggested } = suggestFields(
      base,
      headers,
      TARGET_FIELDS_BY_ENTITY.clients,
      fieldNamesForEntity("clients"),
    );
    expect(mapping).toMatchObject({
      primary_email: "Email Address",
      primary_phone: "Cell Phone",
      street: "Street Address",
      city: "Town",
      postal_code: "Zip Code",
    });
    // The email matched a generic name outright; the rest are suggestions.
    expect(suggested).not.toContain("primary_email");
    expect(suggested).toEqual(expect.arrayContaining(["primary_phone", "display_name"]));
    expect(mapping.display_name).toBe("Customer Full Name");
    // "Pet Name" is not the client's name; a colour is nobody's field.
    expect(mapping.display_name).not.toBe("Pet Name");
    expect(leftoverColumns("clients", mapping, headers)).toContain("Favorite Color");
  });
});

describe("the screen itself, on the real Jobber Clients export", () => {
  const { headers, rows } = fixture("jobber-clients-export.csv");
  const mapping = autoMap("jobber", headers, "clients");
  const html = renderToStaticMarkup(
    createElement(ColumnMappingTable, {
      entity: "clients",
      headers,
      rows,
      mapping,
      onChange: () => {},
      targetFields: TARGET_FIELDS_BY_ENTITY.clients,
      required: ["display_name"],
      labels: { display_name: "Client name", lead_source: "Lead source" },
      suggested: new Set<string>(),
    }),
  );
  const decoded = html
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");

  it("has one row per column, each with its sample values and a destination picker", () => {
    for (const h of headers) {
      expect(decoded).toContain(`data-column="${h}"`);
      expect(decoded).toContain(`aria-label="Where "${h}" goes"`);
    }
    expect((html.match(/<select/g) ?? []).length).toBe(headers.length);
    expect(decoded).toContain("Sam Research · Priya Sample · Marcus Fixture");
    expect(decoded).toContain("blank in every row");
  });

  it("shows a kept column as a note and a mapped one on its field", () => {
    expect(decoded).toContain("Kept on the client as a note");
    expect(decoded).toMatch(/<option value="lead_source" selected="">Lead source<\/option>/);
    expect(decoded).toContain("24 of 39 columns go to a field; 15 are kept as a note");
  });
});
