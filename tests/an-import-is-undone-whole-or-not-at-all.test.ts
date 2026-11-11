// An import is undone whole or not at all (#857, review of #879).
//
// The first undo ran eight deletes from the server, one request each, as
// the caller. A user who could import but not bill (manage_imports without
// manage_client_billing) deleted the dogs, plans and properties; the
// invoices silently survived under RLS, which answers a denied delete with
// zero rows and no error; the client delete then failed on
// invoices.client_id's RESTRICT; and the catch block cleared undone_at. The
// business was left with clients that had no address, no pets and no plans,
// and a batch that said it was never undone.
//
// Now the deleting is one call to undo_import_batch (20261111050000), which
// runs every guard first, checks each delete's row count, and rolls the
// whole thing back on any mismatch or error. The server function asks the
// billing permission before calling it, and writes nothing of its own.
//
// Here: the server function against an in-memory backend that emulates the
// call (tests/support/fake-supabase-for-imports.ts), for the two cases the
// review named (no billing permission; a delete that fails partway) and the
// shape of the migration. tests/sql/an-import-is-undone-whole-or-not-at-all
// .proof.sql proves the function itself against a real Postgres when one
// answers (CI's database job).
//
// Also here, Product's follow-up: a billing column that says "after each
// visit" sets the client's billing_frequency as well as the plan's cadence.

/* eslint-disable @typescript-eslint/no-explicit-any -- server functions called as plain functions */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
const permissions = vi.hoisted(() => ({ denied: new Set<string>(), asked: [] as string[] }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: vi.fn(async (_s: unknown, _u: string, permission: string) => {
    permissions.asked.push(permission);
    if (permissions.denied.has(permission)) throw new Error(`Forbidden: ${permission}`);
    return { orgId: "org" };
  }),
  resolveCaller: vi.fn(async () => ({ orgId: "org", role: "owner" })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));
vi.mock("@/lib/visit-generation.server", () => ({
  generateVisitHorizon: vi.fn(async () => {}),
}));

import {
  autoMap,
  commitImport,
  getImportBatch,
  previewImport,
  undoImport,
} from "@/lib/imports.functions";
import { mapServiceRow, parseBillingFrequency } from "@/lib/import-services";
import { UNDO_NEEDS_BILLING } from "@/lib/import-leftovers";
import { importDisplayStatus } from "@/lib/import-commit-guard";
import {
  emptyTables,
  fakeSupabase,
  type FakeOptions,
  type Row,
  type Tables,
} from "./support/fake-supabase-for-imports";

// A proof waits its turn for the shared lock (the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATION_PATH =
  "supabase/migrations/20261111050000_an-import-comes-in-as-it-was-exported.sql";

let tables: Tables;
let fake: FakeOptions;
const context = () => ({ userId: "owner", supabase: fakeSupabase(tables, fake) });
const call = (fn: unknown, data: unknown) =>
  (fn as (i: unknown) => Promise<any>)({ data, context: context() });

function jobberSample(): { headers: string[]; rows: Row[] } {
  const text = readFileSync(
    join(ROOT, "tests/fixtures/imports/jobber-official-sample.csv"),
    "utf8",
  );
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: true });
  return { headers: parsed.meta.fields ?? [], rows: parsed.data };
}

/** A committed Jobber clients file: three clients, two with an opening
 *  balance, one address each. */
async function committedJobberBatch(): Promise<string> {
  const { headers, rows } = jobberSample();
  const mapping = autoMap("jobber", headers, "clients");
  const { batchId } = await call(previewImport, {
    source: "jobber",
    entity: "clients",
    mapping,
    rows,
  });
  const result = await call(commitImport, { batchId });
  expect(result).toMatchObject({ created: 3, opening_balances: 2 });
  return batchId;
}

const counts = () => ({
  clients: tables.clients.length,
  properties: tables.properties.length,
  invoices: tables.invoices.length,
  lines: tables.invoice_line_items.length,
});

beforeEach(() => {
  tables = emptyTables();
  fake = { undoFails: null, rpcCalls: [] };
  permissions.denied.clear();
  permissions.asked.length = 0;
});

