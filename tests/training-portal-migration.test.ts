import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const FILE = "20261023120000_training-portal.sql";
const sql = readFileSync(join(root, "supabase/migrations", FILE), "utf8");
const request = sql
  .slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_training_lesson"))
  .split("END $function$;")[0];

describe("the training portal migration", () => {
  it("is the one migration after the training cancel and no-show file", () => {
    const files = readdirSync(join(root, "supabase/migrations")).sort();
    expect(files.indexOf(FILE)).toBe(
      files.indexOf("20261023110000_training-cancel-and-no-show.sql") + 1,
    );
  });

  it("adds the share setting and the notice email switch, both on by default", () => {
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS training_share_progress boolean NOT NULL DEFAULT true",
    );
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS notify_email_training_package boolean NOT NULL DEFAULT true",
    );
    // Written by the same two roles as the session rules, never with the publishable key.
    const setter = sql.slice(sql.indexOf("FUNCTION public.set_training_share_progress"));
    expect(setter).toContain("public.has_role((select auth.uid()), _org_id, 'owner')");
    expect(setter).toContain("public.has_role((select auth.uid()), _org_id, 'office_manager')");
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.set_training_share_progress(uuid, boolean) FROM PUBLIC, anon;",
    );
  });

  it("keeps every existing request category and adds the lesson request", () => {
    expect(sql).toMatch(
      /CHECK \(category IN \('missed_spot','gate_left_open','damage','wrong_yard','other',\s*'reclean_request','one_off_request','training_lesson_request'\)\)/,
    );
    expect(sql).toContain(
      "ON public.qc_tickets (client_package_id, requested_on)\n  WHERE category = 'training_lesson_request' AND status <> 'resolved'",
    );
  });

  it("refuses a lesson request on someone else's, a canceled, an expired or a used-up package", () => {
    for (const code of [
      "invalid_token",
      "package_not_found",
      "property_not_found",
      "package_canceled",
      "package_expired",
      "date_too_soon",
      "after_expiry",
      "date_too_far",
      "no_sessions_left",
    ])
      expect(request).toContain(`RAISE EXCEPTION '${code}'`);
    expect(request).toContain("p.client_id = _client_id AND p.organization_id = _org_id");
    expect(request).toContain("FOR UPDATE");
    // Booked or used lessons and unanswered requests both count against the balance.
    expect(request).toContain("public.training_visit_holds_session(v.status, v.skip_billable)");
    expect(request).toContain("IF _held + _open >= _p.sessions_count THEN");
    // Refusals come before the insert, and a second tap returns the first request.
    expect(request.indexOf("no_sessions_left")).toBeLessThan(
      request.indexOf("INSERT INTO public.qc_tickets"),
    );
    expect(request.indexOf("RETURN QUERY SELECT _id, false;")).toBeLessThan(
      request.indexOf("no_sessions_left"),
    );
  });

  it("lets only the portal server call the request, after its session check", () => {
    expect(sql).toContain(
      "REVOKE ALL ON FUNCTION public.portal_request_training_lesson(uuid, uuid, uuid, date, time, text)\n  FROM PUBLIC, anon, authenticated;",
    );
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION public.portal_request_training_lesson(uuid, uuid, uuid, date, time, text)\n  TO service_role;",
    );
    expect(request).toContain("SECURITY DEFINER");
  });

  it("keeps the notice ledger to the service role, with two-step sign-in on it", () => {
    expect(sql).toContain("dedupe_key text PRIMARY KEY");
    expect(sql).toContain("ALTER TABLE public.training_package_notices ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("SELECT public.require_mfa_policy('public.training_package_notices');");
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.training_package_notices FROM PUBLIC, anon, authenticated;",
    );
    expect(sql).not.toMatch(/CREATE POLICY [a-z_]+ ON public\.training_package_notices/);
  });

  it("asserts only what it creates, so it replays into an empty database", () => {
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).not.toMatch(/cron\.job|count\(\*\) FROM public\.(clients|organizations)/);
    expect(sql).not.toContain("pg_get_functiondef");
  });

  it("still keeps training off the one-off request and the public service list", () => {
    // This file does not touch either; 20261023100000's refusals stand.
    expect(sql).not.toMatch(/FUNCTION public\.portal_request_one_off/);
    expect(sql).not.toMatch(/FUNCTION public\.public_services/);
  });
});
