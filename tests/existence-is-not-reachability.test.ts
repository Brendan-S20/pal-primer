// Auto-routing refused every day for a week, and every check stayed green.
//
// ── WHAT HAPPENED ──────────────────────────────────────────────────────────
//
// 20260903120000 rewrote the planner to cost the closing drive and, while
// re-granting the functions it touched, applied the internal-helper pattern to
// the ENTRY POINT:
//
//     REVOKE ALL ON FUNCTION public.plan_day_across_staff(...) FROM public, anon, authenticated;
//     GRANT EXECUTE ON FUNCTION public.plan_day_across_staff(...) TO service_role;
//
// That pattern is right for road_km, route_segment_min, staff_end_point,
// closing_drive_min, dry_day_min, plan_visits, plan_route and the dryrun --
// each is reached only from inside another SECURITY DEFINER function.
// plan_day_across_staff is what the Apply button calls, through a client built
// from the publishable key plus the user's JWT, so it executes as
// `authenticated`.
//
// The result, once per day in the selected range:
//
//     2026-09-11: permission denied for function plan_day_across_staff
//     2026-09-12: permission denied for function plan_day_across_staff
//
// ── WHY NOTHING CAUGHT IT ──────────────────────────────────────────────────
//
// The migration applied cleanly, because revoking a grant is valid SQL that
// means what it says. check-migrations saw the file in the ledger.
// check-baseline-objects saw the function in the catalog -- it IS there, it is
// simply not callable by the role that calls it. The type generator emitted
// it, because types come from the signature. Every unit test passed, because
// none of them cross a role boundary.
//
// Existence and reachability are different questions, and everything we had
// asked the first one.
//
// ── AND WHY THE FIRST FIX FOR THE CHECK WAS WRONG ─────────────────────────
//
// Checking all 114 `.rpc()` call sites against `authenticated` was measured
// before it was trusted: FORTY findings, one real. The other thirty-nine were
// correct lockdowns -- twenty-one portal_* functions (the customer portal is
// token-based and runs on the service role server-side), plus admin_*,
// run_billing_cycles, move_to_dlq, enqueue_email, read_email_batch and the
// rest of the cron and webhook surface.
//
// So the client is classified per call site. With that, the same run produces
// one finding and it is the real one.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const check = read("scripts/check-rpc-grants.mjs");
const workflow = read(".github/workflows/ci.yml");
const migration = read(
  "supabase/migrations/20260910180000_auto-routing-lost-its-execute-grant.sql",
);