describe("undo is one call, and the server writes nothing of its own", () => {
  it("calls undo_import_batch once and reports what it removed", async () => {
    const batchId = await committedJobberBatch();
    const r = await call(undoImport, { batchId });
    expect(r).toMatchObject({ ok: true, undone: 3 });
    expect(fake.rpcCalls?.filter((c) => c.name === "undo_import_batch")).toEqual([
      { name: "undo_import_batch", args: { _batch_id: batchId } },
    ]);
    expect(counts()).toEqual({ clients: 0, properties: 0, invoices: 0, lines: 0 });
    const batch = tables.import_batches.find((b) => b.id === batchId)!;
    expect(importDisplayStatus(batch)).toBe("undone");
  });

  it("asks the billing permission before anything is deleted, because the batch wrote invoices", async () => {
    const batchId = await committedJobberBatch();
    const before = counts();
    permissions.denied.add("manage_client_billing");
    // The page says so rather than offering a button the server refuses.
    const page = await call(getImportBatch, { batchId });
    expect(page.undoBlock).toBe(UNDO_NEEDS_BILLING);
    await expect(call(undoImport, { batchId })).rejects.toThrow(UNDO_NEEDS_BILLING);
    // Refused whole: nothing deleted, the function never called, the batch
    // not undone. This is the case that used to leave half a client.
    expect(counts()).toEqual(before);
    expect(fake.rpcCalls?.some((c) => c.name === "undo_import_batch")).toBe(false);
    const batch = tables.import_batches.find((b) => b.id === batchId)!;
    expect(batch.undone_at ?? null).toBeNull();
    expect(batch.commit_started_at).toBeTruthy();
  });

  it("does not ask the billing permission for a batch that wrote no invoice", async () => {
    const { headers, rows } = jobberSample();
    const mapping = { ...autoMap("jobber", headers, "clients"), balance: null };
    const { batchId } = await call(previewImport, {
      source: "jobber",
      entity: "clients",
      mapping,
      rows,
    });
    await call(commitImport, { batchId });
    expect(tables.invoices).toHaveLength(0);
    permissions.denied.add("manage_client_billing");
    permissions.asked.length = 0;
    const r = await call(undoImport, { batchId });
    expect(r).toMatchObject({ undone: 3 });
    expect(permissions.asked).not.toContain("manage_client_billing");
  });

  it("a delete that fails partway leaves everything in place and the batch not undone", async () => {
    const batchId = await committedJobberBatch();
    const before = counts();
    fake.undoFails = "Undo stopped: expected to remove 1 pet(s), removed 0. Nothing was changed.";
    await expect(call(undoImport, { batchId })).rejects.toThrow(/Undo stopped/);
    expect(counts()).toEqual(before);
    const batch = tables.import_batches.find((b) => b.id === batchId)!;
    expect(batch.undone_at ?? null).toBeNull();
    expect(batch.commit_started_at).toBeTruthy();
    expect(importDisplayStatus(batch)).toBe("committed");
    // And the page still offers it, since nothing about the batch changed.
    const page = await call(getImportBatch, { batchId });
    expect(page.undoBlock).toBeNull();
  });

  it("the server function deletes nothing itself", () => {
    const src = read("src/lib/imports.functions.ts");
    const undo = src.slice(
      src.indexOf("export const undoImport"),
      src.indexOf("export const cancelImport"),
    );
    expect(undo).toMatch(/"undo_import_batch"/);
    expect(undo).toMatch(/supabase\.rpc as unknown as RpcCall/);
    expect(undo).not.toMatch(/\.delete\(\)/);
    expect(undo).not.toMatch(/undone_at:/);
    expect(src).not.toMatch(/deleteWhereIn/);
  });
});

