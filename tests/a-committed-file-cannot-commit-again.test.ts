// #434: a stale preview of a file that had already gone in still said
// "Commit import (311 rows)", and one click would have created all 311
// clients a second time.
//
// Re-checked on main on 2026-11-02, after #590 and #677. It no longer
// reproduces, and these tests are the proof. They run the real previewImport,
// getImportBatch and commitImport against a small database in memory, which
// also enforces the unique index import_batches_one_commit_per_file
// (20261015090000_an-import-went-in-twice.sql), and check one thing at the
// end of every case: the business has 311 imported clients, never 622.
//
// The rows carry a name and nothing else on purpose. The commit's duplicate
// detection matches on old-system id, email, phone, or name at the same
// street, so a name alone does not match and would be created again. Nothing
// but the commit guard stands between these rows and a second copy.
//
// Office manager: commitImport and getImportBatch are gated on
// manage_imports, which owner and office manager both hold, and the
// import_batches policies are scoped to the business, not to whoever made the
// batch (20261029090000). So an office manager sees the owner's committed
// batch and is refused exactly as the owner is. The cases below are run as
// both.

/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory query builder */
import { beforeEach, describe, expect, it, vi } from "vitest";

const permissionCalls: { userId: string; permission: string }[] = [];

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
  requirePermission: vi.fn(async (_s: unknown, userId: string, permission: string) => {
    permissionCalls.push({ userId, permission });
    return { orgId: "org" };
  }),
  resolveCaller: vi.fn(async (_s: unknown, userId: string) => ({
    orgId: "org",
    role: userId === "owner" ? "owner" : "office_manager",
  })),
}));
vi.mock("@/lib/geocode.server", () => ({
  geocodeAddresses: vi.fn(async (list: unknown[]) => list.map(() => null)),
  geocodeAddress: vi.fn(async () => null),
}));

import { commitImport, getImportBatch, previewImport } from "@/lib/imports.functions";
import { IMPORT_PREVIEW_TTL_MS, refusalMessage } from "@/lib/import-commit-guard";

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let seq: number;

/** True when a row is held by import_batches_one_commit_per_file. */
const inFileIndex = (r: Row) => r.content_hash != null && r.commit_started_at != null;

/** Just enough of supabase-js for the import, plus the unique index that
 *  allows one claimed or committed batch per file per business. */
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
          if (table === "import_batches") {
            for (const r of matched) {
              const next = { ...r, ...payload };
              const clash = list.some(
                (o) =>
                  o.id !== r.id &&
                  inFileIndex(o) &&
                  inFileIndex(next) &&
                  o.organization_id === next.organization_id &&
                  o.content_hash === next.content_hash,
              );
              if (clash) {
                return {
                  data: null,
                  error: { code: "23505", message: "import_batches_one_commit_per_file" },
                };
              }
            }
          }
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

type Caller = "owner" | "office-manager";
const context = (userId: Caller) => ({ userId, supabase: fakeSupabase() });
const preview = (rows: Row[], userId: Caller = "owner") =>
  (previewImport as unknown as (i: unknown) => Promise<{ batchId: string; stats: Row }>)({
    data: {
      source: "jobber",
      entity: "clients",
      filename: "jobber-clients-export.csv",
      mapping: { display_name: "Name" },
      rows,
    },
    context: context(userId),
  });
const commit = (batchId: string, userId: Caller = "owner") =>
  (commitImport as unknown as (i: unknown) => Promise<Row>)({
    data: { batchId },
    context: context(userId),
  });
const load = (batchId: string, userId: Caller = "owner") =>
  (getImportBatch as unknown as (i: unknown) => Promise<Row>)({
    data: { batchId },
    context: context(userId),
  });

/** 311 sample clients with a name and nothing the duplicate check can match. */
const file = (): Row[] =>
  Array.from({ length: 311 }, (_, i) => ({ Name: `Sample Client ${i + 1}` }));

const imported = () => tables.clients.filter((c) => c.import_batch_id).length;
const batch = (id: string) => tables.import_batches.find((b) => b.id === id)!;

/** The state the issue found: a preview of the committed file that still says
 *  'previewing', with nothing marking it closed. The commit's sweep normally
 *  closes it; this is the preview the sweep missed. */
function reopenAsStale(id: string) {
  Object.assign(batch(id), { status: "previewing", superseded_by: null, commit_started_at: null });
}

beforeEach(() => {
  seq = 0;
  permissionCalls.length = 0;
  tables = {
    import_batches: [],
    import_rows: [],
    clients: [],
    properties: [],
    dogs: [],
    zones: [],
  };
});

