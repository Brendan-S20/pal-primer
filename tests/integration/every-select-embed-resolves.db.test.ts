/** #603: every embed in src/ resolves against a database built from the
 *  migrations.
 *
 *  The static half (tests/an-embed-names-its-foreign-key.test.ts) reads the
 *  foreign keys out of types.ts, which is generated and can lag a migration.
 *  This half sends each select string that embeds anything to the PostgREST
 *  of the local stack, `limit=0`, as the service role, and fails on the two
 *  answers that mean the embed itself is wrong: PGRST201 (two keys, no hint,
 *  which is what services.public_package_id did to service_packages) and
 *  PGRST200 (no relationship at all, or a hint that names none).
 *
 *  `limit=0` returns no rows, and PostgREST resolves the embed before it
 *  plans the query, so an empty database answers the question as well as a
 *  full one does. Nothing is written.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DB_SERVICE, DB_URL, dbEnabled } from "../support/walk-db";
import { collectSelects, embedsOf, foreignKeysFromTypes } from "../support/select-embeds";

const root = join(import.meta.dirname, "../..");

/** What supabase-js does to a select before it sends it: whitespace outside
 *  double quotes goes. */
function clean(select: string): string {
  let quoted = false;
  return select
    .split("")
    .map((c) => {
      if (/\s/.test(c) && !quoted) return "";
      if (c === '"') quoted = !quoted;
      return c;
    })
    .join("");
}

describe.skipIf(!dbEnabled)("every select embed resolves in a real database", () => {
  it("has no ambiguous or missing relationship in any select in src/", async () => {
    const fks = foreignKeysFromTypes(
      readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8"),
    );
    const seen = new Map<string, string>();
    for (const s of collectSelects(root).sites) {
      if (embedsOf(s.table, s.select, fks).length === 0) continue;
      const key = `${s.table}?${clean(s.select)}`;
      if (!seen.has(key)) seen.set(key, `${s.file}:${s.line}`);
    }
    expect(seen.size).toBeGreaterThan(100);

    const bad: string[] = [];
    const other: string[] = [];
    const entries = [...seen.entries()];
    for (let i = 0; i < entries.length; i += 20) {
      await Promise.all(
        entries.slice(i, i + 20).map(async ([key, where]) => {
          const [table, select] = [key.slice(0, key.indexOf("?")), key.slice(key.indexOf("?") + 1)];
          const url = `${DB_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=0`;
          const res = await fetch(url, {
            headers: { apikey: DB_SERVICE!, Authorization: `Bearer ${DB_SERVICE}` },
          });
          if (res.ok) return;
          const body = (await res.json().catch(() => ({}))) as {
            code?: string;
            message?: string;
            hint?: string;
          };
          const line = `${where}  ${table}: ${body.code} ${body.message ?? ""}${body.hint ? ` (${body.hint})` : ""}`;
          if (body.code === "PGRST201" || body.code === "PGRST200") bad.push(line);
          else other.push(line);
        }),
      );
    }
    // Not this test's question, but worth seeing in the log rather than nowhere.
    if (other.length) console.warn(`\n  Other errors, not failed on:\n  ${other.join("\n  ")}\n`);
    expect(bad, bad.join("\n")).toEqual([]);
  });
});
