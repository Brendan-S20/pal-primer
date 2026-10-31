// A PostgREST in memory, for tests that run the REAL supabase-js client and
// need to see the requests it sends (#617).
//
// Enough of PostgREST for /clients to mean something: embedded resources
// (aliased, `!inner`, nested), filters on the root and on an embed, an embed
// filtered to nothing (`alias=is.null`, the anti-join), `or=(...)`, ordering,
// `offset`/`limit`, and `Prefer: count=exact`. Every request is recorded with
// the table it read and the number of rows it returned, so a test can say
// "this page read 50 rows from one table", not only "it was fast".
//
// It is not PostgREST. Where this differs from it, a test passes here and
// fails against the real thing, so it stays small and close to the docs.

export type Seen = {
  url: string;
  method: string;
  table: string;
  rows: number;
  /** A write's body, parsed. */
  body?: any;
};

/** Parent table -> embedded table -> the column on the child naming the
 *  parent, or "^column" for a to-one embed: the row of the embedded table
 *  whose id is this row's `column` (properties -> clients(...)). */
export type Relations = Record<string, Record<string, string>>;

type Embed = { alias: string; table: string; inner: boolean; select: Node[] };
type Node = { col: string } | Embed;

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(s: string): Node[] {
  return splitTop(s).map((part) => {
    const open = part.indexOf("(");
    if (open < 0) return { col: part.trim() };
    const head = part.slice(0, open).trim();
    const body = part.slice(open + 1, part.lastIndexOf(")"));
    const [aliasOrTable, maybeTable] = head.includes(":") ? head.split(":") : [null, head];
    const [table, hint] = maybeTable.split("!");
    return {
      alias: aliasOrTable ?? table,
      table,
      inner: hint === "inner",
      select: parseSelect(body),
    };
  });
}

function likeToRegex(pattern: string, flags: string) {
  const body = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/[*%]/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${body}$`, flags);
}

function pgArray(v: string): string[] {
  const inner = v.replace(/^\{|\}$/g, "");
  return inner ? inner.split(",").map((x) => x.replace(/^"|"$/g, "")) : [];
}

/** Does `row` pass `op.value` on `col`? */
function test(row: any, col: string, expr: string): boolean {
  const negate = expr.startsWith("not.");
  const e = negate ? expr.slice(4) : expr;
  const dot = e.indexOf(".");
  const op = e.slice(0, dot);
  const v = e.slice(dot + 1);
  const cell = row[col];
  let ok: boolean;
  switch (op) {
    case "eq":
      ok = Array.isArray(cell) ? `{${cell.join(",")}}` === v : cell != null && String(cell) === v;
      break;
    case "neq":
      ok = Array.isArray(cell) ? `{${cell.join(",")}}` !== v : cell != null && String(cell) !== v;
      break;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (cell == null) {
        ok = false;
        break;
      }
      const a = typeof cell === "number" ? cell : String(cell);
      const b = typeof cell === "number" ? Number(v) : v;
      ok = op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
      break;
    }
    case "is":
      ok = v === "null" ? cell == null : String(cell) === v;
      break;
    case "in":
      ok = v
        .replace(/^\(|\)$/g, "")
        .split(",")
        .includes(String(cell));
      break;
    case "ov":
      ok = (cell ?? []).some((t: string) => pgArray(v).includes(t));
      break;
    case "cs":
      ok = pgArray(v).every((t) => (cell ?? []).includes(t));
      break;
    case "like":
    case "ilike":
      ok = cell != null && likeToRegex(v, op === "ilike" ? "i" : "").test(String(cell));
      break;
    case "imatch":
    case "match":
      ok = cell != null && new RegExp(v, op === "imatch" ? "i" : "").test(String(cell));
      break;
    default:
      throw new Error(`fake PostgREST: no operator ${op}`);
  }
  return negate ? !ok : ok;
}

function testOr(row: any, list: string): boolean {
  return splitTop(list.replace(/^\(|\)$/g, "")).some((term) => {
    const dot = term.indexOf(".");
    return test(row, term.slice(0, dot), term.slice(dot + 1));
  });
}

type Filters = Map<string, string[]>;

const childIndex = new WeakMap<any[], Map<string, Map<string, any[]>>>();
/** Children of each parent id, built once per table and key. */
function childrenOf(tables: Record<string, any[]>, table: string, fk: string) {
  const rows = tables[table] ?? [];
  let byFk = childIndex.get(rows);
  if (!byFk) childIndex.set(rows, (byFk = new Map()));
  let idx = byFk.get(fk);
  if (!idx) {
    idx = new Map();
    for (const r of rows) idx.set(r[fk], [...(idx.get(r[fk]) ?? []), r]);
    byFk.set(fk, idx);
  }
  return idx;
}

/** Rows of `table` with `nodes` embedded, filtered by `filters` (keyed by
 *  path: "" for this level, "alias" for an embed, "alias.child" deeper). */
function resolve(
  tables: Record<string, any[]>,
  relations: Relations,
  table: string,
  rows: any[],
  nodes: Node[],
  filters: Filters,
  path: string,
): any[] {
  const own = filters.get(path) ?? [];
  let out = rows.filter((r) =>
    own.every((f) => {
      const [key, expr] = [f.slice(0, f.indexOf("=")), f.slice(f.indexOf("=") + 1)];
      if (key === "or") return testOr(r, expr);
      return test(r, key, expr);
    }),
  );
  const embeds = nodes.filter((n): n is Embed => "table" in n);
  const nullFilters = new Map<string, string>();
  for (const f of filters.get(`${path}#null`) ?? []) {
    const [alias, expr] = f.split("=");
    nullFilters.set(alias, expr);
  }
  out = out.flatMap((r) => {
    const copy: any = { ...r };
    for (const e of embeds) {
      const fk = relations[table]?.[e.table];
      if (!fk) throw new Error(`fake PostgREST: no relation ${table} -> ${e.table}`);
      const toOne = fk.startsWith("^");
      const children = toOne
        ? (tables[e.table] ?? []).filter((p) => p.id === r[fk.slice(1)])
        : (childrenOf(tables, e.table, fk).get(r.id) ?? []);
      const childPath = path ? `${path}.${e.alias}` : e.alias;
      const kept = resolve(tables, relations, e.table, children, e.select, filters, childPath);
      if (e.inner && kept.length === 0) return [];
      const nf = nullFilters.get(e.alias);
      if (nf === "is.null" && kept.length > 0) return [];
      if (nf === "not.is.null" && kept.length === 0) return [];
      copy[e.alias] = toOne ? (kept[0] ?? null) : kept;
    }
    return [copy];
  });
  // Project the columns asked for (and every embed).
  const cols = nodes.filter((n): n is { col: string } => "col" in n).map((n) => n.col);
  if (cols.includes("*")) return out;
  return out.map((r) => {
    const o: any = {};
    for (const c of cols) o[c] = r[c];
    for (const e of embeds) o[e.alias] = r[e.alias];
    return o;
  });
}

