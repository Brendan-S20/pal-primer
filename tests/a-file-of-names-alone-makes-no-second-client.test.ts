// Rigel's review of #1069 at 8ee24911: Sweep&Go's Referral Sources report
// has a signup date, the client's name and the referral source, nothing
// else. Imported after the Client List, every row made a second copy of its
// client, because a name alone matched no one. Now a row with only a name is
// the one client of that name. Both files are the real exports in
// tests/fixtures/imports.
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

beforeEach(() => {
  tables = emptyTables();
});

describe("Sweep&Go: client list, then referral sources", () => {
  it("makes no second copy of any client", async () => {
    await importFile("sweepgo-client-list.csv");
    const before = tables.clients.length;
    expect(before).toBeGreaterThan(0);
    const { stats, result } = await importFile("sweepgo-referral-sources.csv");
    expect(stats.create ?? 0).toBe(0);
    expect(result.created ?? 0).toBe(0);
    expect(tables.clients).toHaveLength(before);
  });
});
