// A SECURITY DEFINER function handed an id has to ask whose id it is.
//
// The security advisor reports 122 `authenticated_security_definer_function_
// executable` findings, and that number is not a defect list. A SECURITY
// DEFINER function callable by a signed-in user is how most of this app works;
// what the advisor is saying is that such a function runs past RLS and must
// therefore do its own authorization. The only question worth asking is which
// of the 122 do not, and the answer took a triage rather than a sweep:
//
//     122  SECURITY DEFINER, in public, executable by `authenticated`
//      84  derive the caller's org from auth.uid()             — correct
//      24  return `trigger`; PostgREST cannot call them at all
//       1  `rls_auto_enable` returns `event_trigger`, likewise
//       6  the deliberate public allowlist
//       1  `route_segment_km` joins `_plan`, a TEMP table the caller builds —
//          it can only see rows the caller made, safe by construction
//     ───
//       6  took an id and answered without asking whose it was
//
// Proven on production in a rolled-back transaction, as the owner of one org
// against ids belonging to another: `is_staff_off` -> false,
// `assert_runs_routes` and `assert_available_on` returned instead of raising,
// `client_may_be_texted` -> false, `drive_minutes` -> 40.2341007, and
// `org_has_commercial_data` -> TRUE.
//
// ── SEVERITY, STATED PLAINLY ──────────────────────────────────────────────
//
// Low. Every one is a scalar read and none writes. Five need a uuid belonging
// to another tenant, which is not guessable and is disclosed nowhere, so an
// attacker must already hold one.
//
// `org_has_commercial_data` is the one that justified fixing this now: its
// argument is an ORG id, and `public_get_org_by_slug` hands out `o.id` for any
// org with public signup enabled. Slug in, org id out, then a true/false answer
// about whether a competitor runs commercial accounts, units, waste stations or
// DNA enrolment — no guessing anywhere in the chain.
//
// ── WHY THIS FILE IS NOT A GRANT-SURFACE REPLAY ───────────────────────────
//
// The obvious rule, by analogy with the anon lockdown next door, is: replay
// every GRANT and REVOKE across the migrations, reconstruct what
// `authenticated` can reach, and require the tenant-scoped ones to be a list
// with reasons. That was built, measured against the live catalog, and thrown
// away — recorded here so it is not rebuilt.
//
// It fails twice, and the second reason is fatal.
//
//   1. The sweep heuristic reads prose. Deciding "this migration revokes from
//      authenticated" by looking for the word `authenticated` matches the
//      paragraph explaining the bug as readily as the statement fixing it. The
//      first build got `org_accepts_public_leads` wrong exactly this way.
//
//   2. Grants arrive with no statement to replay. That is the whole finding of
//      20260809180000: `ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM PUBLIC`
//      does not work, and every function created or re-signatured since has
//      arrived executable by default. A replay can model statements. It cannot
//      model a grant nobody wrote.
//
// So the reconstruction reported ZERO tenant-scoped functions reachable by
// `authenticated` while the live catalog reported one. A rule that answers
// "none" when the truth is "one" is worse than no rule, because it reads as a
// pass. The anon test next door can do this only because a catalog-wide sweep
// gives it a floor to model forward from; there is no such sweep for
// `authenticated`, and there should not be — 116 of the 122 are correct.
//
// ── WHAT IS ENFORCED INSTEAD ──────────────────────────────────────────────
//
// A rule about what a MIGRATION must contain, which needs no model of the live
// grant surface: a new SECURITY DEFINER function taking a tenant-scoped id must
// either consult `auth.uid()`, or be revoked from `authenticated` in the same
// file. Check the caller, or close the door — in the file that opens it.
//
// Scoped to migrations from the lockdown (20260809180000) forward, because
// that is when the convention was established and the historical set was
// triaged against the live catalog function by function. Everything before it
// is covered by that triage, recorded in the header of
// 20260810140000. A date window is honest about what a rule can claim; a rule
// backdated over 270 files it never checked would not be.

import { describe, expect, it } from "vitest";
import {
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
} from "./support/sql-migrations";