export function fakePostgrest(
  tables: Record<string, any[]>,
  relations: Relations,
  seen: Seen[],
  opts: { latencyMs?: number } = {},
) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init?.method ?? "GET").toUpperCase();
    const table = url.pathname.split("/").pop()!;
    if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
    if (method !== "GET" && method !== "HEAD") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      seen.push({ url: url.toString(), method, table, rows: 0, body });
      return new Response(null, { status: 204 });
    }
    const nodes = parseSelect(url.searchParams.get("select") ?? "*");
    const embedAliases = new Set<string>();
    const walk = (ns: Node[], prefix: string) => {
      for (const n of ns) {
        if (!("table" in n)) continue;
        const p = prefix ? `${prefix}.${n.alias}` : n.alias;
        embedAliases.add(p);
        walk(n.select, p);
      }
    };
    walk(nodes, "");

    const filters: Filters = new Map();
    const add = (k: string, v: string) => filters.set(k, [...(filters.get(k) ?? []), v]);
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "offset", "limit", "columns"].includes(key)) continue;
      // An embed's own limit or order: one row of `running` is all a test
      // here needs, and order inside an embed is never relied on.
      if (/\.(limit|offset|order)$/.test(key)) continue;
      if (embedAliases.has(key)) {
        // `alias=is.null`: the embed itself, filtered to nothing.
        const parent = key.includes(".") ? key.slice(0, key.lastIndexOf(".")) : "";
        add(`${parent}#null`, `${key.split(".").pop()}=${value}`);
        continue;
      }
      const lastDot = key.lastIndexOf(".");
      if (lastDot < 0) add("", `${key}=${value}`);
      else add(key.slice(0, lastDot), `${key.slice(lastDot + 1)}=${value}`);
    }

    // Ordered before the columns are picked, as Postgres does: a query may
    // order by a column it does not select.
    let source = tables[table] ?? [];
    const order = url.searchParams.get("order");
    if (order) {
      const keys = order.split(",").map((o) => {
        const [col, dir] = o.split(".");
        return { col, desc: dir === "desc" };
      });
      source = [...source].sort((a, b) => {
        for (const { col, desc } of keys) {
          const x = a[col];
          const y = b[col];
          if (x === y) continue;
          const c = x == null ? 1 : y == null ? -1 : x < y ? -1 : 1;
          return desc ? -c : c;
        }
        return 0;
      });
    }
    const rows = resolve(tables, relations, table, source, nodes, filters, "");
    const total = rows.length;
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 1000), 1000);
    const body = rows.slice(offset, offset + limit);
    seen.push({ url: url.toString(), method, table, rows: body.length });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const prefer = new Headers(init?.headers).get("Prefer") ?? "";
    if (prefer.includes("count=exact")) {
      headers["Content-Range"] = body.length
        ? `${offset}-${offset + body.length - 1}/${total}`
        : `*/${total}`;
    }
    return new Response(method === "HEAD" ? null : JSON.stringify(body), {
      status: 200,
      headers,
    });
  };
}
