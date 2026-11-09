// #656 (audit R2-12, R2-23): an import's preview and its result disagreed.
//
// A 50-row clients file whose row 11 had the same email as row 10 previewed
// as "CREATE 46 · SKIP 1 · ERRORS 3", with row 11 listed as a create. The
// commit then skipped row 11 (it always checked the rows above it in the same
// file) and said "45 created, 1 skipped", counting only its own skip. The
// database held two skipped rows. A ZIP of "ABCDE" and a phone of "12" went
// through as creates.
//
// And dogs could only be imported for clients that had an id from the old
// system, and a file with both "Name" (the client) and "Dog name" mapped the
// dog's name to "Name".
//
// These run the real previewImport and commitImport against a small database
// in memory, and compare the result's counts with the rows it wrote.

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org" })),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));

import { autoMap, commitImport, mapClientRow, previewImport } from "@/lib/imports.functions";
import { commitResultCounts } from "@/lib/import-commit-guard";

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let seq: number;
/** A client insert naming this client is refused, as a check constraint would. */
let refuseClient: string | null;

/** Just enough of supabase-js for the import: filters, ranges, inserts and
 *  updates that change the rows a later read sees. */
function fakeSupabase() {
  return {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      let op: "select" | "insert" | "update" = "select";
      let payload: any = null;
      let head = false;
      let from = 0;
      let to = Infinity;
      const filters: ((r: Row) => boolean)[] = [];
      const run = async (mode: "many" | "one") => {
        const list = (tables[table] ??= []);
        if (op === "insert") {
          const list0 = Array.isArray(payload) ? payload : [payload];
          if (table === "clients" && list0.some((r: Row) => r.display_name === refuseClient)) {
            return { data: null, error: { message: "new row violates a check" } };
          }
          const items = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({
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
const preview = (data: Row) =>
  (previewImport as unknown as (i: unknown) => Promise<{ batchId: string; stats: Row }>)({
    data,
    context: context(),
  });
const commit = (batchId: string) =>
  (commitImport as unknown as (i: unknown) => Promise<Row>)({
    data: { batchId },
    context: context(),
  });

/** How many of this batch's rows are in each state, as the database has them. */
function rowStates(batchId: string) {
  const out: Record<string, number> = { create: 0, update: 0, skip: 0, error: 0 };
  for (const r of tables.import_rows.filter((x) => x.batch_id === batchId)) out[r.action] += 1;
  return out;
}

const HEADERS = ["Name", "Email", "Phone", "Street", "City", "Zip"];

/** 50 clients. Row 11 has row 10's email; row 20 has the phone of a client the
 *  business already has; row 48 has no name, row 49 a ZIP of "ABCDE" and row
 *  50 a phone of "12". */
function fiftyRows(): Row[] {
  return Array.from({ length: 50 }, (_, i) => {
    const n = i + 1;
    const row: Row = {
      Name: `Client ${n}`,
      Email: `client${n}@example.test`,
      Phone: `312555${String(1000 + n).slice(-4)}`,
      Street: `${100 + n} Oak St`,
      City: "Chicago",
      Zip: "60610",
    };
    if (n === 11) row.Email = "client10@example.test";
    if (n === 20) row.Phone = "(312) 555-9999";
    if (n === 48) row.Name = "";
    if (n === 49) row.Zip = "ABCDE";
    if (n === 50) row.Phone = "12";
    return row;
  });
}

beforeEach(() => {
  seq = 0;
  refuseClient = null;
  tables = {
    import_batches: [],
    import_rows: [],
    clients: [
      {
        id: "client-already",
        organization_id: "org",
        display_name: "Someone Else",
        primary_email: null,
        primary_phone: "+13125559999",
        import_source: null,
        import_external_id: null,
      },
    ],
    properties: [],
    dogs: [],
    zones: [],
  };
});

describe("a 50-row clients file with a duplicate inside it", () => {
  const mapping = autoMap("generic_csv", HEADERS, "clients");

  it("is previewed as the commit will treat it: the second row is a skip, and says why", async () => {
    expect(mapping).toMatchObject({
      display_name: "Name",
      primary_email: "Email",
      primary_phone: "Phone",
    });
    const { batchId, stats } = await preview({
      source: "generic_csv",
      entity: "clients",
      mapping: { ...mapping, street: "Street", city: "City", postal_code: "Zip" },
      rows: fiftyRows(),
    });
    expect(stats).toMatchObject({ total: 50, create: 45, skip: 2, errors: 3 });
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    const row = (n: number) => rows.find((r) => r.row_num === n)!;
    expect(row(10)).toMatchObject({ action: "create", error: null });
    expect(row(11)).toMatchObject({
      action: "skip",
      error: "Same email as row 10 in this file. Only row 10 is imported.",
    });
    expect(row(20)).toMatchObject({
      action: "skip",
      target_id: "client-already",
      error: "Already in your clients (same phone number).",
    });
  });

  it("commits with counts that equal the rows it wrote", async () => {
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "clients",
      mapping: { ...mapping, street: "Street", city: "City", postal_code: "Zip" },
      rows: fiftyRows(),
    });
    const result = await commit(batchId);
    const states = rowStates(batchId);
    expect(states).toEqual({ create: 45, update: 0, skip: 2, error: 3 });
    // Was 45 created, 1 skipped, while the database held two skipped rows.
    expect(result).toMatchObject({ created: 45, skipped: 2, failed: 0, updated: 0 });
    expect(commitResultCounts(result)).toEqual({
      created: states.create,
      updated: states.update,
      skipped: states.skip,
      failed: states.error,
    });
    const batch = tables.import_batches.find((b) => b.id === batchId)!;
    expect(commitResultCounts(batch.stats)).toEqual(commitResultCounts(result));
    expect(tables.clients.filter((c) => c.import_batch_id === batchId)).toHaveLength(45);
    expect(tables.clients.filter((c) => c.primary_email === "client10@example.test")).toHaveLength(
      1,
    );
  });

  it("points the skipped repeat at the client its first row made", async () => {
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "clients",
      mapping: { ...mapping, street: "Street", city: "City", postal_code: "Zip" },
      rows: fiftyRows(),
    });
    await commit(batchId);
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    const ten = rows.find((r) => r.row_num === 10)!;
    expect(ten.target_id).toBeTruthy();
    expect(rows.find((r) => r.row_num === 11)).toMatchObject({
      action: "skip",
      target_id: ten.target_id,
    });
  });

  it("fails the repeat when its first row fails, and the counts still equal the rows", async () => {
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "clients",
      mapping: { ...mapping, street: "Street", city: "City", postal_code: "Zip" },
      rows: fiftyRows(),
    });
    refuseClient = "Client 10";
    const result = await commit(batchId);
    const states = rowStates(batchId);
    expect(states).toEqual({ create: 44, update: 0, skip: 1, error: 5 });
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    expect(rows.find((r) => r.row_num === 11)).toMatchObject({
      action: "error",
      error: "The same client appears earlier in this file, and that row could not be imported.",
    });
    expect(result).toMatchObject({ created: 44, skipped: 1, failed: 2 });
    expect(commitResultCounts(result)).toEqual({
      created: states.create,
      updated: states.update,
      skipped: states.skip,
      failed: states.error,
    });
  });

  it("flags a ZIP that is not one and a phone that is not whole, in the preview", async () => {
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "clients",
      mapping: { ...mapping, street: "Street", city: "City", postal_code: "Zip" },
      rows: fiftyRows(),
    });
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    expect(rows.find((r) => r.row_num === 49)).toMatchObject({
      action: "error",
      error: 'ZIP "ABCDE" is not a ZIP code (5 digits, ZIP+4, or a Canadian postal code)',
    });
    expect(rows.find((r) => r.row_num === 50)).toMatchObject({
      action: "error",
      error: 'Phone "12" is not a full phone number (10 digits, or + and the country code)',
    });
  });
});

