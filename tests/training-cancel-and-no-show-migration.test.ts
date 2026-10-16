import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const root = join(import.meta.dirname, "..");
const sql = readFileSync(
  join(root, "supabase/migrations/20261016200000_training-cancel-and-no-show.sql"),
  "utf8",
);
const fn = (name: string) =>
  sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)).split("$$;")[0];

describe("canceling a package does not strand its lessons", () => {
  it("lets a lesson already on a canceled package be completed, skipped or kept, and refuses new ones", () => {
    const guard = fn("training_visit_package_guard");
    const canceled = guard.slice(
      guard.indexOf("ELSIF _p.status = 'canceled'"),
      guard.indexOf("ELSIF _p.expires_on"),
    );
    expect(canceled).toContain(
      "TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id",
    );
    expect(canceled).toContain("NEW.status NOT IN ('scheduled', 'in_progress')");
    expect(canceled).toContain(
      "public.training_visit_holds_session(OLD.status, OLD.skip_billable)",
    );
    expect(canceled).toContain("OLD.scheduled_on <= _today");
    expect(canceled).toContain("This package was canceled.");
    expect(guard).toContain("AT TIME ZONE COALESCE(o.timezone, 'America/Chicago')");
    // New bookings on a canceled package are still refused by the plan guard.
    expect(fn("training_subscription_package_guard")).toContain("IF _p.status = 'canceled' THEN");
  });
  it("cancels only scheduled lessons after today, in the same transaction as the package", () => {
    const cancel = fn("cancel_client_package");
    expect(cancel).toContain("public.can_write_org((select auth.uid()), _p.organization_id)");
    expect(cancel).toContain("FOR UPDATE");
    expect(cancel).toContain("status = 'scheduled' AND scheduled_on > _today");
    expect(cancel).toContain("SET status = 'canceled'");
    expect(cancel).toContain("Choose what happens to the booked lessons.");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.cancel_client_package(uuid, boolean) FROM PUBLIC, anon;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.cancel_client_package(uuid, boolean) TO authenticated",
    );
  });
});

describe("a no-show or late cancel can use a session", () => {
  it("adds the two business settings with their defaults and bounds", () => {
    expect(sql).toMatch(
      /training_late_cancel_hours integer NOT NULL DEFAULT 24\s+CHECK \(training_late_cancel_hours BETWEEN 0 AND 168\)/,
    );
    expect(sql).toContain("training_missed_uses_session boolean NOT NULL DEFAULT true");
    const set = fn("set_training_session_rules");
    expect(set).toContain("public.has_role((select auth.uid()), _org_id, 'owner')");
    expect(set).toContain("public.has_role((select auth.uid()), _org_id, 'office_manager')");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.set_training_session_rules(uuid, integer, boolean) FROM PUBLIC, anon;",
    );
  });
  it("counts missed with skip_billable as used everywhere, through one helper", () => {
    expect(fn("training_visit_uses_session")).toContain(
      "_status IN ('skipped', 'missed') AND COALESCE(_skip_billable, false)",
    );
    expect(fn("training_visit_holds_session")).toContain("_status IN ('scheduled', 'in_progress')");
    for (const name of [
      "training_client_package_guard",
      "training_visit_package_guard",
      "training_package_recount",
      "training_subscription_package_guard",
      "client_package_session_number",
    ]) {
      expect(fn(name)).toMatch(/public\.training_visit_(uses|holds)_session\(/);
      expect(fn(name)).not.toContain("v.skip_billable = true");
    }
    for (const helper of ["training_visit_uses_session", "training_visit_holds_session"])
      expect(sql).toContain(
        `REVOKE ALL ON FUNCTION public.${helper}(public.visit_status, boolean) FROM PUBLIC, anon, authenticated;`,
      );
  });
  it("applies the rule on a status change and leaves the override to the office", () => {
    const rule = fn("training_lesson_session_rule");
    expect(rule).toContain("NEW.client_package_id IS NULL THEN RETURN NEW");
    expect(rule).toContain("NEW.skip_billable := COALESCE(_o.training_missed_uses_session, true)");
    expect(rule).toContain("('our_fault', 'weather', 'unsafe_conditions')");
    expect(rule).toContain("make_interval(hours => COALESCE(_o.training_late_cancel_hours, 24))");
    expect(rule).toContain("s.earliest_time");
    expect(rule).toContain("Only the office can change whether this lesson uses a session.");
    expect(rule).toContain("NOT public.can_write_org((select auth.uid()), NEW.organization_id)");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.training_lesson_session_rule() FROM PUBLIC, anon, authenticated;",
    );
    expect(sql).toContain(
      "CREATE TRIGGER training_lesson_session_rule BEFORE UPDATE OF status, skip_billable ON public.visits",
    );
    // Runs before the package guard, so the guard counts the flag this rule chose.
    expect("training_lesson_session_rule" < "zz_training_visit_package_guard").toBe(true);
  });
  it("asserts its objects at the end", () => {
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).toContain("training_lesson_session_rule");
    expect(check).toContain("has_function_privilege('anon'");
    expect(check).toContain("RAISE EXCEPTION");
    expect(check).not.toContain("pg_get_functiondef");
    expect(sql.trimEnd().endsWith("$check$;")).toBe(true);
  });
});
