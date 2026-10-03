import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain ESM script, no types
import { CATALOG_SQL, expectedObjects, sqlCode } from "../scripts/check-baseline-objects.mjs";

// IMP-2b. `check-baseline-objects.mjs` asks the live database whether every
// object the migrations create still exists. It found nothing wrong on its
// first clean run — which is only worth anything if the thing computing "what
// should exist" is right.
//
// It was not, twice, and both bugs were found by running it rather than by
// reading it:
//
//   1. It reported a missing table called `as`, parsed out of the string
//      literal `command_tag IN ('CREATE TABLE', 'CREATE TABLE AS')` inside an
//      event-trigger body. A false positive is not a cosmetic problem here —
//      §4 of the brief is about a check that cried wolf eighty times and got
//      ignored, which is worse than no check.
//
//   2. It applied every CREATE in a file before every DROP. Migrations
//      routinely write `DROP FUNCTION IF EXISTS f(uuid); CREATE OR REPLACE
//      FUNCTION f(_token uuid) ...` to change a signature, so the DROP won and
//      ten live functions quietly fell out of the checked set. That is the
//      quieter failure: the check passes having looked at less than it says.
//
// So this file tests the REPLAY, not the database. Each case is one of the two
// ways it can be wrong — expecting something that should not exist, or failing
// to expect something that should.

const replay = (sql: string, name = "0001_test.sql") => expectedObjects([{ name, sql }]);

describe("sqlCode strips what is not executable", () => {
  it("removes single-quoted literals", () => {
    // The exact shape that produced a phantom table named `as`.
    expect(sqlCode("WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS')")).not.toContain(
      "CREATE TABLE",
    );
  });

  it("handles a doubled quote inside a literal without losing the rest", () => {
    const out = sqlCode("SELECT 'it''s fine'; CREATE TABLE public.kept (id int);");
    expect(out).toContain("CREATE TABLE public.kept");
  });

  it("removes line and block comments", () => {
    expect(sqlCode("-- CREATE TABLE public.ghost\nSELECT 1;")).not.toContain("ghost");
    expect(sqlCode("/* DROP TABLE public.real */ SELECT 1;")).not.toContain("DROP TABLE");
  });

  it("keeps dollar-quoted bodies", () => {
    // Removing them would silently narrow what the check covers — a migration
    // that wraps DDL in DO $$ ... $$ still creates the object.
    expect(sqlCode("DO $$ BEGIN CREATE TABLE public.inner_t (id int); END $$;")).toContain(
      "CREATE TABLE public.inner_t",
    );
  });
});

describe("nothing in a comment or a literal becomes an expectation", () => {
  it("a commented-out CREATE creates no expectation", () => {
    expect(replay("-- CREATE TABLE public.ghost (id int);").tables.has("ghost")).toBe(false);
  });

  it("a commented-out DROP removes no expectation", () => {
    const e = replay("CREATE TABLE public.keep (id int);\n-- DROP TABLE public.keep;");
    expect(e.tables.has("keep")).toBe(true);
  });

  it("a table name inside a string literal is not a table", () => {
    const e = replay(`
      CREATE FUNCTION public.guard() RETURNS event_trigger AS $fn$
      BEGIN
        IF TG_TAG IN ('CREATE TABLE', 'CREATE TABLE AS') THEN RAISE EXCEPTION 'no'; END IF;
      END; $fn$ LANGUAGE plpgsql;
    `);
    expect([...e.tables.keys()]).toEqual([]);
    expect(e.functions.has("guard")).toBe(true);
  });
});

describe("statements apply in document order", () => {
  it("DROP then CREATE leaves the object expected", () => {
    // The real case: changing a function's signature. Grouping drops after
    // creates made this vanish from the checked set.
    const e = replay(`
      DROP FUNCTION IF EXISTS public.portal_get_client(uuid);
      CREATE OR REPLACE FUNCTION public.portal_get_client(_token uuid)
        RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    `);
    expect(e.functions.has("portal_get_client")).toBe(true);
  });

  it("CREATE then DROP leaves it not expected", () => {
    const e = replay(`
      CREATE TABLE public.temp_thing (id int);
      DROP TABLE public.temp_thing;
    `);
    expect(e.tables.has("temp_thing")).toBe(false);
  });

  it("a later file's DROP beats an earlier file's CREATE", () => {
    const e = expectedObjects([
      { name: "0001_a.sql", sql: "CREATE TABLE public.old_thing (id int);" },
      { name: "0002_b.sql", sql: "DROP TABLE IF EXISTS public.old_thing;" },
    ]);
    expect(e.tables.has("old_thing")).toBe(false);
  });

  it("a later file's CREATE beats an earlier file's DROP", () => {
    const e = expectedObjects([
      { name: "0001_a.sql", sql: "DROP TABLE IF EXISTS public.back_again;" },
      { name: "0002_b.sql", sql: "CREATE TABLE public.back_again (id int);" },
    ]);
    expect(e.tables.get("back_again")).toBe("0002_b.sql");
  });
});

