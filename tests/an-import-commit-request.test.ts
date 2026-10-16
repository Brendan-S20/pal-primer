import { beforeEach, expect, it, vi } from "vitest";

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
vi.mock("@/lib/authz.server", () => ({ requirePermission: vi.fn(async () => ({ orgId: "org" })) }));
import { commitImport } from "@/lib/imports.functions";

let batch: Record<string, unknown>;
let clients: Record<string, unknown>[];
let inserted: Record<string, unknown>[];
let actions: string[];

beforeEach(() => {
  batch = {
    id: "batch",
    organization_id: "org",
    source: "jobber",
    entity: "clients",
    status: "previewing",
    created_at: new Date().toISOString(),
    content_hash: "hash",
    commit_started_at: null,
    superseded_by: null,
    stats: { total: 1 },
  };
  clients = [];
  inserted = [];
  actions = [];
});

function backend() {
  return {
    rpc: async () => ({ data: true, error: null }),
    from(table: string) {
      let operation = "select";
      let payload: Record<string, unknown> = {};
      const filters: [string, string, unknown][] = [];
      const run = () => {
        if (table === "import_batches") {
          if (operation === "update") {
            const matches = filters.every(([op, key, value]) => {
              if (op === "eq" || op === "is") return batch[key] === value;
              if (op === "neq") return batch[key] !== value;
              if (op === "gte") return String(batch[key]) >= String(value);
              return true;
            });
            if (!matches) return { data: null, error: null };
            Object.assign(batch, payload);
            return { data: { id: batch.id }, error: null };
          }
          if (filters.some(([op, key]) => op === "neq" && key === "id"))
            return { data: [], error: null };
          return { data: { ...batch }, error: null };
        }
        if (table === "clients") {
          if (operation === "insert") {
            inserted.push(payload);
            return { data: { id: "new-client" }, error: null };
          }
          return { data: clients, error: null };
        }
        if (table === "import_rows") {
          if (operation === "update") {
            if (payload.action) actions.push(payload.action);
            return { data: null, error: null };
          }
          return {
            data: [
              {
                id: "row",
                action: "create",
                target_id: null,
                mapped: { display_name: "Sample Client", primary_email: "sample@example.test" },
              },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      };
      const query = {
        select: () => query,
        order: () => query,
        range: () => query,
        limit: () => query,
        in: () => query,
        not: () => query,
        update: (value: Record<string, unknown>) => {
          operation = "update";
          payload = value;
          return query;
        },
        insert: (value: Record<string, unknown>) => {
          operation = "insert";
          payload = value;
          return query;
        },
        single: async () => run(),
        maybeSingle: async () => run(),
        then: (resolve: (value: unknown) => void) => Promise.resolve(run()).then(resolve),
      };
      return Object.assign(
        query,
        Object.fromEntries(
          ["eq", "neq", "is", "gte"].map((op) => [
            op,
            (key: string, value: unknown) => {
              filters.push([op, key, value]);
              return query;
            },
          ]),
        ),
      );
    },
  };
}

function commit(supabase = backend()) {
  return (commitImport as unknown as (input: unknown) => Promise<Record<string, unknown>>)({
    data: { batchId: "batch" },
    context: { userId: "owner", supabase },
  });
}

it("two concurrent requests create the client once; a later retry is refused", async () => {
  const supabase = backend();
  const results = await Promise.allSettled([commit(supabase), commit(supabase)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(inserted).toHaveLength(1);
  await expect(commit(supabase)).rejects.toThrow(/already been committed/);
  expect(inserted).toHaveLength(1);
});

it("skips a client added after the preview was generated", async () => {
  clients = [{ id: "existing", primary_email: "sample@example.test" }];
  expect(await commit()).toMatchObject({ created: 0, skipped: 1, failed: 0 });
  expect(inserted).toHaveLength(0);
  expect(actions).toEqual(["skip"]);
});

it.each(["stale", "superseded"])("refuses a %s preview before creating rows", async (reason) => {
  if (reason === "stale") batch.created_at = new Date(Date.now() - 25 * 3600_000).toISOString();
  else Object.assign(batch, { status: "cancelled", superseded_by: "winner" });
  await expect(commit()).rejects.toThrow(reason === "stale" ? /24 hours/ : /already imported/);
  expect(inserted).toHaveLength(0);
});
