// An UPDATE with no WHERE is valid SQL, and the API role refuses it.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// Auto-routing was completely dead through the app on 2026-08-26 -- Apply and
// Preview both -- and the cause was two statements in
// plan_day_across_staff_dryrun that update every row of a temp scratch table:
//
//   UPDATE _dry_grp SET ang = atan2(...);          -- no WHERE
//
// Correct SQL, correct intent, every row deliberately. But Supabase preloads
// `safeupdate` for the `authenticator` role:
//
//   authenticator: session_preload_libraries = supautils, safeupdate
//
// and PostgREST logs in as authenticator. So an unqualified UPDATE or DELETE
// inside ANY function reachable from the API raises before it does anything:
//
//   ERROR 21000: UPDATE requires a WHERE clause
//
// ── WHY THIS IS A SOURCE TEST AND NOT A REPLAY ───────────────────────────
//
// Because no replay can see it. `supabase db reset`, psql, the SQL editor, a
// migration and the sandboxes.yml database job all connect as a role that does
// NOT preload safeupdate, and there these statements run perfectly. While
// diagnosing this the function was called four ways -- as postgres, as
// authenticated, with JWT claims set, apply and dry run -- and every one
// returned the correct split. The extension only the API loads is the entire
// difference.
//
// So this is exactly the shape CLAUDE.md warns about from the other side: a
// green replay that proves nothing about the environment the app runs in.
//
// `WHERE true` satisfies safeupdate and changes no rows -- it is already the
// idiom in these very functions (`DELETE FROM _dry_share WHERE true`).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");

/** Function bodies only. A one-off UPDATE in a migration runs as postgres,
 *  where safeupdate is not loaded; it is the ones the API can CALL that
 *  matter. */
function functionBodies(sql: string): string[] {
  const bodies: string[] = [];
  // $tag$ ... $tag$ blocks that follow a CREATE FUNCTION.
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*?AS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\1/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) bodies.push(m[2]);
  return bodies;
}

function unqualified(body: string): string[] {
  // Strip line comments first: a statement introduced by a comment does not
  // begin with its verb, and the first version of this scan missed the exact
  // statement that broke production for precisely that reason.
  const lines = body.replace(/--[^\n]*/g, "").split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // A STATEMENT BEGINS A LINE. That one rule removes every false positive
    // the looser versions of this scan produced, and all of them are real
    // things in this schema that merely contain the word:
    //
    //   SELECT ... FOR UPDATE              row locking, mid-line
    //   ON CONFLICT ... DO UPDATE SET      an upsert, mid-line
    //   IF TG_OP = 'UPDATE' THEN           a trigger comparing its operation
    //   update_org_dispatch_settings       a function whose NAME contains it
    if (!/^\s*(UPDATE|DELETE\s+FROM)\b/i.test(lines[i])) continue;

    // Multi-line statement: read on to the semicolon, because the WHERE is
    // very often on a later line than the verb.
    let stmt = "";
    for (let j = i; j < lines.length; j++) {
      stmt += lines[j] + "\n";
      if (lines[j].includes(";")) break;
    }
    if (/\bWHERE\b/i.test(stmt)) continue;
    out.push(stmt.replace(/\s+/g, " ").trim().slice(0, 110));
  }
  return out;
}

/** The EFFECTIVE definition of each function: migrations replay in filename
 *  order and a later CREATE OR REPLACE supersedes an earlier one, so scanning
 *  every historical file reports bodies that no longer exist. Only what the
 *  last definition says can still be called. */
function effectiveBodies(files: string[]): Map<string, { file: string; body: string }> {
  const latest = new Map<string, { file: string; body: string }>();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    const re =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)\s*\([\s\S]*?AS\s+(\$[A-Za-z_]*\$)([\s\S]*?)\2/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql))) latest.set(m[1].toLowerCase(), { file: f, body: m[3] });

    // ...and a DROP retires it. Without this the scan reports functions that
    // no longer exist: optimize_route_for_day carries an unqualified
    // `DELETE FROM _opt_visits`, was dropped long ago, and is not in the live
    // database at all. Confirmed against production before trusting it.
    const drop = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\w.]+)/gi;
    let d: RegExpExecArray | null;
    while ((d = drop.exec(sql))) latest.delete(d[1].toLowerCase());
  }
  return latest;
}

describe("no function reachable from the API has an unqualified UPDATE or DELETE", () => {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("scans the effective definition of every function and names the offender", () => {
    const offenders: string[] = [];
    for (const [name, { file, body }] of effectiveBodies(files)) {
      for (const stmt of unqualified(body)) offenders.push(`${file}\n    ${name}: ${stmt}`);
    }
    expect(
      offenders,
      "safeupdate is preloaded for `authenticator`, so these raise\n" +
        "  ERROR 21000: UPDATE requires a WHERE clause\n" +
        "the moment the app calls them. Add `WHERE true`.\n\n  " +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  it("and the scan actually detects one when it is there", () => {
    // Guards the guard. The regexes above are the whole test; if they stop
    // matching, the suite goes quietly green over a broken app.
    const planted = `
      CREATE OR REPLACE FUNCTION public.x() RETURNS void LANGUAGE plpgsql AS $$
      BEGIN
        -- a comment, which is what defeated the first version of this scan
        UPDATE _scratch SET a = 1;
        UPDATE _scratch SET b = 2 WHERE true;
        UPDATE _scratch
           SET c = 3
         WHERE true;
        SELECT * FROM t FOR UPDATE;
        INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1;
        IF TG_OP = 'UPDATE' THEN RETURN NEW; END IF;
      END;
      $$;`;
    const found = functionBodies(planted).flatMap(unqualified);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/UPDATE _scratch SET a = 1/);
    // The planted statement sits directly after BEGIN and after a comment --
    // the two things that made earlier versions of this scan silently green.
  });
});
