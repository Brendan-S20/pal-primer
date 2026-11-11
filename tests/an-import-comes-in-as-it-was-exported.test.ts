// An import comes in as it was exported (#857).
//
// The owner's direction (Nov 10 2026): "mimic the export from each company,
// so when they come to import, each field serves a purpose and as much data
// comes through and smoothly over". Until this, a business had to rename
// columns, split Full Name, or add a frequency column by hand, and every
// column the mapping did not name was dropped without a word.
//
// Each fixture in tests/fixtures/imports/ carries the headers a vendor's own
// documentation or sample file lists (see the README there), with invented
// rows. For every fixture: the source is recognized, the file maps without
// renaming a column, every row maps, and every column is either consumed by
// a field or kept. A column that is neither fails the test.
//
// The product decisions in the same thread, each pinned below: imported
// plans start paused with no visits; open balances become open invoices
// with nothing sent or charged; archived clients come in inactive with
// messaging off; a different billing address is a note; leftover columns
// are raw JSON plus a notes summary; undo per batch only while nothing from
// it has visits or payments; a residential client needs no dog to import.

/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory query builder */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Papa from "papaparse";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = {
      middleware: () => chain,
      inputValidator: () => chain,
      handler: (handler: unknown) => handler,
    };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
const permissionCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async (_s: unknown, _u: string, permission: string) => {
    permissionCalls.push(permission);
    return { orgId: "org" };
  }),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));
const visitGeneration = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/visit-generation.server", () => ({
  generateVisitHorizon: vi.fn(async () => {
    visitGeneration.calls += 1;
  }),
}));

import {
  autoMap,
  commitImport,
  detectImportSource,
  getImportBatch,
  IMPORT_SOURCES,
  isVerifiedSource,
  mapClientRow,
  previewImport,
  undoImport,
  VERIFIED_SOURCES,
  type ImportEntity,
} from "@/lib/imports.functions";
import {
  importPlanRow,
  mapServiceRow,
  parseImportDate,
  type MappedService,
} from "@/lib/import-services";
import {
  consumedColumns,
  extrasSummary,
  IMPORT_UNDO_CONFIRM,
  leftoverColumns,
  parseInactive,
  parsePetNames,
  rowExtras,
  undoRefusal,
} from "@/lib/import-leftovers";
import { importDisplayStatus } from "@/lib/import-commit-guard";