describe("the migration's function", () => {
  const migration = read(MIGRATION_PATH);
  const fn = migration.slice(
    migration.indexOf("CREATE OR REPLACE FUNCTION public.undo_import_batch"),
    migration.indexOf("REVOKE ALL ON FUNCTION public.undo_import_batch"),
  );

  it("is SECURITY DEFINER, callable by authenticated only, and numbered after main's newest", () => {
    expect(fn).toMatch(/SECURITY DEFINER/);
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION public\.undo_import_batch\(uuid\) FROM PUBLIC, anon;/,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.undo_import_batch\(uuid\) TO authenticated, service_role;/,
    );
    expect(
      existsSync(
        join(
          ROOT,
          "supabase/migrations/20261111030000_a-replayed-start-older-than-a-day-meets-todays-rules.sql",
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(ROOT, "supabase/migrations/20261111020000_an-import-comes-in-as-it-was-exported.sql"),
      ),
    ).toBe(false);
  });

  it("checks every permission and the usage before it claims, and the billing permission before any delete", () => {
    const at = (re: RegExp) => {
      const i = fn.search(re);
      expect(i, `${re} not in the function`).toBeGreaterThanOrEqual(0);
      return i;
    };
    const imports = at(/has_permission\(_uid, _b\.organization_id, 'manage_imports'\)/);
    const billing = at(/has_permission\(_uid, _b\.organization_id, 'manage_client_billing'\)/);
    const usage = at(/_visits > 0 OR _payments > 0 OR _later > 0/);
    const claim = at(/SET undone_at = now\(\), commit_started_at = NULL/);
    const firstDelete = at(/DELETE FROM public\./);
    expect(imports).toBeLessThan(usage);
    expect(usage).toBeLessThan(billing);
    expect(billing).toBeLessThan(claim);
    expect(claim).toBeLessThan(firstDelete);
  });

  it("counts every delete against what it expected", () => {
    const deletes = fn.match(/DELETE FROM public\.\w+/g) ?? [];
    const checks =
      fn.match(
        /GET DIAGNOSTICS _got = ROW_COUNT;\s*IF _got <> _expected THEN RAISE EXCEPTION 'Undo stopped/g,
      ) ?? [];
    expect(deletes.length).toBeGreaterThanOrEqual(10);
    expect(checks.length).toBe(deletes.length);
  });
});

describe("billed after each visit", () => {
  it.each([
    ["After each visit", "after_each_visit"],
    ["Per visit", "after_each_visit"],
    ["Per cleanup", "after_each_visit"],
    ["Each job", "after_each_visit"],
    ["Monthly", "monthly"],
    ["Weekly", "weekly"],
    ["Quarterly", "quarterly"],
    ["Annual", "yearly"],
    ["Fixed price", null],
    ["", null],
  ])("%s", (text, want) => {
    expect(parseBillingFrequency(text)).toBe(want);
  });

  it("a Jobber Billing type of Per visit is a postpaid plan AND a client billed after each visit", () => {
    const mapping = autoMap("jobber", ["Client name", "Billing type", "Total ($)"], "services");
    const { mapped, error } = mapServiceRow(
      { "Client name": "Priya Sample", "Billing type": "Per visit", "Total ($)": "18.00" },
      mapping,
    );
    expect(error).toBeNull();
    expect(mapped).toMatchObject({
      billing_cadence: "postpaid",
      billing_frequency: "after_each_visit",
    });
    // "Prepaid monthly" is still a prepaid plan, billed monthly.
    expect(
      mapServiceRow(
        { "Client name": "Priya Sample", "Billing type": "Prepaid monthly", "Total ($)": "18.00" },
        mapping,
      ).mapped,
    ).toMatchObject({ billing_cadence: "prepaid", billing_frequency: "monthly" });
  });

  it("the commit sets the client's billing_frequency from the plan row", async () => {
    tables.clients.push({
      id: "c-priya",
      organization_id: "org",
      display_name: "Priya Sample",
      account_type: "residential",
      billing_frequency: "monthly",
    });
    tables.properties.push({
      id: "p-priya",
      organization_id: "org",
      client_id: "c-priya",
      zone_id: null,
    });
    const mapping = autoMap(
      "jobber",
      ["Client name", "Billing type", "Total ($)", "Visit frequency"],
      "services",
    );
    const { batchId } = await call(previewImport, {
      source: "jobber",
      entity: "services",
      mapping,
      rows: [
        {
          "Client name": "Priya Sample",
          "Billing type": "Per visit",
          "Total ($)": "18.00",
          "Visit frequency": "Weekly",
        },
      ],
    });
    const result = await call(commitImport, { batchId });
    expect(result).toMatchObject({ created: 1 });
    expect(tables.subscriptions[0]).toMatchObject({
      billing_cadence: "postpaid",
      status: "paused",
    });
    expect(tables.clients[0].billing_frequency).toBe("after_each_visit");
  });
});

// ── The database half, when a database answers ─────────────────────────────

const PROOF = join(ROOT, "tests/sql/an-import-is-undone-whole-or-not-at-all.proof.sql");
const DB_URL =
  process.env.IMPORT_UNDO_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the import-undo proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set IMPORT_UNDO_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)("an import undo, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(join(ROOT, MIGRATION_PATH))).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("refuses a dispatcher and a used batch, puts everything back after a failed delete, and undoes whole", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${join(ROOT, MIGRATION_PATH)}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Six groups, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
    expect(out).toMatch(/ALL IMPORT-UNDO PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Undo Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