const THIS_MIGRATION =
  "20260810140000_six-helpers-that-answered-questions-about-other-peoples-tenants.sql";

/** The lockdown that established the convention. The rule applies from here. */
const SINCE = "20260809180000";

/** Parameters that name a row belonging to one tenant. A function taking one
 *  of these can be pointed at any tenant's row by whoever calls it. Latitude,
 *  a date or a text slug are not in this set and are not the concern. */
const TENANT_SCOPED_PARAM =
  /_(?:(?:org|organization|client|staff|property|visit|invoice|unit|subscription)\w*_id)\b/i;

const FUNCTION_HEAD =
  /^create\s+(?:or\s+replace\s+)?function\s+public\.([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*returns\b/i;

type Defined = { name: string; args: string; sql: string; file: string };

/** Every function DEFINED in the window, with the statement that defines it. */
function definedInWindow(): Defined[] {
  const out: Defined[] = [];
  for (const file of migrationFiles().filter((f) => f >= SINCE)) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      const m = FUNCTION_HEAD.exec(st);
      if (!m) continue;
      out.push({ name: m[1].toLowerCase(), args: m[2], sql: st, file });
    }
  }
  return out;
}

/**
 * Does `file` revoke EXECUTE on `fn` from `role`? Read off parsed statements,
 * not the file's text — every one of these migrations discusses at length the
 * grant it is removing, and a regex over prose finds the paragraph as readily
 * as the statement.
 *
 * `PUBLIC` and `authenticated` are deliberately separate arguments and must not
 * be collapsed into one test, which is what the first version did. They are not
 * the same revoke: `REVOKE ... FROM PUBLIC` removes the grant a function
 * INHERITS on creation, while an explicit `authenticated=X` entry survives it
 * untouched. Treating them as interchangeable made this file report that
 * `client_may_be_texted` had been closed to the app when the two lines closing
 * it to anon were added — a false alarm on a function that is still, correctly,
 * callable by every signed-in user.
 */