const ROOT = join(import.meta.dirname, "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "imports");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type Row = Record<string, string>;
function fixture(name: string): { headers: string[]; rows: Row[] } {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  expect(parsed.errors).toEqual([]);
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

/** Every header is consumed by a field or left over (kept). Neither is a
 *  column dropped. */
function everyColumnMappedOrKept(
  entity: ImportEntity,
  mapping: Record<string, string | null>,
  headers: string[],
) {
  const consumed = new Set(consumedColumns(entity, mapping, headers));
  const kept = new Set(leftoverColumns(entity, mapping, headers));
  const dropped = headers.filter((h) => !consumed.has(h) && !kept.has(h));
  expect(dropped, "columns neither mapped nor kept").toEqual([]);
  for (const h of headers) expect(consumed.has(h) && kept.has(h), `${h} is both`).toBe(false);
  return { consumed: [...consumed], kept: [...kept] };
}

// ── Jobber, dialect A: the official help-center sample file ────────────────

describe("Jobber's official sample file (Dialect A)", () => {
  const { headers, rows } = fixture("jobber-official-sample.csv");
  const mapping = autoMap("jobber", headers, "clients");

  it("is recognized as Jobber", () => {
    expect(detectImportSource(headers)).toBe("jobber");
  });

  it("maps the fields the owner would otherwise have renamed", () => {
    expect(mapping).toMatchObject({
      display_name: "Client Full Name (Display Only)",
      account_type: "Client Is Company?",
      primary_email: "Client Email",
      primary_phone: "Client Main Phone",
      street: "Property Street 1",
      city: "Property City",
      region: "Property State/Province",
      postal_code: "Property Zip/Postal Code",
      notes: "Client Internal Notes",
      tags: "Tags",
      archived: "Archived (True/False)",
      balance: "Account Balance",
      external_id: null,
    });
  });

  it("every column is mapped or kept, and the kept ones are the ones Jobber adds", () => {
    const { kept } = everyColumnMappedOrKept("clients", mapping, headers);
    expect(kept).toEqual(
      expect.arrayContaining([
        "Client Created Date",
        "Client Title",
        "Client Home Phone",
        "Client SMS Enabled Phone Number",
        "Property Country",
        "Client Receives Auto Visit Reminders?",
        "Lead Source",
      ]),
    );
    // The helpers the mapper reads by name are consumed, not kept.
    expect(kept).not.toContain("Client First Name");
    expect(kept).not.toContain("Billing Street 1");
    expect(kept).not.toContain("Property Street 2");
  });

  it("creates clients WITH their service address, tags, notes and balance", () => {
    const mapped = rows.map((r) => mapClientRow(r, mapping));
    expect(mapped.map((m) => m.error)).toEqual([null, null, null]);
    expect(mapped[0].mapped).toMatchObject({
      display_name: "Priya Sample",
      account_type: "residential",
      primary_email: "priya@example.test",
      primary_phone: "+15550100001",
      street: "12 Example Lane",
      city: "Royal Oak",
      region: "MI",
      postal_code: "48073",
      notes: "Side gate sticks; lift and push",
      tags: ["Weekly", "Tuesday"],
      active: true,
      balance_cents: null,
      pets: null,
    });
    // A company, with a billing address that differs: one service property
    // and a note, and a balance that becomes an open invoice on commit.
    expect(mapped[1].mapped).toMatchObject({
      display_name: "Example Property Group",
      account_type: "commercial",
      street: "400 Commerce Blvd, Suite 210",
      balance_cents: 125000,
    });
    expect(mapped[1].mapped!.notes).toBe(
      "Invoice the HOA office\nBilling address: PO Box 77, Troy, MI, 48099",
    );
    // Archived in Jobber: inactive here, and the balance still carried.
    expect(mapped[2].mapped).toMatchObject({ active: false, balance_cents: 4500, notes: null });
  });

  it("keeps the leftover columns on each row as raw values", () => {
    const kept = leftoverColumns("clients", mapping, headers);
    expect(rowExtras(rows[0], kept)).toMatchObject({
      "Client Created Date": "2024-03-18",
      "Lead Source": "Google",
      "Client Receives Auto Visit Reminders?": "TRUE",
    });
    // Blank cells are not kept; a column with nothing in a row is absent.
    expect(rowExtras(rows[0], kept)).toHaveProperty("Client Title", "Ms.");
    expect(rowExtras(rows[2], kept)).not.toHaveProperty("Client Title");
    expect(extrasSummary("Jobber", rowExtras(rows[2], kept))).toMatch(
      /^Imported from Jobber\. Client Created Date: 2022-06-30\. .*Lead Source: Yard sign\.$/,
    );
  });
});

// ── Jobber, dialect B: a live Clients and properties export ────────────────

describe("Jobber's live export (Dialect B)", () => {
  const { headers, rows } = fixture("jobber-live-export.csv");
  const mapping = autoMap("jobber", headers, "clients");

  it("is still recognized and still maps J-ID, Display Name, E-mails, Service Street 1", () => {
    expect(detectImportSource(headers)).toBe("jobber");
    expect(mapping).toMatchObject({
      external_id: "J-ID",
      display_name: "Display Name",
      primary_email: "E-mails",
      primary_phone: "Main Phone #s",
      street: "Service Street 1",
      archived: "Archived",
    });
    everyColumnMappedOrKept("clients", mapping, headers);
  });

  it("maps every row, the archived one inactive", () => {
    const mapped = rows.map((r) => mapClientRow(r, mapping));
    expect(mapped.map((m) => m.error)).toEqual([null, null, null]);
    expect(mapped[0].mapped).toMatchObject({
      external_id: "100000001_200000001",
      primary_phone: "+15550100001",
      active: true,
    });
    expect(mapped[2].mapped).toMatchObject({ active: false });
    const kept = leftoverColumns("clients", mapping, headers);
    expect(kept).toEqual(
      expect.arrayContaining(["Created Date", "Lead Source", "Mobile Phone #s"]),
    );
    expect(rowExtras(rows[1], kept)).toMatchObject({
      "CFS[How Often Are Your Visits?]": "Every other week",
    });
  });
});

// ── Jobber's Recurring jobs report: no frequency column ────────────────────

describe("Jobber's Recurring jobs report", () => {
  const { headers, rows } = fixture("jobber-recurring-jobs.csv");
  const mapping = autoMap("jobber", headers, "services");

  it("is recognized as Jobber and maps without a frequency column", () => {
    expect(detectImportSource(headers)).toBe("jobber");
    expect(mapping).toMatchObject({
      client_name: "Client name",
      client_email: "Client email",
      price_per_visit: "Total ($)",
      start_date: "Schedule start date",
      service: "Line items",
      billing: "Billing type",
      frequency: null,
    });
    const { kept } = everyColumnMappedOrKept("services", mapping, headers);
    expect(kept).toEqual(
      expect.arrayContaining([
        "Job #",
        "Job title",
        "Completed visits",
        "Custom fields",
        "Schedule end date",
      ]),
    );
  });

  it("each row is a plan whose frequency the owner sets, not one the owner had to add a column for", () => {
    const first = mapServiceRow(rows[0], mapping);
    expect(first.error).toBeNull();
    expect(first.mapped).toMatchObject({
      client_name: "Priya Sample",
      client_email: "priya@example.test",
      price_cents: 1800,
      started_on: "2025-03-24",
      service_name: "Pet waste removal",
      frequency: "weekly",
      frequency_in_file: false,
    });
  });
});

// ── Time To Pet ────────────────────────────────────────────────────────────

describe("Time To Pet", () => {
  it("the client list maps Full Name without splitting it by hand", () => {
    const { headers, rows } = fixture("time-to-pet-clients.csv");
    expect(detectImportSource(headers)).toBe("time_to_pet");
    const mapping = autoMap("time_to_pet", headers, "clients");
    expect(mapping).toMatchObject({
      display_name: "Full Name",
      street: "Address",
      city: "City",
      region: "State",
      postal_code: "Zip Code",
    });
    const { kept } = everyColumnMappedOrKept("clients", mapping, headers);
    expect(kept).toEqual([]);
    const m = mapClientRow(rows[0], mapping);
    expect(m.error).toBeNull();
    expect(m.mapped).toMatchObject({
      display_name: "Priya Sample",
      street: "12 Example Lane",
      city: "Royal Oak",
      region: "MI",
      postal_code: "48073",
    });
  });

  it("the keys export puts the key on the property and keeps the rest", () => {
    const { headers } = fixture("time-to-pet-keys.csv");
    expect(detectImportSource(headers)).toBe("time_to_pet");
    const mapping = autoMap("time_to_pet", headers, "properties");
    expect(mapping).toMatchObject({
      gate_code: "Key Name/Code",
      notes: "With (Location)",
      street: "Address",
      postal_code: "Zip",
    });
    const { kept } = everyColumnMappedOrKept("properties", mapping, headers);
    expect(kept).toEqual(["Client's Pets"]);
  });
});

// ── Gingr: a best guess, every column shown ────────────────────────────────

describe("Gingr's View All Owners export (best guess, no sample yet)", () => {
  const { headers, rows } = fixture("gingr-view-all-owners.csv");
  const mapping = autoMap("gingr", headers, "clients");

  it("is recognized, and is not called verified", () => {
    expect(detectImportSource(headers)).toBe("gingr");
    expect(isVerifiedSource("gingr")).toBe(false);
  });

  it("First + Last Name combine, Animals become pets, the rest is kept", () => {
    expect(mapping).toMatchObject({
      display_name: null,
      primary_email: "Email",
      primary_phone: "Cell Phone",
      pets: "Animals",
      street: "Address",
      postal_code: "Zip Code",
    });
    const { kept } = everyColumnMappedOrKept("clients", mapping, headers);
    expect(kept).toEqual(
      expect.arrayContaining([
        "Home phone",
        "Referral",
        "Card on File",
        "Last Reservation",
        "Next Reservation",
        "Created At",
        "Receives Email",
        "Receives Text",
      ]),
    );
    const m = mapClientRow(rows[0], mapping);
    expect(m.error).toBeNull();
    expect(m.mapped).toMatchObject({
      display_name: "Priya Sample",
      primary_phone: "+15550100001",
      pets: [
        { name: "Biscuit", breed: "Labrador Retriever" },
        { name: "Mochi", breed: "Shiba Inu" },
      ],
      // "Receives Text: No" is stored, not acted on.
      do_not_text: false,
    });
    expect(mapClientRow(rows[1], mapping).mapped?.pets).toEqual([{ name: "Rex", breed: null }]);
  });
});

// ── Sources with a documented path and no column list ──────────────────────

describe("sample needed", () => {
  it("every source is either verified or a best guess the page says so about", () => {
    expect(VERIFIED_SOURCES).toEqual(["jobber", "time_to_pet"]);
    for (const s of IMPORT_SOURCES) expect(typeof isVerifiedSource(s)).toBe("boolean");
  });
  // Sweep&Go (Client List CSV), Housecall Pro (Customers > Actions > Export),
  // MoeGo (Export Clients) and GorillaDesk (Customers > Action > Export)
  // document the path and not the columns. No fixture is invented for them;
  // each lands when a real file does.
  it.todo("Sweep&Go Client List CSV, once a real file is in hand");
  it.todo("Housecall Pro customer export, once a real file is in hand");
  it.todo("MoeGo Export Clients, once a real file is in hand");
  it.todo("GorillaDesk customer export, once a real file is in hand");
});

// ── The cells ──────────────────────────────────────────────────────────────

describe("pets packed into one cell", () => {
  it.each([
    [
      "Rex, Bella",
      [
        { name: "Rex", breed: null },
        { name: "Bella", breed: null },
      ],
    ],
    [
      "Rex (Lab); Bella (Poodle)",
      [
        { name: "Rex", breed: "Lab" },
        { name: "Bella", breed: "Poodle" },
      ],
    ],
    [
      "Rex & Bella",
      [
        { name: "Rex", breed: null },
        { name: "Bella", breed: null },
      ],
    ],
    [
      "Rex and Bella",
      [
        { name: "Rex", breed: null },
        { name: "Bella", breed: null },
      ],
    ],
    ["Rex, rex", [{ name: "Rex", breed: null }]],
    ["", []],
  ])("%s", (text, want) => {
    expect(parsePetNames(text)).toEqual(want);
  });
});

describe("archived, inactive, status", () => {
  it.each([
    ["Archived", "TRUE", true],
    ["Archived (True/False)", "false", false],
    ["Status", "Inactive", true],
    ["Status", "Active", false],
    ["Active", "No", true],
    ["Active", "Yes", false],
    ["Archived", "", null],
    ["Archived", "maybe", null],
  ])("%s = %s", (col, text, want) => {
    expect(parseInactive(col, text)).toBe(want);
  });
});

describe("dates as exports write them", () => {
  it("reads US month-first, unambiguous day-first, and month names", () => {
    expect(parseImportDate("10/01/2026")).toBe("2026-10-01");
    expect(parseImportDate("25/10/2026")).toBe("2026-10-25");
    expect(parseImportDate("18/03/2025")).toBe("2025-03-18");
    expect(parseImportDate("Oct 1, 2026")).toBe("2026-10-01");
    expect(parseImportDate("1 Oct 2026")).toBe("2026-10-01");
    expect(parseImportDate("13/13/2026")).toBeNull();
  });

  it("dates a timestamp on the business's own clock", () => {
    // 03:30 UTC on Oct 2 is still Oct 1 in Detroit.
    expect(parseImportDate("2026-10-02T03:30:00Z", "America/Detroit")).toBe("2026-10-01");
    expect(parseImportDate("2026-10-02T03:30:00Z")).toBe("2026-10-02");
    // A time with no zone is the date it says.
    expect(parseImportDate("2026-10-02 03:30:00", "America/Detroit")).toBe("2026-10-02");
  });
});

// ── The paused-plan rule ───────────────────────────────────────────────────

describe("imported schedules start paused", () => {
  const m: MappedService = {
    client_external_id: null,
    client_name: "Priya Sample",
    client_email: null,
    frequency: "weekly",
    frequency_in_file: false,
    interval_weeks: null,
    interval_days: null,
    price_cents: 1800,
    preferred_weekdays: null,
    started_on: null,
    dog_count: null,
    billing_cadence: null,
    service_name: null,
  };

  it("the plan row is paused, whatever the file said", () => {
    const row = importPlanRow(m, {
      orgId: "org",
      clientId: "c",
      propertyId: "p",
      zoneId: null,
      isResidential: true,
      dogCount: 1,
      service: null,
      now: "2026-11-11T12:00:00.000Z",
    });
    expect(row).toMatchObject({ status: "paused", paused_at: "2026-11-11T12:00:00.000Z" });
  });

  it("the commit generates no visits", () => {
    const src = read("src/lib/imports.functions.ts");
    expect(src).not.toMatch(/generateVisitHorizon/);
    expect(src).not.toMatch(/visit-generation/);
  });
});

// ── No message, no charge ──────────────────────────────────────────────────

describe("nothing goes out on import", () => {
  const src = read("src/lib/imports.functions.ts");
  const services = read("src/lib/import-services.ts");
  const leftovers = read("src/lib/import-leftovers.ts");

  it("the import modules import nothing that sends, texts, emails, pushes or charges", () => {
    for (const file of [src, services, leftovers]) {
      const imports = [...file.matchAll(/from "([^"]+)"|import\("([^"]+)"\)/g)].map(
        (x) => x[1] ?? x[2],
      );
      for (const spec of imports) {
        expect(spec, `imports.functions reaches ${spec}`).not.toMatch(
          /sms|twilio|email|resend|stripe|push|notif|campaign|messag|reminder|invite|portal-invite|charge/i,
        );
      }
    }
  });

  it("every created client is on the communications hold, and texts are turned off only from the file's own flag", () => {
    expect(src).toMatch(/comms_paused: true,/);
    expect(src).toMatch(/\.\.\.\(m\.do_not_text \? \{ sms_opt_out: true \} : \{\}\)/);
  });
});

// ── The undo guard ─────────────────────────────────────────────────────────

describe("undo per batch", () => {
  const committed = { status: "committed", committed_at: "2026-11-11T12:00:00Z", undone_at: null };
  const unused = { visits: 0, payments: 0, laterInvoices: 0, updated: 0 };

  it("is allowed while nothing from the batch has been used", () => {
    expect(undoRefusal(committed, unused)).toBeNull();
  });

  it("is refused once anything has visits or payments, and says what", () => {
    expect(undoRefusal(committed, { ...unused, visits: 3 })).toMatch(/3 visits on what it added/);
    expect(undoRefusal(committed, { ...unused, payments: 1 })).toMatch(
      /1 payment on what it added/,
    );
    expect(undoRefusal(committed, { ...unused, laterInvoices: 2 })).toMatch(
      /2 invoices written since/,
    );
  });

  it("is refused for a batch that updated clients the business already had", () => {
    expect(undoRefusal(committed, { ...unused, updated: 4 })).toMatch(
      /changed 4 clients you already had/,
    );
  });

  it("is refused for a preview, a canceled batch, or one already undone", () => {
    expect(undoRefusal({ status: "previewing", committed_at: null }, unused)).toMatch(
      /Only an import/,
    );
    expect(undoRefusal({ status: "cancelled", committed_at: null }, unused)).toMatch(
      /Only an import/,
    );
    expect(undoRefusal({ ...committed, undone_at: "2026-11-12T00:00:00Z" }, unused)).toMatch(
      /already been undone/,
    );
    expect(
      importDisplayStatus({ ...committed, created_at: committed.committed_at, undone_at: "x" }),
    ).toBe("undone");
  });

  it("asks first, and says what it deletes and what it leaves alone", () => {
    expect(IMPORT_UNDO_CONFIRM.destructive).toBe(true);
    expect(IMPORT_UNDO_CONFIRM.description).toMatch(/Clients you already had are not touched/);
  });
});

// ── Through the real preview, commit and undo, on a database in memory ─────

let tables: Record<string, Row[] | Record<string, any>[]>;
let seq: number;

/** Just enough of supabase-js for the import: filters, ranges, head counts,
 *  inserts, updates and deletes that change what a later read sees. */
function fakeSupabase() {
  return {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let head = false;
      let from = 0;
      let to = Infinity;
      const filters: ((r: any) => boolean)[] = [];
      const run = async (mode: "many" | "one") => {
        const list = (tables[table] ??= []) as any[];
        if (op === "insert") {
          const items = (Array.isArray(payload) ? payload : [payload]).map((r: any) => ({
            id: r.id ?? `${table}-${++seq}`,
            created_at: new Date().toISOString(),
            ...r,
          }));
          list.push(...items);
          return { data: mode === "many" ? items : items[0], error: null };
        }
        const matched = list.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const r of matched) Object.assign(r, payload);
          return { data: mode === "many" ? matched : (matched[0] ?? null), error: null };
        }
        if (op === "delete") {
          tables[table] = list.filter((r) => !matched.includes(r));
          return { data: matched, error: null };
        }
        if (head) return { data: null, count: matched.length, error: null };
        const page = matched.slice(from, to + 1).map((r) => ({ ...r }));
        return { data: mode === "many" ? page : (page[0] ?? null), error: null };
      };
      const q: any = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) head = true;
          return q;
        },
        insert: (v: unknown) => ((op = "insert"), (payload = v), q),
        update: (v: unknown) => ((op = "update"), (payload = v), q),
        delete: () => ((op = "delete"), q),
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
        neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), q),
        in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
        is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
        not: (k: string, _o: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), q),
        gte: (k: string, v: string) => (filters.push((r) => String(r[k]) >= v), q),
        like: () => q,
        order: () => q,
        range: (a: number, b: number) => ((from = a), (to = b), q),
        limit: (n: number) => ((to = from + n - 1), q),
        single: () => run("one"),
        maybeSingle: () => run("one"),
        then: (res: any, rej: any) => run("many").then(res, rej),
      };
      return q;
    },
  };
}

