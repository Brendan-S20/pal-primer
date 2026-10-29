// #492, the grant-drift assert: the static half, which runs on every PR.
//
// Once a table's SELECT for authenticated is a column grant rather than a
// table grant, a column added later is withheld by default. Nothing errors
// when the migration applies. The first sign is a 403 on whichever screen
// selects the new column, in production, which is the #492 failure from the
// other side. 20261015215000's header says so in prose; this makes it a rule.
//
// For each table in tests/support/withheld-columns.ts, every migration after
// the one that narrowed it is read as SQL, and:
//
//   * a column it ADDs is either granted to authenticated by a column grant
//     in that migration or a later one, or is listed as withheld;
//   * nothing grants SELECT on the whole table back to authenticated, anon or
//     PUBLIC, which would reopen every withheld column at once;
//   * a column grant on a table that is not registered fails, so the next
//     table to be narrowed gets the same checks.
//
// The other half, supabase/proofs/20261029180000-a-narrowed-grant-withholds-
// only-what-it-names.sql, asks the catalog of a database built from the
// migrations. It holds the same list in SQL; the last block below checks the
// two copies agree.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IDENT,
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
  unquote,
} from "./support/sql-migrations";
import { NARROWED_TABLES } from "./support/withheld-columns";

const root = join(import.meta.dirname, "..");
const PROOF = "supabase/proofs/20261029180000-a-narrowed-grant-withholds-only-what-it-names.sql";

const tableRef = (table: string) => String.raw`(?:public\.)?"?${table}"?\b`;

/** Columns an ALTER TABLE statement on `table` adds. */
function addedColumns(stmt: string, table: string): string[] {
  const head = new RegExp(
    String.raw`^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${tableRef(table)}`,
    "i",
  );
  if (!head.test(stmt)) return [];
  const add = new RegExp(String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, "gi");
  const out: string[] = [];
  for (const m of stmt.matchAll(add)) {
    const name = unquote(m[1]);
    if (/^(constraint|primary|unique|foreign|check|exclude)$/i.test(name)) continue;
    out.push(name);
  }
  return out;
}

/** Columns a statement grants SELECT on to authenticated, or "dynamic" for a
 *  format() grant such as 20261015215000's, which regrants every column that
 *  is not withheld at the time it runs. */
function columnGrant(stmt: string, table: string): string[] | "dynamic" | null {
  const m = new RegExp(
    String.raw`GRANT\s+SELECT\s*\(([^)]*)\)\s*ON\s+(?:TABLE\s+)?${tableRef(table)}\s+TO\s+([^;']*)`,
    "i",
  ).exec(stmt);
  if (!m || !/\bauthenticated\b/i.test(m[2])) return null;
  if (m[1].trim() === "%s") return "dynamic";
  return m[1].split(",").map((c) => unquote(c.trim()));
}