function revokesFrom(file: string, fn: string, role: RegExp): boolean {
  const code = stripLineComments(readMigration(file));
  for (const st of statements(code)) {
    if (!/^revoke\b/i.test(st)) continue;
    const m = /\bon\s+function\s+public\.([a-z0-9_]+)\s*\(/i.exec(st);
    if (!m || m[1].toLowerCase() !== fn) continue;
    if (role.test(st.slice(st.toLowerCase().lastIndexOf(" from ")))) return true;
  }
  return false;
}

/** Closed to the web at all — either role is enough to satisfy the rule. */
const closedToTheWeb = (file: string, fn: string) =>
  revokesFrom(file, fn, /\b(authenticated|public)\b/i);

describe("a function handed a tenant's id checks the caller, or is closed", () => {
  it("reads the window rather than passing on an empty one", () => {
    // If the parser stops matching, this collapses before the rule below can
    // report success on nothing. Three definitions live in the window today:
    // record_client_sms_consent, client_may_be_texted, org_has_commercial_data.
    expect(migrationFiles().filter((f) => f >= SINCE).length).toBeGreaterThanOrEqual(5);
    expect(definedInWindow().length).toBeGreaterThanOrEqual(3);
  });

  it("leaves none that takes a tenant id, skips auth.uid(), and stays open", () => {
    const offenders = definedInWindow()
      .filter((d) => /security\s+definer/i.test(d.sql))
      .filter((d) => TENANT_SCOPED_PARAM.test(d.args))
      .filter((d) => !/auth\.uid\s*\(\s*\)/i.test(d.sql))
      .filter((d) => !closedToTheWeb(d.file, d.name))
      .map((d) => `${d.name}(${d.args.replace(/\s+/g, " ").trim()})  in ${d.file}`);

    expect(
      offenders,
      offenders.length
        ? `each of these is SECURITY DEFINER, takes an id that belongs to one tenant, and\n` +
            `never asks who is calling — so any signed-in user of any tenant can point it at\n` +
            `any other tenant's row. Either consult auth.uid() (the shape is\n` +
            `\`auth.uid() IS NULL OR is_org_member(auth.uid(), <org>)\`, the NULL arm being\n` +
            `what keeps cron working), or REVOKE EXECUTE ... FROM authenticated in the same\n` +
            `migration if nothing in src/ calls it by RPC:\n` +
            offenders.map((o) => `  ${o}`).join("\n")
        : "",
    ).toEqual([]);
  });

  it("counts the guard as a guard only when it is in the function itself", () => {
    // Guard against the rule being satisfied by an auth.uid() somewhere else in
    // the file — a probe, or the prose. The check is per STATEMENT, and these
    // two carry it inside their own body.
    const guarded = definedInWindow().filter((d) =>
      ["client_may_be_texted", "org_has_commercial_data"].includes(d.name),
    );
    expect(guarded.map((g) => g.name).sort()).toEqual([
      "client_may_be_texted",
      "org_has_commercial_data",
    ]);
    for (const g of guarded) {
      expect(g.sql, `${g.name} lost its membership guard`).toMatch(
        /auth\.uid\(\)\s+IS\s+NULL\s+OR\s+public\.is_org_member\(auth\.uid\(\)/i,
      );
    }
  });
});

describe("the migration that closed them", () => {
  const code = () => stripLineComments(readMigration(THIS_MIGRATION));

  it("revokes the five that nothing in src/ calls by RPC", () => {
    const sql = code();
    for (const fn of [
      "is_staff_off",
      "assert_runs_routes",
      "assert_available_on",
      "drive_minutes",
      "route_segment_km",
    ]) {
      expect(closedToTheWeb(THIS_MIGRATION, fn), `${fn} is not revoked`).toBe(true);
    }
    // And does not revoke the two the app does call — that would take the
    // /my-day consent check and the commercial gate down with it.
    // These two stay callable by the app. Note the role: they ARE revoked from
    // PUBLIC/anon a few lines further down, per the per-file convention, so the
    // question here has to be about `authenticated` specifically.
    for (const fn of ["client_may_be_texted", "org_has_commercial_data"]) {
      expect(
        revokesFrom(THIS_MIGRATION, fn, /\bauthenticated\b/i),
        `${fn} must stay callable by the app`,
      ).toBe(false);
      expect(
        revokesFrom(THIS_MIGRATION, fn, /\b(anon|public)\b/i),
        `${fn} must still be closed to the publishable key`,
      ).toBe(true);
    }
    // Nothing here may take EXECUTE away from service_role — that is what the
    // nightly jobs run as. Checked on parsed REVOKE STATEMENTS rather than on
    // the file's text: the first version of this was a regex over the whole
    // file, and it matched the plpgsql variable `_revoke` in the $post$ block
    // and then ran on into an unrelated `service_role` several lines later.
    const revokes = statements(sql).filter((st) => /^revoke\b/i.test(st));
    expect(revokes.length, "five closing the helpers, two closing the replaced pair to anon").toBe(
      7,
    );
    for (const st of revokes) {
      expect(st.slice(st.toLowerCase().lastIndexOf(" from "))).not.toMatch(/service_role/i);
    }
  });

  it("proves the before and after rather than asserting them", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/do \$post\$/i);
    // The property that makes revoking safe, checked rather than assumed.
    expect(sql).toMatch(/not SECURITY DEFINER owned by postgres/);
    // The risk a guard carries is denying the people it was written for.
    expect(sql).toMatch(/changed for the caller''s OWN client/);
    expect(sql).toMatch(/changed for the caller''s OWN org/);
    // And the risk a revoke carries is silently stopping cron.
    expect(sql).toMatch(/service_role lost EXECUTE on/);
    expect(sql).toMatch(/still answers about another tenant/);
  });

  it("says what it did not do, so the advisor's 122 is not read as 122 bugs", () => {
    const sql = readMigration(THIS_MIGRATION);
    expect(sql).toMatch(/116 of them are the shape working as intended/);
    expect(sql).toMatch(/rls_enabled_no_policy/);
    expect(sql).toMatch(/auth_leaked_password_protection/);
  });
});
