// Jobber CSV import — tuned against a REAL Jobber "Clients and properties"
// export (jobber-real.csv). The header array and row shapes below are taken
// verbatim from that file: multi-value phone cells ("+13136525507;7343416191"),
// empty-string cells, "true"/"false" booleans in "Is Company?", Tags carrying
// cadence info, Service vs Billing address columns, and dd/mm/yyyy Created
// Date (which no client target field consumes — dates are never mapped).
import { describe, expect, it } from "vitest";
import { autoMap, detectImportSource, mapClientRow } from "@/lib/imports.functions";

// Exact header row of the real export.
const REAL_HEADERS = [
  "J-ID",
  "Created Date",
  "Is Company?",
  "Display Name",
  "Company Name",
  "Title",
  "First Name",
  "Last Name",
  "Main Phone #s",
  "E-mails",
  "Tags",
  "Billing Street 1",
  "Billing Street 2",
  "Billing City",
  "Billing State",
  "Billing Country",
  "Billing Zip code",
  "CFS[How often are your visits?]",
  "CFS[How Often Are Your Visits?]",
  "Work Phone #s",
  "Mobile Phone #s",
  "Home Phone #s",
  "Fax Phone #s",
  "Other Phone #s",
  "Service Property Name",
  "Service Street 1",
  "Service Street 2",
  "Service City",
  "Service State",
  "Service Country",
  "Service Zip code",
  "Text Message Enabled Phone #",
  "Receives automatic visit reminders?",
  "Receives automatic job follow-ups?",
  "Receives automatic quote follow-ups?",
  "Receives automatic invoice follow-ups?",
  "Archived",
  "Lead Source",
];

describe("detectImportSource (real Jobber export)", () => {
  it("fires as 'jobber' on the exact real header list", () => {
    expect(detectImportSource(REAL_HEADERS)).toBe("jobber");
  });

  it("still returns null for a generic ambiguous header set", () => {
    expect(detectImportSource(["Name", "Email", "Phone"])).toBeNull();
  });
});

describe("autoMap (real Jobber export, clients)", () => {
  const mapping = autoMap("jobber", REAL_HEADERS, "clients");

  it("maps every client target field to the real Jobber columns", () => {
    expect(mapping.display_name).toBe("Display Name");
    expect(mapping.account_type).toBe("Is Company?");
    expect(mapping.primary_email).toBe("E-mails");
    expect(mapping.primary_phone).toBe("Main Phone #s");
    expect(mapping.external_id).toBe("J-ID");
    // Tags go to tags since 2026-09-28; the real export has no Notes column.
    expect(mapping.tags).toBe("Tags");
    expect(mapping.notes).toBeNull();
    // Service address preferred over Billing at the column level.
    expect(mapping.street).toBe("Service Street 1");
    expect(mapping.city).toBe("Service City");
    expect(mapping.region).toBe("Service State");
    expect(mapping.postal_code).toBe("Service Zip code");
  });
});

describe("mapClientRow (real-shaped Jobber rows)", () => {
  const mapping = autoMap("jobber", REAL_HEADERS, "clients");

  // Row 2 of the real file: multi-value phone cell, empty E-mails, unquoted
  // empty billing cells, "false" Is Company?.
  const makenzie = {
    "J-ID": "103432539_110583912",
    "Created Date": "18/03/2025", // dd/mm/yyyy — not consumed by any target field
    "Is Company?": "false",
    "Display Name": "Makenzie Costello",
    "Company Name": "",
    "First Name": "Makenzie",
    "Last Name": "Costello",
    "Main Phone #s": "+13136525507;7343416191",
    "E-mails": "",
    Tags: "Follow-Up",
    "Billing Street 1": "",
    "Billing City": "",
    "Service Street 1": "1801 Woodside Street",
    "Service Street 2": "",
    "Service City": "Trenton",
    "Service State": "Michigan",
    "Service Country": "United States",
    "Service Zip code": "48183",
    "Text Message Enabled Phone #": "+13136525507",
    Archived: "false",
  };

  it("takes the first number from a multi-value phone cell and normalizes to E.164", () => {
    const { mapped, error } = mapClientRow(makenzie, mapping);
    expect(error).toBeNull();
    expect(mapped!.primary_phone).toBe("+13136525507");
  });

  it("treats empty strings as null and maps the service address + tags", () => {
    const { mapped } = mapClientRow(makenzie, mapping);
    expect(mapped!.primary_email).toBeNull();
    expect(mapped!.display_name).toBe("Makenzie Costello");
    expect(mapped!.external_id).toBe("103432539_110583912");
    expect(mapped!.account_type).toBe("residential"); // "false" → not a company
    expect(mapped!.tags).toEqual(["Follow-Up"]); // Tags land in tags, not notes
    expect(mapped!.notes).toBeNull();
    expect(mapped!.street).toBe("1801 Woodside Street");
    expect(mapped!.city).toBe("Trenton");
    expect(mapped!.region).toBe("Michigan");
    expect(mapped!.postal_code).toBe("48183");
    // No date field exists on the client target — Created Date is ignored.
    expect(Object.keys(mapped!)).not.toContain("created_date");
  });

  it("normalizes a bare 10-digit phone and validates a real email", () => {
    const abby = {
      ...makenzie,
      "J-ID": "103477674_110630029",
      "Display Name": "Abby Pick up",
      "Main Phone #s": "7343659910",
      "E-mails": "abbyd04@yahoo.com",
    };
    const { mapped, error } = mapClientRow(abby, mapping);
    expect(error).toBeNull();
    expect(mapped!.primary_phone).toBe("+17343659910");
    expect(mapped!.primary_email).toBe("abbyd04@yahoo.com");
  });

  it("maps 'Is Company?' = true to commercial and falls back to Billing address", () => {
    const company = {
      ...makenzie,
      "J-ID": "900000001_900000001",
      "Is Company?": "true",
      "Display Name": "Downriver HOA",
      "Service Street 1": "",
      "Service City": "",
      "Service State": "",
      "Service Zip code": "",
      "Billing Street 1": "500 Main Street",
      "Billing Street 2": "Suite 210",
      "Billing City": "Wyandotte",
      "Billing State": "Michigan",
      "Billing Zip code": "48192",
    };
    const { mapped, error } = mapClientRow(company, mapping);
    expect(error).toBeNull();
    expect(mapped!.account_type).toBe("commercial");
    expect(mapped!.street).toBe("500 Main Street, Suite 210");
    expect(mapped!.city).toBe("Wyandotte");
    expect(mapped!.region).toBe("Michigan");
    expect(mapped!.postal_code).toBe("48192");
  });

  it("combines First + Last Name when Display Name is empty", () => {
    const noDisplay = { ...makenzie, "Display Name": "" };
    const { mapped, error } = mapClientRow(noDisplay, mapping);
    expect(error).toBeNull();
    expect(mapped!.display_name).toBe("Makenzie Costello");
  });

  it("takes only the first entry of a multi-value email cell", () => {
    const multi = { ...makenzie, "E-mails": "first@example.com;second@example.com" };
    const { mapped, error } = mapClientRow(multi, mapping);
    expect(error).toBeNull();
    expect(mapped!.primary_email).toBe("first@example.com");
  });
});