describe("the grant is restored", () => {
  it("grants EXECUTE on plan_day_across_staff to authenticated", () => {
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.plan_day_across_staff\(uuid, uuid\[\], date, boolean, text\)\s*\n?\s*TO authenticated/,
    );
  });

  it("does not widen it to anon", () => {
    // The org guard inside the function is what makes the authenticated grant
    // safe; anon has no auth.uid() to check and must stay out.
    expect(migration).not.toMatch(/GRANT[^;]*plan_day_across_staff[^;]*anon/);
    expect(migration).toMatch(/has_function_privilege\('anon'/);
  });

  it("asserts the outcome rather than assuming it", () => {
    // A property this migration ESTABLISHES, provable on a replay from any
    // starting state, so it is an exception rather than a warning.
    expect(migration).toMatch(/RAISE EXCEPTION/);
    expect(migration).toMatch(/has_function_privilege\('authenticated'/);
  });

  it("leaves the internal helpers locked down", () => {
    // The lockdown 20260903120000 got right must not be undone by fixing the
    // one function it got wrong.
    expect(migration).toMatch(/plan_day_across_staff_dryrun/);
  });
});

describe("and something now asks the question that was never asked", () => {
  it("checks reachability, not existence", () => {
    expect(check).toMatch(/has_function_privilege\('authenticated'/);
    expect(check).toMatch(/permission denied for function/);
  });

  it("classifies the client at each call site instead of assuming one role", () => {
    // Without this the check reports thirty-nine correct lockdowns as faults,
    // which is worse than no check at all.
    expect(check).toMatch(/serviceClients/);
    expect(check).toMatch(/supabaseAdmin/);
    // src/routes/email/queue/process.ts builds a service client and names it
    // `supabase`, so recognising the NAME alone is not enough.
    expect(check).toMatch(/[sS]erviceKey|SERVICE_ROLE/);
  });

  it("reads call sites rather than a hand-kept list", () => {
    // A list is one more thing to forget, and the fault this exists for was a
    // function nobody remembered was an entry point.
    expect(check).toMatch(/\.rpc/);
    expect(check).toMatch(/walk\(/);
  });

  it("says when it could not check something instead of skipping quietly", () => {
    expect(check).toMatch(/could not be checked|DYNAMIC/);
  });

  it("treats an unreachable database as inconclusive, not as a pass", () => {
    expect(check).toMatch(/not treating that as a failure/);
  });

  it("is wired into the job that holds the database credential", () => {
    expect(workflow).toMatch(/node scripts\/check-rpc-grants\.mjs/);
    const step = workflow.slice(workflow.indexOf("Every function the app calls, it can call"));
    expect(step.slice(0, 300)).toMatch(/SUPABASE_DB_URL/);
  });
});

describe("and the question it asks is one Postgres can answer", () => {
  // From the day it landed until 2026-10-03 the check sent
  // `ANY($$a,b,c$$::text[])`. Postgres rejects that as a malformed array
  // literal (no braces), the catch called the rejection "could not reach the
  // database", and the step exited 0: twelve errors a day in the production
  // log and a green tick on every run. The question was never asked once.
  it("sends a braced array literal", () => {
    expect(check).toMatch(/ANY\('\{\$\{names\.join\(","\)\}\}'::text\[\]\)/);
    expect(check).not.toMatch(/ANY\(\$\$\$\{names/);
  });

  it("fails when the database rejects the query, and passes only when it cannot connect", () => {
    expect(check).toMatch(/e\.status === 2/);
    expect(check).toMatch(/the database rejected this check's own query/);
    expect(check).toMatch(/process\.exit\(1\);\s*\}\s*$/m);
  });

  it("knows the campaign code's adminClient() is the service role", () => {
    // Without this the first real run reported start_email_campaign and
    // email_campaign_stats, both correctly locked to the service role.
    expect(check).toMatch(/\[aA\]dminClient/);
  });

  it("accepts a marked service-role call it cannot classify by name", () => {
    expect(check).toMatch(/rpc-role:\\s\*service/);
    const site = readFileSync(
      join(import.meta.dirname, "../src/lib/one-off-visit.server.ts"),
      "utf8",
    );
    const at = site.indexOf('rpc("generate_visits_core"');
    expect(site.slice(Math.max(0, at - 200), at)).toMatch(/rpc-role: service/);
  });

  // #684: both are portal reads/writes reached only through admin(), and both
  // migrations raise if anon or authenticated can EXECUTE them. Unmarked, the
  // check read `db` and `sb` as the request client and asked for a GRANT that
  // would have undone the portal lockdown.
  it.each([
    ["src/lib/portal-groom.server.ts", "portal_request_groom"],
    ["src/lib/training-portal.server.ts", "portal_training_lesson_notes"],
  ])("marks %s's call to %s as service-role", (file, fn) => {
    const site = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    const at = site.indexOf(`rpc("${fn}"`);
    expect(at).toBeGreaterThan(-1);
    const before = site.slice(0, at).split("\n").slice(-4).join("\n");
    expect(before).toMatch(/rpc-role:\s*service/);
  });

  it.each([
    ["portal-groom.functions.ts", "requestGroomFromPortal(await admin()"],
    ["portal-training.functions.ts", "loadPortalTraining(await admin()"],
  ])("%s hands the server code the admin client", (file, call) => {
    const src = readFileSync(join(import.meta.dirname, "../src/lib", file), "utf8");
    expect(src).toContain(call);
  });
});
