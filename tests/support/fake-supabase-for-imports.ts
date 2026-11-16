// Just enough of supabase-js for the import's server functions: filters,
// ranges, head counts, inserts, updates and deletes that change what a later
// read sees, and the one RPC the undo makes (#857).
//
// undo_import_batch (20261111050000) is one transaction in Postgres: every
// guard first, every delete's row count checked, everything rolled back on
// any error. The emulation here keeps the same shape, so a test can prove the
// server function calls it once and writes nothing of its own: `undoFails`
// makes the call answer with an error and change nothing, as a raised
// exception would.

/* eslint-disable @typescript-eslint/no-explicit-any -- an in-memory query builder */

export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;

export type FakeOptions = {
  /** When set, undo_import_batch answers with this error and deletes nothing. */
  undoFails?: string | null;
  /** Every rpc call, in order. */
  rpcCalls?: { name: string; args: unknown }[];
  /** Return an error before a query runs, without changing its rows. */
  beforeQuery?: (query: {
    table: string;
    operation: "select" | "insert" | "update" | "delete";
    payload: any;
  }) => string | null | void;
  /** Add concurrent work after an insert, before the import's next query. */
  afterInsert?: (table: string, rows: Row[]) => void;
};

/** What undo_import_batch deletes for a clients batch, in memory: the same
 *  tables, the same order, all or nothing. */
function undoImportBatch(tables: Tables, batchId: string): { data: any; error: any } {
  const batch = (tables.import_batches ?? []).find((b) => b.id === batchId);
  if (!batch) return { data: null, error: { message: "This import no longer exists." } };
  if (batch.undone_at) {
    return { data: null, error: { message: "This import has already been undone." } };
  }
  const entity = batch.entity ?? "clients";
  const ids = new Set<string>(
    (tables.import_rows ?? [])
      .filter((r) => r.batch_id === batchId && r.action === "create" && r.target_id)
      .map((r) => r.target_id as string),
  );
  if (entity === "clients") {
    for (const c of tables.clients ?? []) if (c.import_batch_id === batchId) ids.add(c.id);
  }
  const has = (k: string) => (r: Row) => ids.has(r[k]);
  const not = (f: (r: Row) => boolean) => (r: Row) => !f(r);
  let removed = 0;
  const drop = (table: string, f: (r: Row) => boolean) => {
    const list = tables[table] ?? [];
    removed += list.filter(f).length;
    tables[table] = list.filter(not(f));
  };
  if (entity === "clients") {
    const propIds = new Set((tables.properties ?? []).filter(has("client_id")).map((p) => p.id));
    const invIds = new Set((tables.invoices ?? []).filter(has("client_id")).map((i) => i.id));
    drop("dogs", (r) => propIds.has(r.property_id));
    drop("subscriptions", has("client_id"));
    drop("client_notes", has("client_id"));
    drop("properties", (r) => propIds.has(r.id));
    drop("invoice_line_items", (r) => invIds.has(r.invoice_id));
    drop("invoices", (r) => invIds.has(r.id));
    drop("clients", has("id"));
  } else if (entity === "properties") {
    drop("dogs", has("property_id"));
    drop("properties", has("id"));
  } else if (entity === "dogs") {
    drop("dogs", has("id"));
  } else if (entity === "services") {
    drop("subscriptions", has("id"));
  } else if (entity === "balances") {
    drop("invoice_line_items", has("invoice_id"));
    drop("invoices", has("id"));
  }
  batch.undone_at = new Date().toISOString();
  batch.commit_started_at = null;
  batch.stats = { ...(batch.stats ?? {}), undone: ids.size };
  return { data: { undone: ids.size, removed }, error: null };
}

export function fakeSupabase(tables: Tables, opts: FakeOptions = {}) {
  return {
    rpc: async (name: string, args: unknown) => {
      opts.rpcCalls?.push({ name, args });
      if (name === "undo_import_batch") {
        if (opts.undoFails) return { data: null, error: { message: opts.undoFails } };
        return undoImportBatch(tables, (args as { _batch_id: string })._batch_id);
      }
      return { data: true, error: null };
    },
    from(table: string) {
      let op: "select" | "insert" | "update" | "delete" = "select";
      let payload: any = null;
      let head = false;
      let from = 0;
      let to = Infinity;
      const filters: ((r: Row) => boolean)[] = [];
      const run = async (mode: "many" | "one") => {
        const failure = opts.beforeQuery?.({ table, operation: op, payload });
        if (failure) return { data: null, error: { message: failure } };
        const list = (tables[table] ??= []);
        if (op === "insert") {
          const items = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({
            id: r.id ?? `${table}-${list.length + 1}-${Math.random().toString(36).slice(2, 8)}`,
            created_at: new Date().toISOString(),
            ...r,
          }));
          list.push(...items);
          opts.afterInsert?.(table, items);
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
        select: (_cols?: string, o?: { head?: boolean }) => {
          if (o?.head) head = true;
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

/** The tables an import touches, empty, with one business on Detroit time. */
export function emptyTables(): Tables {
  return {
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
    waste_stations: [],
    organizations: [
      {
        id: "org",
        timezone: "America/Detroit",
        invoice_net_days: 15,
        service_lines: ["pet_waste"],
      },
    ],
  };
}