/** A grant that gives back SELECT on every column of `table`. */
function reopensTable(stmt: string, table: string): boolean {
  const m = /^\s*GRANT\s+([\s\S]*?)\s+ON\s+(?:TABLE\s+)?([\s\S]*?)\s+TO\s+([\s\S]*)$/i.exec(stmt);
  if (!m) return false;
  const [, privileges, targets, grantees] = m;
  if (/\(/.test(privileges)) return false;
  if (!/\b(SELECT|ALL)\b/i.test(privileges)) return false;
  if (!/\b(authenticated|anon|PUBLIC)\b/i.test(grantees)) return false;
  if (/^ALL\s+TABLES\s+IN\s+SCHEMA\s+public\b/i.test(targets)) return true;
  return targets.split(",").some((t) => new RegExp(`^\\s*${tableRef(table)}\\s*$`, "i").test(t));
}

const parsed = () =>
  migrationFiles().map((file) => ({
    file,
    stmts: statements(stripLineComments(readMigration(file))),
  }));

describe("a column added to a narrowed table is granted or withheld on purpose", () => {
  const files = parsed();

  for (const [table, { narrowedBy, withheld }] of Object.entries(NARROWED_TABLES)) {
    describe(table, () => {
      const at = files.findIndex((f) => f.file === narrowedBy);
      const after = files.slice(at + 1);

      it("was narrowed by the migration the register names", () => {
        expect(at, `${narrowedBy} is not in supabase/migrations`).toBeGreaterThanOrEqual(0);
        const grants = files[at].stmts.map((s) => columnGrant(s, table)).filter(Boolean);
        expect(grants.length, `${narrowedBy} has no column grant on ${table}`).toBeGreaterThan(0);
      });

      it("grants every column added since, unless it is listed as withheld", () => {
        const added: { file: string; column: string }[] = [];
        for (const { file, stmts } of after) {
          for (const s of stmts)
            for (const column of addedColumns(s, table)) added.push({ file, column });
        }
        const ungranted = added.filter(({ file, column }) => {
          if (withheld.includes(column)) return false;
          const from = files.findIndex((f) => f.file === file);
          return !files.slice(from).some(({ stmts }) =>
            stmts.some((s) => {
              const g = columnGrant(s, table);
              return g === "dynamic" || (Array.isArray(g) && g.includes(column));
            }),
          );
        });
        expect(
          ungranted.map(({ file, column }) => `${file} adds ${table}.${column}`),
          `authenticated has a column grant on ${table}, so a new column is unreadable until it is granted. ` +
            `Add GRANT SELECT (<column>) ON public.${table} TO authenticated, or list it as withheld in ` +
            "tests/support/withheld-columns.ts and in the proof",
        ).toEqual([]);
      });

      it("never gets its table SELECT back", () => {
        const reopened = after.flatMap(({ file, stmts }) =>
          stmts.filter((s) => reopensTable(s, table)).map((s) => `${file}: ${s.split("\n")[0]}`),
        );
        expect(reopened, `a table grant on ${table} reopens ${withheld.join(", ")}`).toEqual([]);
      });
    });
  }

  it("registers every table that has a column grant", () => {
    const grant = new RegExp(
      String.raw`GRANT\s+SELECT\s*\([^)]*\)\s*ON\s+(?:TABLE\s+)?(?:public\.)?${IDENT}`,
      "gi",
    );
    const tables = new Set<string>();
    for (const { stmts } of files) {
      for (const s of stmts) for (const m of s.matchAll(grant)) tables.add(unquote(m[1]));
    }
    expect([...tables].sort()).toEqual(Object.keys(NARROWED_TABLES).sort());
  });
});

describe("the proof holds the same list", () => {
  it("names every withheld column, and no other", () => {
    const sql = readFileSync(join(root, PROOF), "utf8");
    const block = /-- withheld:begin([\s\S]*?)-- withheld:end/.exec(sql);
    expect(block, `${PROOF} has no withheld:begin / withheld:end block`).not.toBeNull();
    const pairs = [...block![1].matchAll(/\('(\w+)',\s*'(\w+)'\)/g)].map((m) => `${m[1]}.${m[2]}`);
    const expected = Object.entries(NARROWED_TABLES).flatMap(([t, { withheld }]) =>
      withheld.map((c) => `${t}.${c}`),
    );
    expect(pairs.sort()).toEqual(expected.sort());
  });
});

describe("the parsing itself", () => {
  it("reads an added column, several at once, and skips a constraint", () => {
    expect(
      addedColumns(
        "ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS alarm_notes text",
        "properties",
      ),
    ).toEqual(["alarm_notes"]);
    expect(
      addedColumns(
        "ALTER TABLE properties ADD COLUMN a text, ADD b int, ADD CONSTRAINT c CHECK (true)",
        "properties",
      ),
    ).toEqual(["a", "b"]);
    expect(
      addedColumns("ALTER TABLE public.properties_history ADD COLUMN x text", "properties"),
    ).toEqual([]);
    expect(
      addedColumns("ALTER TABLE public.visits ADD COLUMN gate_reply text", "properties"),
    ).toEqual([]);
  });

  it("reads a literal column grant and 20261015215000's dynamic one", () => {
    expect(
      columnGrant("GRANT SELECT (id, street) ON public.properties TO authenticated", "properties"),
    ).toEqual(["id", "street"]);
    expect(
      columnGrant(
        "EXECUTE format('GRANT SELECT (%s) ON TABLE public.properties TO authenticated', _cols)",
        "properties",
      ),
    ).toBe("dynamic");
    expect(
      columnGrant("GRANT SELECT (id) ON public.properties TO service_role", "properties"),
    ).toBeNull();
  });

  it("catches a table grant coming back, and nothing narrower", () => {
    expect(
      reopensTable("GRANT SELECT ON TABLE public.properties TO authenticated", "properties"),
    ).toBe(true);
    expect(
      reopensTable(
        "GRANT SELECT, INSERT ON public.clients, public.properties TO anon",
        "properties",
      ),
    ).toBe(true);
    expect(reopensTable("GRANT ALL ON public.properties TO authenticated", "properties")).toBe(
      true,
    );
    expect(
      reopensTable("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated", "properties"),
    ).toBe(true);
    expect(reopensTable("GRANT ALL ON public.properties TO service_role", "properties")).toBe(
      false,
    );
    expect(
      reopensTable("GRANT SELECT (id) ON public.properties TO authenticated", "properties"),
    ).toBe(false);
    expect(reopensTable("GRANT UPDATE ON public.properties TO authenticated", "properties")).toBe(
      false,
    );
    expect(
      reopensTable("GRANT SELECT ON public.properties_log TO authenticated", "properties"),
    ).toBe(false);
  });
});