describe("ZIP and phone rules", () => {
  const m = { display_name: "Name", primary_phone: "Phone", postal_code: "Zip" };
  const one = (Phone: string, Zip: string) => mapClientRow({ Name: "A", Phone, Zip }, m);

  it("keeps the ZIPs and phones a real export has", () => {
    expect(one("312-555-0100", "60610").mapped).toMatchObject({
      primary_phone: "+13125550100",
      postal_code: "60610",
    });
    expect(one("1 (312) 555-0100", "60610-1234").mapped?.postal_code).toBe("60610-1234");
    expect(one("312.555.0100 ext. 12", "606101234").mapped?.postal_code).toBe("60610-1234");
    expect(one("+44 20 7946 0958", "k1a0b1").mapped?.postal_code).toBe("K1A 0B1");
    // A spreadsheet dropped the leading zero of a New England ZIP.
    expect(one("3125550100", "2134").mapped?.postal_code).toBe("02134");
    expect(one("", "").error).toBeNull();
  });

  it("refuses the ones that are not", () => {
    for (const zip of ["ABCDE", "606", "6061O", "123456"])
      expect(one("3125550100", zip).error).toMatch(/^ZIP /);
    for (const phone of ["12", "555-0100", "312-555-01000", "2125550100100"]) {
      expect(one(phone, "60610").error).toMatch(/^Phone /);
    }
  });
});

