// The undeclared-schema check called `plan_visits` undeclared, and it is not.
//
// ── WHAT IT SAID ──────────────────────────────────────────────────────────
//
//     ✗ 1 function(s) exist in the database but in no migration:
//         plan_visits
//
// on main, on 2026-08-19, in the first CI run since 2026-08-15 that got far
// enough to execute this step at all.
//
// ── WHY IT WAS WRONG ──────────────────────────────────────────────────────
//
// 20260815190000 creates `plan_visits` by splicing it out of
// `pg_get_functiondef('public.plan_route(...)')` — the header replaced, the
// candidate-set clause replaced, the start point replaced — and then running
// `EXECUTE _def;`. Its own comment says why, and the reason is good: the body
// is ~150 lines of nearest-neighbour with time-window penalties and a 2-opt
// pass, and "a hand copy would be a second solver that agrees today and
// diverges the first time anyone touches either. This whole migration exists
// because two implementations of one idea disagreed."
//
// So there is no literal `CREATE FUNCTION public.plan_visits(` in the repo and
// there is not supposed to be, while `isDeclared` matched nothing else.
//
// A rebuilt database DOES get the function. The migration creates it and then
// refuses to finish if it did not — `to_regprocedure(...) IS NULL` then
// `RAISE EXCEPTION 'plan_visits was not created'` — which is a STRONGER
// guarantee than a literal CREATE, because a CREATE sitting inside a branch
// that never fires satisfies the regex and produces nothing.
//
// ── WHY A FALSE POSITIVE HERE IS THE EXPENSIVE KIND ───────────────────────
//
// This script's sibling states the standard: "a plain diff reports ~80 false
// positives and gets ignored — which is worse than no check." This check is the
// only thing standing between the repo and a rebuild that silently lacks a
// SECURITY DEFINER function; it earns that position by being believable.
//
// ── AND WHY THE FIX IS NARROW ─────────────────────────────────────────────
//
// The hole this script was written to close is that a mention of a name is not
// a definition: `email_queue_wake` appeared in a GRANT list while being defined
// nowhere, and an early version matching /FUNCTION\s+name\s*\(/ let both a
// GRANT and a DROP through. Widening the rule at all risks re-opening exactly
// that, so the dynamic form demands two things in ONE file — constructed DDL
// actually executed, and the migration asserting this function exists when it
// finishes — and every mutation below that keeps only one of them still fails.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createsDynamically,
  createsLiterally,
  isDeclared,
} from "../scripts/check-schema-declared.mjs";

const MIGRATIONS = join(__dirname, "..", "supabase", "migrations");

const files = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS, f), "utf8") }));

const SPLICE_FILE = "20260815190000_the-preview-showed-every-tech-the-whole-day.sql";

describe("a function the repo builds rather than writes out", () => {
  it("still has no literal CREATE, so the old rule genuinely could not see it", () => {
    // If someone later writes the CREATE out by hand this test starts passing
    // for the wrong reason, so assert the premise rather than assume it.
    expect(files.some(({ sql }) => createsLiterally(sql, "plan_visits"))).toBe(false);
  });

  it("counts plan_visits as declared", () => {
    expect(isDeclared(files, "plan_visits")).toBe(true);
  });

  it("credits every file that actually splices it, and only those", () => {
    // This was a hardcoded list — first `[SPLICE_FILE]`, then
    // `[SPLICE_FILE, RESPLICE_FILE]` — and it needed an edit every time
    // plan_route changed, because a change to plan_route MUST respice
    // plan_visits or the two drift apart. That is the whole purpose of the
    // splice, so the list grows forever and pinning it tests the calendar
    // rather than the property. 20260831150000 was the second edit in two
    // days; that is the signal to assert the invariant instead.
    //
    // The strength is unchanged and lives in `createsDynamically`, which
    // demands two things in one file: DDL that is constructed and actually
    // EXECUTEd, and the migration asserting the function exists when it
    // finishes. A mere mention in a GRANT or a DROP — the hole this whole
    // script was written to close — still credits nobody.
    const crediting = files.filter(({ sql }) => createsDynamically(sql, "plan_visits"));

    // The original is always in it, and always first.
    expect(crediting.length).toBeGreaterThan(0);
    expect(crediting[0].file).toBe(SPLICE_FILE);

    // Filename order, which for these files is apply order. A respice that
    // landed before the file it derives from would be nonsense.
    expect(crediting.map((f) => f.file)).toEqual([...crediting.map((f) => f.file)].sort());

    // And the filter genuinely discriminates: a migration that only MENTIONS
    // plan_visits, in the guarded GRANT block, is not credited with building
    // it. Without this the three assertions above would also pass if
    // createsDynamically matched everything.
    const mentionsOnly = files.filter(
      ({ file, sql }) => sql.includes("plan_visits") && !crediting.some((c) => c.file === file),
    );
    expect(mentionsOnly.length).toBeGreaterThan(0);
  });

  // ── the mutations ───────────────────────────────────────────────────────
  //
  // Each keeps one half of the rule and drops the other. All must fail, or the
  // rule has become "the name appears somewhere", which is the original bug.
  const spliceSql = files.find((f) => f.file === SPLICE_FILE)!.sql;

  it("refuses a migration that asserts existence but executes no built DDL", () => {
    const withoutExecute = spliceSql.replace(/\bEXECUTE\s+_def\s*;/gi, "-- removed;");
    expect(createsDynamically(withoutExecute, "plan_visits")).toBe(false);
  });

  it("refuses a migration that executes built DDL but never names the function", () => {
    const withoutAssertion = spliceSql.replace(/to_regprocedure/gi, "to_regprocedure_NOT");
    expect(createsDynamically(withoutAssertion, "plan_visits")).toBe(false);
  });

  it("refuses the drop direction, where the guard reads IS NOT NULL", () => {
    // A migration REMOVING a function guards the other way round. Reading that
    // as a declaration would let a deletion vouch for the thing it deletes.
    const asADrop = spliceSql.replace(
      /(to_regprocedure\(\s*'public\.plan_visits\([^']*'\s*\)\s*)IS\s+NULL/gi,
      "$1IS NOT NULL",
    );
    expect(createsDynamically(asADrop, "plan_visits")).toBe(false);
  });

  it("refuses a bare GRANT, which is the fault this check was built for", () => {
    const grantOnly = "GRANT EXECUTE ON FUNCTION public.email_queue_wake(uuid) TO authenticated;";
    expect(createsLiterally(grantOnly, "email_queue_wake")).toBe(false);
    expect(createsDynamically(grantOnly, "email_queue_wake")).toBe(false);
    expect(isDeclared([{ file: "x.sql", sql: grantOnly }], "email_queue_wake")).toBe(false);
  });

  it("refuses a DROP", () => {
    const dropOnly = "DROP FUNCTION IF EXISTS public.rls_auto_enable();";
    expect(isDeclared([{ file: "x.sql", sql: dropOnly }], "rls_auto_enable")).toBe(false);
  });

  it("does not let two unrelated files supply one half each", () => {
    // The reason the check reads per file rather than one concatenated string.
    const executesOnly = "DO $$ BEGIN EXECUTE _def; END $$;";
    const assertsOnly =
      "DO $$ BEGIN IF to_regprocedure('public.ghost(uuid)') IS NULL THEN RAISE EXCEPTION 'no'; END IF; END $$;";
    expect(
      isDeclared(
        [
          { file: "a.sql", sql: executesOnly },
          { file: "b.sql", sql: assertsOnly },
        ],
        "ghost",
      ),
    ).toBe(false);
  });
});
