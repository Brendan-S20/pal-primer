import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUSINESS_REASONS } from "@/lib/training-packages";

const root = join(import.meta.dirname, "..");
const sql = readFileSync(
  join(root, "supabase/migrations/20261016235000_training-trainer-note-and-cancel-time.sql"),
  "utf8",
);
const fn = (name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  return sql.slice(start).split(/\$\$;|\$function\$;/)[0];
};

describe("a trainer-only note the portal never reads", () => {
  it("adds trainer_note beside the shared note, and a row needs one of them", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS trainer_note text\s+CHECK \(trainer_note IS NULL OR/);
    expect(sql).toContain("ALTER COLUMN note DROP NOT NULL");
    expect(sql).toContain("CHECK (note IS NOT NULL OR trainer_note IS NOT NULL)");
  });
  it("is never selected by the portal's training reads", () => {
    const portal = readFileSync(join(root, "src/lib/training-portal.server.ts"), "utf8");
    // The portal never reads the table. It calls portal_training_lesson_notes
    // (20261016237000), whose RETURNS TABLE is (visit_id, note).
    expect(portal).not.toMatch(/\.from\("training_session_notes"\)/);
    expect(portal).toMatch(/\.rpc\(\s*"portal_training_lesson_notes"/);
  });
});

describe("the session rule", () => {
  const rule = fn("training_lesson_session_rule");

  it("gives a missed lesson the same exemptions as a skip", () => {
    const exempt = rule.indexOf("IN ('our_fault', 'weather', 'unsafe_conditions')");
    expect(exempt).toBeGreaterThan(0);
    expect(exempt).toBeLessThan(rule.indexOf("IF NEW.status = 'missed' THEN"));
    // The TypeScript list the office UI offers is the same list.
    expect(rule).toContain(`IN (${BUSINESS_REASONS.map((r) => `'${r}'`).join(", ")})`);
  });
  it("measures late-cancel notice from when the client called, when the office recorded it", () => {
    expect(rule).toContain("COALESCE(NEW.client_cancelled_at, now())");
    expect(rule).toContain("make_interval(hours => COALESCE(_o.training_late_cancel_hours, 24))");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS client_cancelled_at timestamptz;");
    expect(sql).toMatch(
      /CREATE TRIGGER training_lesson_session_rule\s+BEFORE UPDATE OF status, skip_billable, client_cancelled_at ON public\.visits/,
    );
  });
  it("lets only the office record the call time or choose skip_billable", () => {
    const guard = rule.slice(0, rule.indexOf("IF NEW.client_package_id IS NULL"));
    expect(guard).toContain("NEW.client_cancelled_at IS DISTINCT FROM OLD.client_cancelled_at");
    expect(guard).toContain("NOT public.can_write_org((select auth.uid()), NEW.organization_id)");
    expect(guard).toContain("Only the office can record when the client canceled.");
    // On a status change, a non-office writer's skip_billable does not count.
    expect(rule).toContain("NEW.skip_billable := (_office AND COALESCE(NEW.skip_billable, false)) OR (");
    expect(rule).not.toContain("NEW.skip_billable := COALESCE(NEW.skip_billable, false) OR");
    expect(rule).toContain("Only the office can change whether this lesson uses a session.");
  });
  it("clears the call time when the lesson goes back on the schedule", () => {
    const back = rule.slice(rule.indexOf("IF NEW.status NOT IN ('skipped', 'missed')"));
    expect(back.slice(0, back.indexOf("RETURN NEW;"))).toContain("NEW.client_cancelled_at := NULL");
  });
});

describe("the office actions that carry the reason and the time", () => {
  it("office_skip_visit stores when the client called and refuses a time in the future", () => {
    const skip = fn("office_skip_visit");
    expect(skip).toContain("_client_cancelled_at timestamptz DEFAULT NULL");
    expect(skip).toContain("client_cancelled_at = _client_cancelled_at");
    expect(skip).toContain("public.can_write_org(auth.uid(), _org)");
    expect(sql).toContain(
      "DROP FUNCTION IF EXISTS public.office_skip_visit(uuid, text, public.skip_reason_code);",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code, timestamptz) TO authenticated;",
    );
  });
  it("office_mark_visit_missed keeps its billing guard and records the reason", () => {
    const missed = fn("office_mark_visit_missed");
    expect(missed).toContain("_code public.skip_reason_code DEFAULT NULL");
    expect(missed).toContain("skip_reason_code = _code");
    expect(missed).toContain("visit_completion_billing_blocker");
    expect(missed).toContain("status = 'missed'");
    expect(missed).toContain("price_cents = NULL");
    expect(sql).toContain("DROP FUNCTION IF EXISTS public.office_mark_visit_missed(uuid);");
  });
  it("passes the call time and the missed reason from the server functions", () => {
    const visits = readFileSync(join(root, "src/lib/visits.functions.ts"), "utf8");
    expect(visits).toContain("_client_cancelled_at: data.clientCancelledAt");
    expect(visits).toContain("_code: data.code,");
  });
  it("asserts its objects at the end without pg_get_functiondef", () => {
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).toContain("RAISE EXCEPTION");
    expect(check).toContain("has_function_privilege('anon'");
    expect(check).not.toContain("pg_get_functiondef");
    expect(sql.trimEnd().endsWith("$check$;")).toBe(true);
  });
});
