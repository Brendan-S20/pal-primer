// The first thing the unblocked IMP-2 gate did was report two false positives.
//
// ── WHAT IT SAID ──────────────────────────────────────────────────────────
//
//     ✗ 2 migration(s) exist in the repo but not in the database:
//         20260810120000_forty-three-pairs-of-policies-asked-the-same-question-twice.sql
//         20260810140000_six-helpers-that-answered-questions-about-other-peoples-tenants.sql
//
// Both had been applied on 2026-08-10 and were live. Verified against
// production rather than taken on trust, because the check's own message
// insists on exactly that before anyone writes a baseline entry:
//
//   * the policy consolidation — zero colliding permissive policy groups on
//     SELECT/ALL for `authenticated` or `anon`, across 237 policies
//   * the six helpers — `is_staff_off`, `assert_runs_routes`,
//     `assert_available_on`, `drive_minutes` and `route_segment_km` all show
//     `has_function_privilege('authenticated', …) = false`, and the two that
//     stay callable, `client_may_be_texted` and `org_has_commercial_data`,
//     carry an authorization check in their bodies and are denied to `anon`
//
// That is precisely what those migrations claim to do.
//
// ── WHY IT MISSED THEM ────────────────────────────────────────────────────
//
// Supabase's ledger stamps its own `version` and stores a `name`. For almost
// every row the name is the bare migration name; for these two it is the whole
// FILENAME, prefix included:
//
//     version           name
//     20260810044051    20260810120000_forty-three-pairs-of-policies-...
//     20260812020355    the_portal_cutoff_was_only_a_hidden_button
//
// The comparison stripped the leading timestamp from the FILE and not from the
// ledger name, so the first row could never match anything and the second
// always did. An asymmetry in a canonicalisation function, which is the
// classic place for one to hide.
//
// ── WHY THIS MATTERS MORE THAN TWO ROWS ───────────────────────────────────
//
// This script's own header says it: "a plain diff reports ~80 false positives
// and gets ignored — which is worse than no check." A gate that cries wolf
// about a migration that has been live for three days is on its way back to
// being ignored, and this one had just come back from four days of not running
// at all.

import { describe, expect, it } from "vitest";
import { normalize } from "../scripts/check-migrations.mjs";

describe("a migration name canonicalises the same from either side", () => {
  it("matches a ledger name that carries the full filename", () => {
    // The exact pair that failed, verbatim from production.
    const fromFile = "forty-three-pairs-of-policies-asked-the-same-question-twice";
    const fromLedger = "20260810120000_forty-three-pairs-of-policies-asked-the-same-question-twice";
    expect(normalize(fromLedger)).toBe(normalize(fromFile));
  });

  it("matches the other one too", () => {
    expect(normalize("20260810140000_six-helpers-that-answered-questions-about-other-peoples-tenants")).toBe(
      normalize("six-helpers-that-answered-questions-about-other-peoples-tenants"),
    );
  });

  it("still matches the ordinary shape, which is most of the ledger", () => {
    // Underscores from the MCP tool, hyphens from the CLI, same migration.
    expect(normalize("the_portal_cutoff_was_only_a_hidden_button")).toBe(
      normalize("the-portal-cutoff-was-only-a-hidden-button"),
    );
  });

  it("is case-insensitive, since three tools disagree about that too", () => {
    expect(normalize("A_Trigger_Function_Is_Not_An_RPC")).toBe(
      normalize("a-trigger-function-is-not-an-rpc"),
    );
  });

  it("does not collapse two genuinely different migrations", () => {
    // The risk of stripping more: a canonicaliser that erases too much starts
    // reporting green for migrations that were never applied, which is the
    // failure this whole script exists to prevent and far worse than a false
    // positive.
    expect(normalize("20260810120000_the-portal-cutoff-was-only-a-hidden-button")).not.toBe(
      normalize("two-new-portal-functions-arrived-granted-to-authenticated"),
    );
    expect(normalize("a_trigger_function_is_not_an_rpc")).not.toBe(
      normalize("the_rule_said_trigger_and_postgres_has_two_kinds"),
    );
  });

  it("only strips digits that LEAD, not digits inside a name", () => {
    // `billing_failed_for_fifteen_days_and_said_nothing_v3` and friends are
    // real ledger entries; a greedy digit strip would maul them.
    expect(normalize("billing_failed_for_fifteen_days_and_said_nothing_v3")).toContain("v3");
    expect(normalize("bulk_dispatch_min_uuid_fix")).toBe("bulkdispatchminuuidfix");
  });

  it("leaves a name that is only a timestamp with something to compare", () => {
    // The 2026-07-09 bootstrap row is `20260709221145_<uuid>`; stripping the
    // prefix must not leave an empty string that matches every other empty.
    expect(normalize("20260709221145_a653bb5a-1632-4460-acb0-b1e920427118")).not.toBe("");
  });
});

describe("importing the script does not run it", () => {
  it("exports the rule without shelling out to psql", () => {
    // The check calls process.exit and execFileSync('psql', …). If importing
    // it ran main(), this file would take the whole suite down with it — and
    // the guard that prevents that is one line in a script nobody reads.
    expect(typeof normalize).toBe("function");
  });
});