describe("dogs for clients with no id from the old system", () => {
  const HEADERS_DOGS = ["Name", "Email", "Phone", "Dog name", "Breed"];

  it("maps the dog's name to 'Dog name', not to the client's 'Name'", () => {
    const mapping = autoMap("generic_csv", HEADERS_DOGS, "dogs");
    expect(mapping).toMatchObject({
      name: "Dog name",
      client_email: "Email",
      client_phone: "Phone",
      client_external_id: null,
    });
    expect(autoMap("sweepgo", ["Client Name", "Dog Name"], "dogs")).toMatchObject({
      name: "Dog Name",
      client_name: "Client Name",
    });
  });

  it("finds each dog's client by email, phone or name, and imports it", async () => {
    tables.clients.push(
      {
        id: "c-email",
        organization_id: "org",
        display_name: "Ana Ruiz",
        primary_email: "ana@example.test",
        primary_phone: null,
      },
      {
        id: "c-phone",
        organization_id: "org",
        display_name: "Bo Li",
        primary_email: null,
        primary_phone: "+13125550142",
      },
      {
        id: "c-name",
        organization_id: "org",
        display_name: "Cy Park",
        primary_email: null,
        primary_phone: null,
      },
    );
    tables.properties.push(
      { id: "p-email", organization_id: "org", client_id: "c-email" },
      { id: "p-phone", organization_id: "org", client_id: "c-phone" },
      { id: "p-name", organization_id: "org", client_id: "c-name" },
    );
    const mapping = { ...autoMap("generic_csv", HEADERS_DOGS, "dogs"), client_name: "Name" };
    const { batchId, stats } = await preview({
      source: "generic_csv",
      entity: "dogs",
      mapping,
      rows: [
        {
          Name: "Ana Ruiz",
          Email: "ANA@example.test",
          Phone: "",
          "Dog name": "Biscuit",
          Breed: "Lab",
        },
        { Name: "B. Li", Email: "", Phone: "312-555-0142", "Dog name": "Mochi", Breed: "" },
        { Name: "Cy Park", Email: "", Phone: "", "Dog name": "Rex", Breed: "" },
        { Name: "Nobody", Email: "nobody@example.test", Phone: "", "Dog name": "Ghost", Breed: "" },
      ],
    });
    expect(stats).toMatchObject({ create: 3, errors: 1 });
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    expect(rows.map((r) => [r.row_num, r.action, r.target_id])).toEqual([
      [1, "create", "c-email"],
      [2, "create", "c-phone"],
      [3, "create", "c-name"],
      [4, "error", null],
    ]);
    expect(rows[3].error).toBe('No client called "Nobody" (import clients first)');

    const result = await commit(batchId);
    expect(result).toMatchObject({ created: 3, failed: 0 });
    expect(tables.dogs.map((d) => [d.name, d.property_id])).toEqual([
      ["Biscuit", "p-email"],
      ["Mochi", "p-phone"],
      ["Rex", "p-name"],
    ]);
  });

  it("refuses a dog whose email or phone two clients share, rather than picking one", async () => {
    tables.clients.push(
      {
        id: "c-1",
        organization_id: "org",
        display_name: "Ana",
        primary_email: "home@example.test",
        primary_phone: "+13125550142",
      },
      {
        id: "c-2",
        organization_id: "org",
        display_name: "Bo",
        primary_email: "home@example.test",
        primary_phone: "+13125550142",
      },
    );
    const mapping = autoMap("generic_csv", HEADERS_DOGS, "dogs");
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "dogs",
      mapping,
      rows: [
        { Name: "", Email: "home@example.test", Phone: "", "Dog name": "Biscuit", Breed: "" },
        { Name: "", Email: "", Phone: "312-555-0142", "Dog name": "Mochi", Breed: "" },
      ],
    });
    const rows = tables.import_rows.filter((r) => r.batch_id === batchId);
    expect(rows.map((r) => [r.action, r.error])).toEqual([
      ["error", "More than one client has the email home@example.test; add an ID column"],
      ["error", "More than one client has the phone 312-555-0142; add an ID column"],
    ]);
  });

  it("refuses a dog row that names no client at all, and says what to add", async () => {
    const { batchId } = await preview({
      source: "generic_csv",
      entity: "dogs",
      mapping: { name: "Dog name" },
      rows: [{ "Dog name": "Biscuit" }],
    });
    expect(tables.import_rows.find((r) => r.batch_id === batchId)).toMatchObject({
      action: "error",
      error: "Missing the client: their ID in your old system, email, phone or name",
    });
  });
});
