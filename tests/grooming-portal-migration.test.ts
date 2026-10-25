// The grooming portal migration, read as text: a groom request is a queue
// row the portal reaches only as service_role, it refuses what the office
// could not book, and a rejected vaccine upload is shaped so it cannot also
// be verified or reasonless.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  join(import.meta.dirname, "..", "supabase/migrations/20261024100400_grooming-portal.sql"),
  "utf8",
);
const code = sql.replace(/--[^\n]*/g, "");
const fn = code.slice(
  code.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_groom"),
  code.indexOf("REVOKE ALL ON FUNCTION public.portal_request_groom"),
);
const SIG =
  "public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer)";

describe("a groom request lands in the office queue", () => {
  it("adds groom_request and keeps every earlier category, the training one included", () => {
    expect(code).toMatch(
      /CHECK \(category IN \('missed_spot','gate_left_open','damage','wrong_yard','other',\s*'reclean_request','one_off_request','training_lesson_request','groom_request'\)\)/,
    );
    expect(code).toContain("dropped an existing category");
  });

  it("adds the request's columns idempotently, matching the training portal's requested_time", () => {
    for (const col of [
      "requested_time time",
      "requested_time_end time",
      "dog_id uuid",
      "groom_addons jsonb NOT NULL DEFAULT '[]'::jsonb",
      "quoted_cents integer",
      "quoted_minutes integer",
    ])
      expect(code).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    expect(code).toContain("REFERENCES public.dogs(id) ON DELETE SET NULL");
  });

  it("holds one open request per pet per day", () => {
    expect(code).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS qc_tickets_one_open_groom_request_per_pet_day\s+ON public\.qc_tickets \(dog_id, requested_on\)\s+WHERE category = 'groom_request' AND status <> 'resolved'/,
    );
    expect(fn).toMatch(
      /ON CONFLICT \(dog_id, requested_on\)\s+WHERE category = 'groom_request' AND status <> 'resolved'\s+DO NOTHING/,
    );
  });

  it("is service_role only, like portal_request_one_off", () => {
    expect(code).toContain(`REVOKE ALL ON FUNCTION ${SIG}\n  FROM PUBLIC, anon, authenticated;`);
    expect(code).toContain(`GRANT EXECUTE ON FUNCTION ${SIG}\n  TO service_role;`);
    expect(code).not.toMatch(/GRANT [^;]*portal_request_groom[^;]*TO (anon|authenticated)/);
    expect(fn).toMatch(/SECURITY DEFINER\s+SET search_path TO 'public'/);
  });

  it("resolves the client from the token and refuses what the office could not book", () => {
    expect(fn).toContain("WHERE c.portal_token = _token AND c.active = true");
    for (const refusal of [
      "grooming_not_offered",
      "pet_not_found",
      "service_not_offered",
      "addon_not_offered",
      "date_too_soon",
      "date_too_far",
      "not_a_working_day",
      "blackout_day",
      "bad_window",
      "too_many_open_requests",
    ])
      expect(fn).toContain(`RAISE EXCEPTION '${refusal}'`);
    // The pet must live at one of THIS client's live addresses.
    expect(fn).toContain(
      "p.client_id = _client_id AND p.organization_id = _org_id AND p.archived_at IS NULL",
    );
    // Only an active grooming service, and only grooming or unlined add-ons.
    expect(fn).toContain("AND s.service_line = 'mobile_grooming'");
    expect(fn).toContain("(a.service_line IS NULL OR a.service_line = 'mobile_grooming')");
    expect(fn).toContain("'mobile_grooming' = ANY");
  });

  it("writes a queue row and never a visit or a plan", () => {
    expect(fn).toMatch(/INSERT INTO public\.qc_tickets/);
    expect(fn).toContain("'groom_request'");
    expect(fn).not.toMatch(/INSERT INTO public\.(visits|subscriptions)/);
    expect(fn).not.toMatch(/UPDATE public\.(visits|subscriptions)/);
  });

  it("hands back the first request on a second tap, before counting the open ones", () => {
    expect(fn.indexOf("RETURN QUERY SELECT _id, false")).toBeLessThan(
      fn.indexOf("too_many_open_requests"),
    );
  });
});

describe("a portal vaccine upload can be rejected", () => {
  it("adds the rejection columns and the shape that keeps them honest", () => {
    for (const col of ["rejected_at timestamptz", "rejected_by uuid", "rejection_reason text"])
      expect(code).toContain(`ALTER TABLE public.pet_vaccinations ADD COLUMN IF NOT EXISTS ${col}`);
    expect(code).toContain("REFERENCES auth.users(id) ON DELETE SET NULL");
    expect(code).toContain("(rejected_at IS NULL OR (verified_at IS NULL AND source = 'portal'))");
    expect(code).toContain("(rejected_at IS NULL) = (rejection_reason IS NULL)");
    expect(code).toContain("char_length(btrim(rejection_reason)) BETWEEN 1 AND 500");
  });

  it("takes the reviewer from the session and closes the trigger as an RPC", () => {
    const trigger = code.slice(
      code.indexOf("CREATE OR REPLACE FUNCTION public.pet_vaccinations_review_stamp"),
      code.indexOf("REVOKE ALL ON FUNCTION public.pet_vaccinations_review_stamp"),
    );
    expect(trigger).toMatch(/auth\.uid\(\) IS NOT NULL[\s\S]*NEW\.rejected_by := auth\.uid\(\)/);
    expect(trigger).toContain("NEW.rejected_by := NULL");
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION public.pet_vaccinations_review_stamp() FROM PUBLIC, anon, authenticated",
    );
    expect(code).toContain("BEFORE INSERT OR UPDATE ON public.pet_vaccinations");
  });

  it("indexes the office's pending queue", () => {
    expect(code).toMatch(
      /pet_vaccinations_pending_review_idx\s+ON public\.pet_vaccinations \(organization_id, created_at\)\s+WHERE source = 'portal' AND verified_at IS NULL AND rejected_at IS NULL/,
    );
  });
});

describe("the check block asserts only what this file creates", () => {
  const check = code.slice(code.indexOf("DO $check$"));
  it("checks the function's grants, not a count of anything in the database", () => {
    expect(check).toContain("has_function_privilege('anon', _fn, 'EXECUTE')");
    expect(check).toContain("has_function_privilege('service_role', _fn, 'EXECUTE')");
    expect(check).not.toMatch(/count\(\*\)/i);
    expect(check).not.toContain("cron.job");
    expect(check).not.toContain("pg_get_functiondef");
  });
});