describe("columns added after the fact", () => {
  it("catches every column in a multi-column ALTER", () => {
    // One statement, three columns. A per-match regex only ever saw the first.
    const e = replay(
      "ALTER TABLE public.organizations ADD COLUMN a int, ADD COLUMN b int, ADD COLUMN c int;",
    );
    expect([...e.columns.keys()].sort()).toEqual([
      "organizations.a",
      "organizations.b",
      "organizations.c",
    ]);
  });

  it("handles IF NOT EXISTS", () => {
    const e = replay("ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS tags text[];");
    expect(e.columns.has("clients.tags")).toBe(true);
  });

  it("stops expecting a dropped column", () => {
    const e = replay(`
      ALTER TABLE public.visits ADD COLUMN gone int;
      ALTER TABLE public.visits DROP COLUMN gone;
    `);
    expect(e.columns.has("visits.gone")).toBe(false);
  });

  it("stops expecting the columns of a dropped table", () => {
    const e = replay(`
      CREATE TABLE public.doomed (id int);
      ALTER TABLE public.doomed ADD COLUMN extra int;
      DROP TABLE public.doomed;
    `);
    expect(e.columns.has("doomed.extra")).toBe(false);
    expect(e.tables.has("doomed")).toBe(false);
  });

  it("follows a column rename rather than expecting the old name for ever", () => {
    const e = replay(`
      ALTER TABLE public.clients ADD COLUMN old_name text;
      ALTER TABLE public.clients RENAME COLUMN old_name TO new_name;
    `);
    expect(e.columns.has("clients.old_name")).toBe(false);
    expect(e.columns.has("clients.new_name")).toBe(true);
  });
});

describe("names are normalized the way migrations actually write them", () => {
  it("treats public.x and x as the same object", () => {
    const e = replay(`
      CREATE TABLE public.thing (id int);
      DROP TABLE thing;
    `);
    expect(e.tables.has("thing")).toBe(false);
  });

  it("strips quoting", () => {
    expect(replay('CREATE TABLE public."Odd_Name" (id int);').tables.has("odd_name")).toBe(true);
  });

  // The two halves of the check have to spell a name the same way. The replay
  // keeps any schema but public (`reference.zip_centroids`); until 2026-10-03
  // the catalog read public only, so a table in `reference` -- present on
  // production with 33,791 rows -- failed main's "Migrations applied to the
  // live database" as missing. Pinned on both sides.
  it("keeps another schema's prefix, and the catalog reads that schema too", () => {
    const e = replay("CREATE TABLE IF NOT EXISTS reference.zip_centroids (zip text);");
    expect(e.tables.has("reference.zip_centroids")).toBe(true);
    expect(CATALOG_SQL).not.toMatch(/nspname\s*=\s*'public'\s*(and|\))/i);
    expect(CATALOG_SQL).toMatch(/nspname\s*\|\|\s*'\.'/);
  });
});

describe("the whole repo replays to something checkable", () => {
  it("expects a substantial, non-empty set", () => {
    // A parser that silently matched nothing would make every run of the check
    // a green tick over an empty set — the exact vacuity this suite guards
    // against elsewhere.
    const { readdirSync, readFileSync } = require("node:fs");
    const dir = fileURLToPath(new URL("../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort()
      .map((name: string) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
    const e = expectedObjects(files);
    expect(files.length).toBeGreaterThan(200);
    expect(e.functions.size).toBeGreaterThan(100);
    expect(e.tables.size).toBeGreaterThan(50);
    expect(e.columns.size).toBeGreaterThan(200);
    expect(e.types.size).toBeGreaterThan(20);
  });

  it("does not expect the things this repo deliberately dropped", () => {
    // If the drop replay broke, these would come back and the check would
    // report live schema as missing — the false positives that get a check
    // ignored.
    const { readdirSync, readFileSync } = require("node:fs");
    const dir = fileURLToPath(new URL("../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort()
      .map((name: string) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
    const e = expectedObjects(files);
    expect(e.tables.has("org_ai_credentials")).toBe(false); // dropped in IMP-9
    expect(e.functions.has("platform_org_stats")).toBe(false); // dropped in v1.19
  });

  it("expects the function whose absence started all of this", () => {
    const { readdirSync, readFileSync } = require("node:fs");
    const dir = fileURLToPath(new URL("../supabase/migrations", import.meta.url));
    const files = readdirSync(dir)
      .filter((f: string) => f.endsWith(".sql"))
      .sort()
      .map((name: string) => ({ name, sql: readFileSync(`${dir}/${name}`, "utf8") }));
    expect(expectedObjects(files).functions.has("seed_demo_org")).toBe(true);
  });
});
