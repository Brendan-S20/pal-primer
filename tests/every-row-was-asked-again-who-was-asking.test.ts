// A policy may ask who you are. It may not ask once per row.
//
// The performance advisor's largest finding on this project was
// `auth_rls_initplan`, 140 of them: RLS policies calling `auth.uid()` (or
// `auth.role()`) directly inside a USING or WITH CHECK expression. In that
// position Postgres cannot hoist the call. `auth.uid()` is a function whose
// body reads a GUC, casts it to jsonb, extracts a key and parses a uuid, and
// it is marked STABLE — which Postgres accepts as a promise and does not act
// on. It does not memoise stable functions. So the whole of that body ran once
// for every row the scan touched.
//
// `(select auth.uid())` is the fix, and the entire fix. The subquery has no
// correlation to the outer row, so it becomes an InitPlan: evaluated once,
// before the scan. Measured on `visits` in a rolled-back transaction,
// alternating the two shapes three times so neither got the warm cache:
//
//   select count(*) from public.visits;   -- 3,517 rows scanned
//     bare      130.201 ms   111.562 ms   117.775 ms
//     wrapped   103.411 ms   101.905 ms   104.049 ms
//
// Twelve percent, and it is worth saying plainly that twelve percent is what
// this is worth and not more. The JWT parse was never most of the cost; the
// two SECURITY DEFINER helpers behind it still run per row, because they take
// `organization_id` as an argument and so are genuinely per-row questions.
// What makes it worth doing is that the cost is linear in rows scanned and is
// paid on every read of 79 tables by every tenant.
//
// ── WHY THIS FILE IS A RULE AND NOT A LIST OF 140 NAMES ───────────────────
//
// A list would pass forever while the 141st policy is written the old way. The
// rule below is the durable half: NO policy in `public` may reference a bare
// `auth.uid()` / `auth.jwt()` / `auth.role()` / `auth.email()` outside a
// scalar subquery. It names the offending policy and the file that last
// touched it rather than counting.
//
// ── THE PART THAT MAKES THE RULE HONEST ───────────────────────────────────
//
// The rule cannot just grep the migrations directory for `auth.uid()`, because
// every one of the 54 migrations that originally wrote these policies still
// contains the old text and always will — history is not edited here. A grep
// would report 140 violations that no longer exist anywhere but in the past.
//
// So it replays instead. Every CREATE / ALTER / DROP POLICY statement across
// the whole directory, in filename order, folded into a map keyed by
// schema.table.policy, last write winning — which is exactly what the database
// does when the migrations are applied in order. The rule is then evaluated
// against the EFFECTIVE definition of each policy: the statement that most
// recently touched it. A migration that supersedes a bare call with a wrapped
// one clears the violation; a new migration that introduces a bare one raises
// it, wherever in the directory it lands.
//
// That replay is checked against reality rather than trusted: it reconstructs
// 150 policies in `public`, and `select count(*) from pg_policy` on the live
// database at the time of writing returned 150. If the parser silently stopped
// matching, that count would collapse and the vacuous-pass guard below fires
// before the rule gets a chance to report success on an empty set.
//
// Only 141 of those 150 have a CREATE POLICY anywhere in this directory. The
// other nine — the `Service role can …` policies on email_send_log,
// email_send_state, email_unsubscribe_tokens and suppressed_emails, the same
// nine that test `auth.role()` rather than `auth.uid()` — arrived in the
// 2026-07-09 consolidated bootstrap that scripts/check-migrations.mjs already
// documents as applied under names the filenames do not match. Their first
// appearance in the tracked migrations is the ALTER that wrapped them. That is
// worth knowing before reading a count here as a schema census: this replay
// covers what the repo says, and the repo has always been nine short.
//
// ── WHAT THE RULE DELIBERATELY DOES NOT COVER ─────────────────────────────
//
// `storage.objects` carries 13 policies that still call `auth.uid()` bare —
// avatars, visit photos, waste receipts, DNA sample photos. They are out of
// scope on purpose and not by oversight: the advisor does not report them
// (its 140 is exactly the count in `public`, checked against the catalog), and
// `storage.objects` is not this project's table to ALTER. They are named here
// so that "the rule passes" is never mistaken for "there are none left".
//
// Also uncovered, and correctly: an auth call inside a SECURITY DEFINER helper
// body. `may_read_client(id)` on `clients` calls `auth.uid()` internally, where
// it is evaluated once per invocation of the function rather than once per row
// of the scan. That is a different question with a different answer.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const THIS_MIGRATION = "20260809200000_every-row-was-asked-again-who-was-asking.sql";

/** Read lazily. A file read resolved while the module is loading turns a
 *  missing file into an import-time throw, and vitest reports an import-time
 *  throw as "no tests" — which reads as a pass. */
const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
const readMigration = (f: string): string => readFileSync(join(MIGRATIONS, f), "utf8");

/** Strip `--` comments without being fooled by one inside a string literal.
 *  The prose in these migrations quotes the very pattern being banned, so a
 *  rule that reads comments reports its own documentation as a violation. */
function stripLineComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let out = "";
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          out += c;
          if (c === quote) quote = null;
          continue;
        }
        if (c === "'" || c === '"') {
          quote = c;
          out += c;
          continue;
        }
        if (c === "-" && line[i + 1] === "-") break;
        out += c;
      }
      return out;
    })
    .join("\n");
}