describe("#434: a file that has been committed cannot be committed again", () => {
  it("the rows are ones the duplicate check would let through, so only the guard stops them", async () => {
    const first = await preview(file());
    await commit(first.batchId);
    expect(imported()).toBe(311);
    // A preview made now still labels every row a create: the names match
    // nothing the commit's duplicate check looks at.
    tables.import_rows
      .filter((r) => r.batch_id === first.batchId)
      .forEach((r) => expect(r.action).not.toBe("skip"));
  });

  for (const who of ["owner", "office-manager"] as const) {
    describe(`as the ${who}`, () => {
      it("a preview made before the commit is closed by it, shows no Commit, and is refused", async () => {
        const first = await preview(file(), "owner");
        const stale = await preview(file(), "owner");
        expect(batch(stale.batchId).content_hash).toBe(batch(first.batchId).content_hash);
        await commit(first.batchId, "owner");
        expect(imported()).toBe(311);

        expect(batch(stale.batchId)).toMatchObject({
          status: "cancelled",
          superseded_by: first.batchId,
        });
        const page = await load(stale.batchId, who);
        expect(page.batch.status).toBe("superseded");
        expect(page.commitBlock).toMatchObject({
          reason: "superseded",
          committedBatchId: first.batchId,
        });
        await expect(commit(stale.batchId, who)).rejects.toThrow(refusalMessage("superseded"));
        expect(imported()).toBe(311);
      });

      it("a stale preview still 'previewing' is found by its file hash, closed, and refused", async () => {
        const first = await preview(file(), "owner");
        const stale = await preview(file(), "owner");
        await commit(first.batchId, "owner");
        reopenAsStale(stale.batchId);

        const page = await load(stale.batchId, who);
        expect(page.commitBlock).toMatchObject({
          reason: "superseded",
          committedBatchId: first.batchId,
        });
        await expect(commit(stale.batchId, who)).rejects.toThrow(refusalMessage("superseded"));
        expect(batch(stale.batchId)).toMatchObject({
          status: "cancelled",
          superseded_by: first.batchId,
        });
        expect(imported()).toBe(311);
      });

      it("a file committed before content_hash existed is matched on its name and rows", async () => {
        const first = await preview(file(), "owner");
        const stale = await preview(file(), "owner");
        await commit(first.batchId, "owner");
        // Both batches as they were in August: no hash, no claim column.
        Object.assign(batch(first.batchId), { content_hash: null, commit_started_at: null });
        reopenAsStale(stale.batchId);
        batch(stale.batchId).content_hash = null;

        const page = await load(stale.batchId, who);
        expect(page.commitBlock).toMatchObject({
          reason: "superseded",
          committedBatchId: first.batchId,
        });
        await expect(commit(stale.batchId, who)).rejects.toThrow(refusalMessage("superseded"));
        expect(imported()).toBe(311);
      });

      it("a preview older than 24 hours is refused even with no committed twin to find", async () => {
        const stale = await preview(file(), "owner");
        batch(stale.batchId).created_at = new Date(
          Date.now() - IMPORT_PREVIEW_TTL_MS - 60_000,
        ).toISOString();
        const page = await load(stale.batchId, who);
        expect(page.commitBlock).toMatchObject({ reason: "stale" });
        await expect(commit(stale.batchId, who)).rejects.toThrow(refusalMessage("stale"));
        expect(imported()).toBe(0);
      });

      it("the committed batch itself cannot be committed again", async () => {
        const first = await preview(file(), "owner");
        await commit(first.batchId, "owner");
        const page = await load(first.batchId, who);
        expect(page.commitBlock).toMatchObject({ reason: "committed" });
        await expect(commit(first.batchId, who)).rejects.toThrow(refusalMessage("committed"));
        expect(imported()).toBe(311);
      });
    });
  }

  it("two previews of one file committed at the same moment: one goes in, the index refuses the other", async () => {
    const a = await preview(file(), "owner");
    const b = await preview(file(), "office-manager");
    const results = await Promise.allSettled([
      commit(a.batchId, "owner"),
      commit(b.batchId, "office-manager"),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason?.message)).toBe(refusalMessage("superseded"));
    expect(imported()).toBe(311);
  });

  it("a double click on one preview commits it once", async () => {
    const a = await preview(file(), "owner");
    const results = await Promise.allSettled([commit(a.batchId), commit(a.batchId)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(imported()).toBe(311);
  });

  it("a different file still commits: the guard is about the same rows, not the same name", async () => {
    const first = await preview(file());
    await commit(first.batchId);
    const changed = file();
    changed[310] = { Name: "Sample Client 312" };
    const next = await preview(changed);
    expect((await load(next.batchId)).commitBlock).toBeNull();
    await commit(next.batchId);
    expect(batch(next.batchId).status).toBe("committed");
  });

  it("every call was gated on manage_imports, whoever made it", async () => {
    const a = await preview(file(), "owner");
    await commit(a.batchId, "office-manager");
    await load(a.batchId, "office-manager");
    expect(new Set(permissionCalls.map((c) => c.permission))).toEqual(new Set(["manage_imports"]));
    expect(permissionCalls.some((c) => c.userId === "office-manager")).toBe(true);
  });
});
