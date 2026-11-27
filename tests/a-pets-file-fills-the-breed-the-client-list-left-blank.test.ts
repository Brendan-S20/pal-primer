// Rigel's review of #1069 at da4554c6: Time To Pet's client list names each
// client's pets ("Pet Names"), so it makes the dogs with no breed. The pets
// file read next has the breeds, and every dog in it was skipped as already
// there, so the breeds were lost. Now a dog with no breed yet is updated
// with the file's breed, and only the breed; a dog that has one is skipped.
// Both files are the real exports in tests/fixtures/imports.
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
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org" })),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));
vi.mock("@/lib/visit-generation.server", () => ({ generateVisitHorizon: vi.fn(async () => {}) }));

import {
  autoMap,
  commitImport,
  detectImportEntity,
  detectImportSource,
  previewImport,
  type ImportEntity,
} from "@/lib/imports.functions";
import { tableFromCsv } from "@/lib/import-file-table";
import { emptyTables, fakeSupabase, type Tables } from "./support/fake-supabase-for-imports";

const FIXTURES = join(import.meta.dirname, "fixtures", "imports");

function load(name: string) {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  const table = tableFromCsv(Papa.parse<string[]>(text, { skipEmptyLines: true }).data);
  const source = detectImportSource(table.headers)!;
  const entity = detectImportEntity(table.headers) as ImportEntity;
  return { source, entity, rows: table.rows, mapping: autoMap(source, table.headers, entity) };
}

let tables: Tables;
const call = (fn: unknown, data: unknown) =>
  (fn as (i: unknown) => Promise<any>)({
    data,
    context: { userId: "owner", supabase: fakeSupabase(tables) },
  });

async function importFile(name: string) {
  const f = load(name);
  const { batchId, stats } = await call(previewImport, {
    source: f.source,
    entity: f.entity,
    mapping: f.mapping,
    rows: f.rows,
  });
  return { stats, result: await call(commitImport, { batchId }) };
}

/** The in-memory backend does not join; the dog's client is what
 *  `properties!inner(client_id)` reads in Postgres. */
function joinDogsToClients() {
  for (const d of tables.dogs as any[]) {
    const p = (tables.properties as any[]).find((x) => x.id === d.property_id);
    d.properties = { client_id: p?.client_id };
  }
}

const breeds = () => (tables.dogs as any[]).map((d) => [d.name, d.breed ?? null]).sort();

beforeEach(() => {
  tables = emptyTables();
});

describe("Time To Pet: client list, then pets file", () => {
  it("fills in the breeds the client list could not know", async () => {
    await importFile("time-to-pet-client-list.csv");
    const before = breeds();
    expect(before.length).toBeGreaterThan(0);
    expect(before.every(([, b]) => b === null)).toBe(true);
    joinDogsToClients();

    const { stats, result } = await importFile("time-to-pet-petlist-pets.csv");
    expect(stats.update).toBe(before.length);
    expect(result).toMatchObject({ created: 0, updated: before.length });
    expect(breeds().every(([, b]) => typeof b === "string" && b.length > 0)).toBe(true);
    // No second copy of any dog.
    expect(tables.dogs).toHaveLength(before.length);
  });

  it("a dog that already has a breed keeps it, and the row is skipped", async () => {
    await importFile("time-to-pet-client-list.csv");
    joinDogsToClients();
    for (const d of tables.dogs as any[]) d.breed = "Set by hand";
    const { stats } = await importFile("time-to-pet-petlist-pets.csv");
    expect(stats.update ?? 0).toBe(0);
    expect(breeds().every(([, b]) => b === "Set by hand")).toBe(true);
  });
});
