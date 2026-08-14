// A stand-in for the service-role Supabase client, for testing handlers whose
// interesting cases are the ones where they MUST NOT write.
//
// Proving "the attacker's event did not mark the victim's invoice paid" against
// a real database means either accepting that a broken guard marks a real
// invoice paid, or building the fixture in production. Neither is acceptable.
// A fake also makes the assertion stronger: "no row was inserted" is a fact
// about the call, where "nothing changed" against a live database can just as
// easily mean the ids happened not to exist.
//
// Deliberately small. It models the parts of PostgREST these handlers actually
// use, and nothing else — a fake that grows past its callers stops being a test
// double and becomes a second database to keep correct.

import { createHmac } from "node:crypto";

export type Row = Record<string, unknown>;
export type Write = { table: string; op: string; payload: unknown };
export type Result = { data: Row[] | Row | null; error: { message: string } | null };

export type Builder = PromiseLike<Result> & {
  select: () => Builder;
  update: (p: Row) => Builder;
  insert: (p: Row | Row[]) => Builder;
  upsert: (p: Row | Row[], opts?: { onConflict?: string }) => Builder;
  eq: (k: string, v: unknown) => Builder;
  neq: (k: string, v: unknown) => Builder;
  in: (k: string, v: unknown[]) => Builder;
  /** PostgREST `.is(col, null)` — IS NULL. Used by every conditional claim in
   *  this codebase (`.is("billed_at", null)`, `.is("warned_at", null)`), which
   *  is how a job that must run once proves it is the one running it. */
  is: (k: string, v: null) => Builder;
  maybeSingle: () => Promise<Result>;
  single: () => Promise<Result>;
};

export type FakeAdmin = {
  from: (table: string) => Builder;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: null }>;
};

export type Fake = {
  admin: FakeAdmin;
  /** Seeded rows, mutated in place by writes — assert against these. */
  tables: Record<string, Row[]>;
  /** Every write attempted, including ones that matched no row. */
  writes: Write[];
  rpcs: Array<{ fn: string; args: Record<string, unknown> }>;
  /** Replace the seed and clear the recordings. Call from beforeEach. */
  reset: (tables?: Record<string, Row[]>) => void;
  /** Answer an RPC and/or record its side effect on the fake tables. */
  onRpc: (fn: string, impl: (args: Record<string, unknown>) => unknown) => void;
};

export function createFakeAdmin(): Fake {
  const fake = {
    tables: {} as Record<string, Row[]>,
    writes: [] as Write[],
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  };
  const rpcImpls = new Map<string, (args: Record<string, unknown>) => unknown>();

  function builder(table: string): Builder {
    const filters: Array<[string, "eq" | "neq" | "in" | "is", unknown]> = [];
    let op: "select" | "update" | "insert" | "upsert" = "select";
    let payload: Row | Row[] = {};
    let conflictKey: string | undefined;

    const matched = () =>
      (fake.tables[table] ?? []).filter((r) =>
        filters.every(([k, kind, v]) =>
          kind === "eq"
            ? r[k] === v
            : kind === "neq"
              ? r[k] !== v
              : kind === "is"
                ? // `.is(col, null)` matches SQL NULL. A column absent from a
                  // fixture row is null in the database's terms, so `?? null`
                  // — otherwise a claim like `.is("billed_at", null)` matches
                  // nothing and every "runs once" test passes vacuously.
                  (r[k] ?? null) === v
                : (v as unknown[]).includes(r[k]),
        ),
      );

    const rowsOf = (p: Row | Row[]) => (Array.isArray(p) ? p : [p]);

    const run = async (): Promise<Result> => {
      if (op === "select") return { data: matched(), error: null };

      if (op === "insert") {
        (fake.tables[table] ??= []).push(...rowsOf(payload).map((r) => ({ ...r })));
        fake.writes.push({ table, op, payload });
        return { data: null, error: null };
      }

      if (op === "upsert") {
        const store = (fake.tables[table] ??= []);
        for (const r of rowsOf(payload)) {
          // Without an explicit conflict target PostgREST uses the primary key.
          // `id` is the primary key of every table this is used against.
          const key = conflictKey ?? "id";
          const found = store.find((e) => e[key] === r[key]);
          if (found) Object.assign(found, r);
          else store.push({ ...r });
        }
        fake.writes.push({ table, op, payload });
        return { data: null, error: null };
      }

      // update: the matched set is captured BEFORE the patch is applied, so a
      // `.neq("status","paid")` claim sees the pre-update state exactly as
      // Postgres does — which is the whole point of an atomic claim.
      const hit = matched();
      for (const r of hit) Object.assign(r, payload);
      fake.writes.push({ table, op, payload });
      return { data: hit.map((r) => ({ ...r })), error: null };
    };

    const api: Builder = {
      select: () => api,
      update: (p) => ((op = "update"), (payload = p), api),
      insert: (p) => ((op = "insert"), (payload = p), api),
      upsert: (p, opts) => ((op = "upsert"), (payload = p), (conflictKey = opts?.onConflict), api),
      eq: (k, v) => (filters.push([k, "eq", v]), api),
      neq: (k, v) => (filters.push([k, "neq", v]), api),
      in: (k, v) => (filters.push([k, "in", v]), api),
      is: (k, v) => (filters.push([k, "is", v]), api),
      // `.update(...).select(...).maybeSingle()` is a WRITE that returns the
      // row, and PostgREST applies it. This used to read `matched()` directly,
      // so the pending update never ran and the pattern looked like a silent
      // no-op write — a test could assert the returned row and never notice the
      // column had not changed. Only a bare `.select()` may skip run().
      maybeSingle: async () => {
        if (op === "select") return { data: matched()[0] ?? null, error: null };
        const { data, error } = await run();
        return { data: (data as Row[] | null)?.[0] ?? null, error };
      },
      single: async () => {
        if (op !== "select") {
          const { data, error } = await run();
          const rows = (data as Row[] | null) ?? [];
          return rows.length === 1
            ? { data: rows[0], error }
            : { data: null, error: { message: "no rows" } };
        }
        const rows = matched();
        return rows.length === 1
          ? { data: rows[0], error: null }
          : { data: null, error: { message: "no rows" } };
      },
      then: (res, rej) => run().then(res, rej),
    };
    return api;
  }

  const admin: FakeAdmin = {
    from: (t) => builder(t),
    rpc: async (fn, args) => {
      fake.rpcs.push({ fn, args });
      return { data: rpcImpls.get(fn)?.(args) ?? null, error: null };
    },
  };

  return {
    admin,
    get tables() {
      return fake.tables;
    },
    get writes() {
      return fake.writes;
    },
    get rpcs() {
      return fake.rpcs;
    },
    reset(tables = {}) {
      fake.tables = tables;
      fake.writes = [];
      fake.rpcs = [];
    },
    onRpc(fn, impl) {
      rpcImpls.set(fn, impl);
    },
  };
}

/** Stripe's scheme: `t=<unix>,v1=<hmac-sha256(`${t}.${payload}`, secret)>`.
 *  Signing needs no Stripe account: verification is an HMAC against whatever
 *  the webhook secret env var is set to, so a test sets it and signs with the
 *  same value. No network, runs in CI. */
export function stripeSignature(
  payload: string,
  secret: string,
  at = Math.floor(Date.now() / 1000),
): string {
  const sig = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex");
  return `t=${at},v1=${sig}`;
}