const context = () => ({ userId: "owner", supabase: fakeSupabase() });
const call = (fn: unknown, data: unknown) =>
  (fn as (i: unknown) => Promise<any>)({ data, context: context() });

beforeEach(() => {
  seq = 0;
  permissionCalls.length = 0;
  visitGeneration.calls = 0;
  tables = {
    import_batches: [],
    import_rows: [],
    clients: [],
    properties: [],
    dogs: [],
    zones: [],
    invoices: [],
    invoice_line_items: [],
    subscriptions: [],
    visits: [],
    payments: [],
    client_notes: [],
    services: [],
    organizations: [
      {
        id: "org",
        timezone: "America/Detroit",
        invoice_net_days: 15,
        service_lines: ["pet_waste"],
      },
    ],
  };
});

describe("the Jobber sample file, previewed and committed", () => {
  const { headers, rows } = fixture("jobber-official-sample.csv");
  const mapping = autoMap("jobber", headers, "clients");

  async function previewAndCommit() {
    const { batchId, stats } = await call(previewImport, {
      source: "jobber",
      entity: "clients",
      filename: "jobber-clients-sample-file.csv",
      mapping,
      rows,
    });
    const result = await call(commitImport, { batchId });
    return { batchId, stats, result };
  }

  it("shows every row's kept columns on the preview", async () => {
    const { batchId, stats } = await call(previewImport, {
      source: "jobber",
      entity: "clients",
      mapping,
      rows,
    });
    expect(stats).toMatchObject({ total: 3, create: 3, errors: 0 });
    const batchRows = (tables.import_rows as any[]).filter((r) => r.batch_id === batchId);
    expect(batchRows[0].mapped.extras).toMatchObject({ "Lead Source": "Google" });
    expect(batchRows[2].mapped.extras).toMatchObject({ "Lead Source": "Yard sign" });
  });

  it("writes the clients with address, raw JSON, a notes summary, inactive flag and opening balances; sends nothing; schedules nothing", async () => {
    const { result } = await previewAndCommit();
    expect(result).toMatchObject({ created: 3, failed: 0, opening_balances: 2 });
    const clients = tables.clients as any[];
    expect(clients).toHaveLength(3);
    const priya = clients.find((c) => c.display_name === "Priya Sample");
    expect(priya).toMatchObject({
      comms_paused: true,
      import_source: "jobber",
      import_extras: expect.objectContaining({
        "Lead Source": "Google",
        "Client Created Date": "2024-03-18",
      }),
    });
    expect(priya.active).toBeUndefined();
    expect(priya.sms_opt_out).toBeUndefined();
    expect(priya.notes).toMatch(/^Side gate sticks; lift and push\nImported from Jobber\. /);
    expect(priya.notes).toMatch(/Lead Source: Google\./);
    // Residential, no dog named anywhere: still imported.
    expect(tables.dogs).toHaveLength(0);
    // The archived client is inactive, with messaging off.
    const marco = clients.find((c) => c.display_name === "Marco Specimen");
    expect(marco).toMatchObject({ active: false, comms_paused: true });
    // Service addresses became properties.
    expect((tables.properties as any[]).map((p) => p.street).sort()).toEqual([
      "12 Example Lane",
      "400 Commerce Blvd, Suite 210",
      "8 Placeholder Ct",
    ]);
    // Account Balance became open invoices, with nothing sent.
    const invoices = tables.invoices as any[];
    expect(invoices.map((i) => [i.status, i.total_cents, i.notes, i.sent_at ?? null])).toEqual([
      ["open", 125000, "Opening balance", null],
      ["open", 4500, "Opening balance", null],
    ]);
    expect(permissionCalls).toContain("manage_client_billing");
    expect(tables.visits).toHaveLength(0);
    expect(visitGeneration.calls).toBe(0);
  });

  it("can be undone while nothing from it is used, and the file can then be imported again", async () => {
    const { batchId } = await previewAndCommit();
    const page = await call(getImportBatch, { batchId });
    expect(page.undoBlock).toBeNull();
    const r = await call(undoImport, { batchId });
    expect(r).toMatchObject({ ok: true, undone: 3 });
    expect(tables.clients).toHaveLength(0);
    expect(tables.properties).toHaveLength(0);
    expect(tables.invoices).toHaveLength(0);
    expect(tables.invoice_line_items).toHaveLength(0);
    const batch = (tables.import_batches as any[]).find((b) => b.id === batchId);
    expect(batch.undone_at).toBeTruthy();
    expect(batch.commit_started_at).toBeNull();
    expect(importDisplayStatus(batch)).toBe("undone");
    // A second tap, and a second undo, are refused.
    await expect(call(undoImport, { batchId })).rejects.toThrow(/already been undone/);
    // The same file previews again as new rows rather than "already imported".
    const again = await call(previewImport, { source: "jobber", entity: "clients", mapping, rows });
    expect(again.stats).toMatchObject({ create: 3 });
    const second = (tables.import_batches as any[]).find((b) => b.id === again.batchId);
    expect(second.status).toBe("previewing");
    expect(second.superseded_by ?? null).toBeNull();
  });

  it("is refused once a client from it has a visit, with the reason on the page", async () => {
    const { batchId } = await previewAndCommit();
    const priya = (tables.clients as any[]).find((c) => c.display_name === "Priya Sample");
    (tables.visits as any[]).push({ id: "v1", client_id: priya.id });
    const page = await call(getImportBatch, { batchId });
    expect(page.undoBlock).toMatch(/1 visit on what it added/);
    await expect(call(undoImport, { batchId })).rejects.toThrow(/1 visit on what it added/);
    expect(tables.clients).toHaveLength(3);
  });
});