/** Split on `;` at the top level, respecting quotes and dollar-quoted bodies —
 *  these migrations are full of `DO $pre$ ... $pre$;` blocks whose contents
 *  contain semicolons that do not end a statement. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let dollar: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        cur += sql.slice(i, i + dollar.length);
        i += dollar.length - 1;
        dollar = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    const tag = /^\$[a-zA-Z_]*\$/.exec(sql.slice(i));
    if (tag) {
      dollar = tag[0];
      cur += dollar;
      i += dollar.length - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_][A-Za-z_0-9$]*)`;
const POLICY_HEAD = new RegExp(
  String.raw`^(CREATE|ALTER|DROP)\s+POLICY\s+(?:IF\s+EXISTS\s+)?${IDENT}\s+ON\s+(?:${IDENT}\s*\.\s*)?${IDENT}`,
  "is",
);

const unquote = (s: string) => (s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s);

type Effective = { key: string; schema: string; file: string; sql: string };

/** Replay the whole directory in filename order and return, for every policy
 *  that still exists, the statement that most recently defined it. */
function effectivePolicies(): Effective[] {
  const map = new Map<string, Effective>();
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const m = POLICY_HEAD.exec(st);
      if (!m) continue;
      const [, verb, rawPolicy, rawSchema, rawTable] = m;
      const schema = rawSchema ? unquote(rawSchema) : "public";
      const key = `${schema}.${unquote(rawTable)}.${unquote(rawPolicy)}`;
      if (verb.toUpperCase() === "DROP") map.delete(key);
      else map.set(key, { key, schema, file, sql: st });
    }
  }
  return [...map.values()];
}

/** Remove every properly wrapped call, then look for what is left. */
const AUTH_CALL = /auth\.(uid|jwt|role|email)\s*\(\s*\)/i;
const WRAPPED = /\(\s*select\s+auth\.(?:uid|jwt|role|email)\s*\(\s*\)\s*\)/gis;
const hasBareAuthCall = (sql: string) => AUTH_CALL.test(sql.replace(WRAPPED, ""));

describe("no policy in public asks who you are once per row", () => {
  it("reconstructs the policy surface rather than passing on an empty set", () => {
    const all = effectivePolicies();
    const inPublic = all.filter((p) => p.schema === "public");
    // 150 live in pg_policy when this was written. A parser that quietly
    // stopped matching would report zero violations and look green.
    expect(inPublic.length).toBeGreaterThanOrEqual(150);
    expect(all.length).toBeGreaterThan(inPublic.length); // storage is seen too
  });

  it("leaves no bare auth.uid() / auth.jwt() / auth.role() in any of them", () => {
    const offenders = effectivePolicies()
      .filter((p) => p.schema === "public")
      .filter((p) => hasBareAuthCall(p.sql))
      .map((p) => `${p.key}  — last defined in ${p.file}`);

    expect(
      offenders,
      offenders.length
        ? `wrap the auth call in a scalar subquery — (select auth.uid()) — so ` +
            `Postgres evaluates it once as an InitPlan instead of once per row:\n` +
            offenders.map((o) => `  ${o}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("still finds the storage policies it deliberately does not police", () => {
    // Named rather than silent: if these are ever fixed or removed, this fails
    // and the exemption in the header gets re-read instead of rotting.
    const storage = effectivePolicies().filter((p) => p.schema === "storage");
    expect(storage.filter((p) => hasBareAuthCall(p.sql)).length).toBe(13);
  });
});

describe("the migration that did it is a record of what was done", () => {
  it("rewrites in place, so no policy can be lost between a drop and a create", () => {
    const sql = stripLineComments(readMigration(THIS_MIGRATION));
    expect((sql.match(/ALTER\s+POLICY/gi) ?? []).length).toBe(140);
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
  });

  it("contains the literal SQL and not a loop that regenerates it", () => {
    const sql = stripLineComments(readMigration(THIS_MIGRATION));
    const body = sql.slice(sql.indexOf("ALTER POLICY"));
    // Every wrapped call written out, once per site, in the file itself.
    expect((body.match(/\(select auth\.uid\(\)\)/g) ?? []).length).toBe(218);
    expect((body.match(/\(select auth\.role\(\)\)/g) ?? []).length).toBe(12);
  });

  it("asserts the state it expects before touching anything", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/DO \$pre\$/);
    expect(sql).toMatch(/expected 150 policies in public/);
    expect(sql).toMatch(/expected 140 policies with an unwrapped auth call/);
    // A textual rewrite is only safe if no auth call hides inside a literal.
    expect(sql).toMatch(/inside a string literal/);
  });

  it("proves equivalence afterwards instead of asserting it", () => {
    const sql = readMigration(THIS_MIGRATION);
    const post = sql.slice(sql.indexOf("DO $post$"));
    expect(post).toMatch(/policy count changed/);
    expect(post).toMatch(/policies per table changed/);
    expect(post).toMatch(/command, permissiveness or granted roles changed/);
    // The one that matters: undo the wrapper, require the rest to be identical.
    expect(post).toMatch(/expression changed by more than the subquery wrapper/);
    expect(post).toMatch(/still call an auth function outside a scalar subquery/);
    expect(post).toMatch(/expected 230 auth call sites after the rewrite/);
  });

  it("stays inside its own lane and touches no index", () => {
    // Indexes on this database are another piece of work in flight. A
    // performance migration that quietly grew an index would collide with it.
    const sql = stripLineComments(readMigration(THIS_MIGRATION));
    expect(sql).not.toMatch(/CREATE\s+(UNIQUE\s+)?INDEX/i);
    expect(sql).not.toMatch(/DROP\s+INDEX/i);
    expect(sql).not.toMatch(/CREATE\s+TABLE\s+(?!TEMP)/i);
  });
});
