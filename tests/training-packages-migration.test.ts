import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const root = join(import.meta.dirname, "..");
const sql = readFileSync(
  join(root, "supabase/migrations/20261023100000_a-trainer-sells-a-package-of-sessions.sql"),
  "utf8",
);
const fn = (name: string) => sql.slice(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`)).split("$$;")[0];

describe("the training package migration", () => {
  it("protects both tables with tenant writes and MFA, and reuses the clients read rule", () => {
    for (const table of ["service_packages", "client_packages"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`SELECT public.require_mfa_policy('public.${table}')`);
      expect(sql).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon`);
      for (const op of ["INSERT", "UPDATE", "DELETE"]) expect(sql).toMatch(new RegExp(`CREATE POLICY ${table}_${op.toLowerCase()}[^;]+can_write_org`, "s"));
    }
    expect(sql).toContain("public.may_read_client_row(organization_id, client_id)");
    expect(sql).toContain("UNIQUE (client_id, request_id)");
    expect(sql).toContain("WHERE invoice_id IS NOT NULL");
    expect(sql).toContain("sessions_used BETWEEN 0 AND sessions_count");
    expect(sql).toContain("expires_after_days BETWEEN 1 AND 730");
    expect(sql).toContain("sessions_count BETWEEN 1 AND 100");
    for (const table of ["visits", "subscriptions"]) expect(sql).toContain(`ALTER TABLE public.${table} ADD COLUMN IF NOT EXISTS client_package_id`);
  });
  it("snapshots the service, price and session count and validates the client's dog and invoice", () => {
    const guard = fn("training_client_package_guard");
    for (const column of ["service_id", "name", "sessions_count", "price_cents"]) expect(guard).toContain(`NEW.${column} := _p.${column}`);
    expect(guard).toContain("NEW.purchased_on + _p.expires_after_days");
    expect(guard).toContain("AT TIME ZONE");
    expect(guard).toContain("p.client_id = NEW.client_id");
    expect(guard).toContain("i.client_id = NEW.client_id");
    expect(guard).toContain("i.subtotal_cents = NEW.price_cents");
    expect(guard).toContain("IF NOT _p.active");
    expect(guard).toContain("pg_trigger_depth() < 2");
    expect(fn("training_service_package_guard")).toContain("s.service_line = 'training'");
    expect(fn("training_service_package_guard")).not.toContain("s.active");
  });
  it("locks the package and skips only generator-derived inserts on capacity or expiry failures", () => {
    const guard = fn("training_visit_package_guard");
    expect(guard).toContain("FOR UPDATE");
    expect(guard).toContain("_derived := NEW.client_package_id IS NOT NULL AND TG_OP = 'INSERT'");
    expect(guard).toContain("IF _derived THEN RETURN NULL; END IF");
    expect(guard).toContain("ERRCODE = 'check_violation'");
    expect(guard).toContain("NEW.scheduled_on > _p.expires_on");
    expect(guard).toContain("v.id <> NEW.id");
    expect(guard).toContain("No sessions left in this package: %s of %s are booked or used.");
    expect(guard).toContain("This package was canceled.");
    expect(guard).toContain("NOT (NEW.status IN ('scheduled', 'in_progress', 'completed')");
    expect(guard).toContain("Not authorized to change this visit package.");
  });
  it("recounts both package links and never increments usage, including retries and deletes", () => {
    const recount = fn("training_package_recount");
    expect(recount).toContain("OLD.client_package_id");
    expect(recount).toContain("NEW.client_package_id");
    expect(recount).toContain("IS NOT DISTINCT FROM");
    expect(recount).toMatch(/SET sessions_used = \(\s*SELECT count\(\*\)/);
    expect(recount).not.toMatch(/sessions_used\s*[+-]|sessions_used\s*=\s*sessions_used/);
    expect(recount).toContain("v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true)");
    expect(sql).toContain("AFTER INSERT OR UPDATE OR DELETE ON public.visits");
  });
  it("forces package plans to zero-price postpaid on creation and later price or cadence edits", () => {
    const guard = fn("training_subscription_package_guard");
    expect(guard).toContain("NEW.price_cents := 0");
    expect(guard).toContain("NEW.billing_cadence := 'postpaid'");
    expect(guard).toContain("NEW.started_on > _p.expires_on");
    expect(guard).toContain("_held >= _p.sessions_count");
    expect(sql).toContain("UPDATE OF client_package_id, price_cents, billing_cadence, started_on");
  });
  it("splices the two billing predicates and leaves the invoice function in place", () => {
    expect(sql).not.toContain("CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client");
    expect(sql).toContain("AND li.id IS NULL AND v.client_package_id IS NULL");
    expect(sql).toContain("pg_get_functiondef('public.admin_generate_invoice_for_client(uuid, date)'::regprocedure)");
    expect(sql).toContain("Both billing queries must exclude package visits.");
    expect(sql).toContain("service_not_offered");
    expect(sql).toContain("s.service_line <> ''training''");
    for (const table of ["training_skills", "session_progress", "training_session_notes", "homework"]) {
      expect(sql).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`SELECT public.require_mfa_policy('public.${table}')`);
    }
  });
  it("keeps numbering in scheduled day and id order and asserts its objects at the end", () => {
    expect(fn("client_package_session_number")).toContain("row_number() OVER (ORDER BY v.scheduled_on, v.id)");
    expect(fn("client_package_session_number")).toContain("public.may_read_client_row");
    const check = sql.slice(sql.indexOf("DO $check$"));
    expect(check).toContain("pg_trigger");
    expect(check).toContain("relrowsecurity");
    expect(check).toContain("RAISE EXCEPTION");
    expect(check).toContain("Both billing queries must exclude package visits.");
    expect(sql.trimEnd().endsWith("$check$;")).toBe(true);
  });
});