describe("a Gingr owners file, committed", () => {
  it("makes each owner's Animals their pets, on the address from the same row", async () => {
    const { headers, rows } = fixture("gingr-view-all-owners.csv");
    const mapping = autoMap("gingr", headers, "clients");
    const { batchId } = await call(previewImport, {
      source: "gingr",
      entity: "clients",
      mapping,
      rows,
    });
    const result = await call(commitImport, { batchId });
    expect(result).toMatchObject({ created: 2, pets: 3 });
    const props = tables.properties as any[];
    const dogs = tables.dogs as any[];
    const priyaProp = props.find((p) => p.street === "12 Example Lane");
    expect(
      dogs.filter((d) => d.property_id === priyaProp.id).map((d) => [d.name, d.breed]),
    ).toEqual([
      ["Biscuit", "Labrador Retriever"],
      ["Mochi", "Shiba Inu"],
    ]);
    const clients = tables.clients as any[];
    expect(clients[0].import_source).toBe("gingr");
    expect(clients[0].import_extras).toMatchObject({
      Referral: "Google",
      "Card on File": "Yes",
      "Receives Text": "No",
    });
  });
});

describe("the Recurring jobs report, committed", () => {
  it("makes paused plans with no visits, a note that the frequency was not in the file, and the extras", async () => {
    (tables.clients as any[]).push({
      id: "c-priya",
      organization_id: "org",
      display_name: "Priya Sample",
      primary_email: "priya@example.test",
      account_type: "residential",
    });
    (tables.properties as any[]).push({
      id: "p-priya",
      organization_id: "org",
      client_id: "c-priya",
      zone_id: null,
    });
    (tables.services as any[]).push({
      id: "svc",
      organization_id: "org",
      name: "Pet waste removal",
      service_line: "pet_waste",
    });
    const { headers, rows } = fixture("jobber-recurring-jobs.csv");
    const mapping = autoMap("jobber", headers, "services");
    const { batchId, stats } = await call(previewImport, {
      source: "jobber",
      entity: "services",
      mapping,
      rows: [rows[0]],
    });
    expect(stats).toMatchObject({ create: 1, errors: 0 });
    const result = await call(commitImport, { batchId });
    expect(result).toMatchObject({ created: 1, paused_plans: 1 });
    expect(tables.subscriptions).toHaveLength(1);
    expect((tables.subscriptions as any[])[0]).toMatchObject({
      client_id: "c-priya",
      status: "paused",
      frequency: "weekly",
      price_cents: 1800,
      service_id: "svc",
    });
    expect(tables.visits).toHaveLength(0);
    expect(visitGeneration.calls).toBe(0);
    const note = (tables.client_notes as any[])[0];
    expect(note).toMatchObject({ client_id: "c-priya", audience: "office" });
    expect(note.body).toMatch(/did not say how often/);
    expect(note.body).toMatch(/Job #: 1041/);
  });
});
