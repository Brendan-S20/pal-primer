/**
 * A small in-memory stand-in for the slice of the supabase-js query builder
 * the lock-screen hook uses: select (with count/head), insert, update,
 * eq/gte/is filters, single/maybeSingle, and rpc. Enough to drive
 * performLiveActivityAction through every branch without a database, and
 * strict about the one thing that matters for idempotency: a unique key
 * declared on a table refuses a second row with Postgres's 23505.
 *
 * Not a general fake. A method it does not know throws, so a change to the
 * code under test that reaches for one fails loudly here rather than
 * passing against a no-op.
 */

type Row = Record<string, any>;
type Filter = (r: Row) => boolean;

export class FakeDb {
  tables: Record<string, Row[]> = {};
  unique: Record<string, string[][]> = {};
  rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
  rpcHandler: (fn: string, args: Record<string, unknown>) => Promise<{ error: any }> =
    async () => ({
      error: null,
    });
  private nextId = 1;

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  from(name: string) {
    return new Query(this, name);
  }

  async rpc(fn: string, args: Record<string, unknown>) {
    this.rpcCalls.push({ fn, args });
    return this.rpcHandler(fn, args);
  }

  id(): string {
    const n = String(this.nextId++).padStart(12, "0");
    return `00000000-0000-4000-8000-${n}`;
  }
}

class Query implements PromiseLike<any> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" = "select";
  private payload: Row | null = null;
  private countOpt = false;
  private headOpt = false;
  private returning = false;
  private mode: "many" | "single" | "maybe" = "many";

  constructor(
    private db: FakeDb,
    private name: string,
  ) {}

  select(_cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.countOpt = opts?.count === "exact";
      this.headOpt = !!opts?.head;
    } else {
      this.returning = true;
    }
    return this;
  }
  insert(row: Row) {
    this.op = "insert";
    this.payload = row;
    return this;
  }
  update(row: Row) {
    this.op = "update";
    this.payload = row;
    return this;
  }
  eq(col: string, v: unknown) {
    this.filters.push((r) => r[col] === v);
    return this;
  }
  gte(col: string, v: string) {
    this.filters.push((r) => String(r[col]) >= v);
    return this;
  }
  is(col: string, v: null) {
    this.filters.push((r) => (r[col] ?? null) === v);
    return this;
  }
  single() {
    this.mode = "single";
    return this;
  }
  maybeSingle() {
    this.mode = "maybe";
    return this;
  }

  private run(): any {
    const rows = this.db.table(this.name);
    if (this.op === "insert") {
      const row = { id: this.db.id(), created_at: new Date().toISOString(), ...this.payload };
      for (const key of this.db.unique[this.name] ?? []) {
        if (rows.some((r) => key.every((k) => r[k] === row[k]))) {
          return { data: null, error: { code: "23505", message: "duplicate key value" } };
        }
      }
      rows.push(row);
      return { data: this.returning ? { id: row.id } : null, error: null };
    }
    const hit = rows.filter((r) => this.filters.every((f) => f(r)));
    if (this.op === "update") {
      for (const r of hit) Object.assign(r, this.payload);
      if (!this.returning) return { data: null, error: null };
      return this.shape(hit.map((r) => ({ id: r.id })));
    }
    if (this.countOpt && this.headOpt) return { count: hit.length, data: null, error: null };
    return this.shape(hit.map((r) => ({ ...r })));
  }

  private shape(list: Row[]) {
    if (this.mode === "many") return { data: list, error: null };
    if (list.length > 1) return { data: null, error: { message: "more than one row" } };
    if (list.length === 0 && this.mode === "single")
      return { data: null, error: { message: "no rows" } };
    return { data: list[0] ?? null, error: null };
  }

  then<A, B>(
    ok?: ((v: any) => A | PromiseLike<A>) | null,
    bad?: ((e: any) => B | PromiseLike<B>) | null,
  ) {
    // A tick, so two presses awaited together interleave the way two
    // requests do.
    return new Promise((r) => setTimeout(r, 0)).then(() => this.run()).then(ok, bad);
  }
}
