// Rigel's review of #1069 at 64eb54c9: a row whose name two of the
// business's clients share was skipped in preview with that reason, then
// failed at commit as "the same client appears earlier in this file". It
// appears once. Real Housecall Pro customers (two "Sam Research" records),
// then the real Sweep&Go client list and Referral Sources, with Sam added.
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
import { SHARED_NAME_REASON } from "@/lib/import-commit-guard";
import { tableFromCsv } from "@/lib/import-file-table";
import { emptyTables, fakeSupabase, type Tables } from "./support/fake-supabase-for-imports";

const FIXTURES = join(import.meta.dirname, "fixtures", "imports");

function read(name: string) {
  const text = readFileSync(join(FIXTURES, name), "utf8");
  return tableFromCsv(Papa.parse<string[]>(text, { skipEmptyLines: true }).data);
}

let tables: Tables;
const call = (fn: unknown, data: unknown) =>
  (fn as (i: unknown) => Promise<any>)({
    data,
    context: { userId: "owner", supabase: fakeSupabase(tables) },
  });

async function importFile(name: string, extra: Record<string, string>[] = []) {
  const file = read(name);
  const source = detectImportSource(file.headers);
  const entity = detectImportEntity(file.headers) as ImportEntity;
  const mapping = autoMap(source, file.headers, entity);
  const rows = [...file.rows, ...extra];
  const { batchId, stats } = await call(previewImport, { source, entity, mapping, rows });
  return { batchId, stats, result: await call(commitImport, { batchId }) };
}

beforeEach(() => {
  tables = emptyTables();
});

describe("a name two clients share stays skipped through commit", () => {
  it("is skipped with its own reason, not failed as a repeat in the file", async () => {
    await importFile("housecall-pro-customers.csv");
    await importFile("sweepgo-client-list.csv");
    const sams = () =>
      (tables.clients as any[]).filter((c) => c.display_name === "Sam Research").length;
    const before = sams();
    expect(before).toBeGreaterThanOrEqual(2);

    const { batchId, stats, result } = await importFile("sweepgo-referral-sources.csv", [
      {
        "Signup Date": "2026-11-27",
        "Client Name": "Sam Research",
        "Referral Source": "Other",
        "Referral Detail": "",
        "Tracking Link": "",
      },
    ]);
    const rows = (tables.import_rows as any[]).filter((r) => r.batch_id === batchId);
    const sam = rows.find((r) => r.mapped?.display_name === "Sam Research");
    expect(sam).toMatchObject({ action: "skip", target_id: null, error: SHARED_NAME_REASON });
    expect(rows.filter((r) => r.action === "error")).toEqual([]);
    expect(result.failed ?? 0).toBe(0);
    expect(result.skipped).toBe(stats.skip ?? stats.skipped);
    expect(sams()).toBe(before);
  });
});
