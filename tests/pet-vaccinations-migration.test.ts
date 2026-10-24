import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
const read = (name: string) => readFileSync(join(import.meta.dirname, "..", name), "utf8");
const sql = read("supabase/migrations/20261024100100_a-vaccine-record-is-private.sql").replace(/--[^\n]*/g, "");
const helper = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.can_use_vaccine_record"), sql.indexOf("REVOKE ALL ON FUNCTION public.can_use_vaccine_record"));

describe("private vaccine records", () => {
  it("creates a private 10 MB bucket with only the allowed MIME types", () => {
    expect(sql).toMatch(/VALUES \('pet-vaccine-records', 'pet-vaccine-records', false, 10485760,/);
    expect(sql).toContain("ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']");
    expect(sql).not.toContain("image/svg");
    expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE SET public = false/);
    expect(sql).toMatch(/DO \$\$[\s\S]*NOT public AND file_size_limit = 10485760[\s\S]*RAISE EXCEPTION/);
  });
  it("shares the dog's property read rule and requires membership for storage and table reads", () => {
    const dogs = read("supabase/migrations/20260804090000_a-tech-could-read-every-customer-in-the-org.sql");
    expect(dogs).toMatch(/ON public.dogs\s+FOR SELECT USING \(public.may_read_property\(property_id\)\)/);
    expect(helper).toMatch(/SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(helper).toContain("public.is_org_member(auth.uid(), _org)");
    expect(helper).toContain("d.id = _dog AND d.organization_id = _org");
    expect(helper).toContain("public.may_read_property(d.property_id)");
    expect(helper).toContain("NOT write OR public.can_write_org(auth.uid(), _org)");
    expect(helper.indexOf("!~")).toBeLessThan(helper.indexOf("::uuid"));
    // A NULL or empty name has no array length; COALESCE keeps that a refusal.
    expect(helper).toContain("COALESCE(array_length(_parts, 1), 0) <> 3");
    expect(sql).toMatch(/FOR SELECT TO authenticated USING \([\s\S]*public.is_org_member\(\(SELECT auth.uid\(\)\), organization_id\)[\s\S]*public.may_read_property\(d.property_id\)/);
  });
  for (const [name, cmd, write] of [["read", "SELECT", "false"], ["upload", "INSERT", "true"], ["update", "UPDATE", "true"], ["delete", "DELETE", "true"]]) {
    it(`gates storage ${cmd} through the private bucket and helper`, () => {
      const policy = sql.split(`CREATE POLICY "vaccine records ${name}"`)[1].split(";")[0];
      expect(policy).toContain(`ON storage.objects FOR ${cmd} TO authenticated`);
      expect(policy).toContain(`bucket_id = 'pet-vaccine-records' AND public.can_use_vaccine_record(name, ${write})`);
      if (cmd === "UPDATE") { expect(policy).toContain("USING"); expect(policy).toContain("WITH CHECK"); }
    });
  }
  it("gives anon no table, storage policy or helper access and closes the trigger RPC", () => {
    expect(sql).toContain("REVOKE ALL ON public.pet_vaccinations FROM anon");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.can_use_vaccine_record(text, boolean) FROM PUBLIC, anon");
    expect(sql).toContain("REVOKE ALL ON FUNCTION public.pet_vaccinations_before_write() FROM PUBLIC, anon, authenticated");
    expect(sql).not.toMatch(/(?:GRANT .* TO anon|FOR (?:SELECT|INSERT|UPDATE|DELETE) TO (?:anon|public))/i);
    expect(sql).toContain("SELECT public.require_mfa_policy('public.pet_vaccinations')");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
  });
  it("derives the org from the dog, checks the document path and serializes the portal cap", () => {
    expect(sql).toContain("SELECT organization_id INTO _org FROM public.dogs WHERE id = NEW.dog_id FOR UPDATE");
    expect(sql).toContain("NEW.organization_id := _org");
    expect(sql).toContain("NEW.storage_path NOT LIKE _org::text || '/' || NEW.dog_id::text || '/%'");
    expect(sql).toMatch(/NEW.source = 'portal'[\s\S]*source = 'portal' AND id <> NEW.id[\s\S]*>= 20/);
    expect(sql).toContain("BEFORE INSERT OR UPDATE ON public.pet_vaccinations");
    expect(sql).toMatch(/ON public.pet_vaccinations \(dog_id, vaccine, expires_on DESC\)/);
    expect(sql).toContain("storage_path text UNIQUE");
  });
  it("takes the verifier and the creator from the session, never from the row", () => {
    const trigger = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.pet_vaccinations_before_write"), sql.indexOf("REVOKE ALL ON FUNCTION public.pet_vaccinations_before_write"));
    expect(trigger).toMatch(/auth\.uid\(\) IS NOT NULL AND NEW\.verified_at IS NOT NULL[\s\S]*NEW\.verified_by := auth\.uid\(\)/);
    expect(trigger).toMatch(/TG_OP = 'INSERT' THEN\s+IF auth\.uid\(\) IS NOT NULL THEN NEW\.created_by := auth\.uid\(\)/);
    expect(trigger).toContain("NEW.created_by := OLD.created_by");
    // Clearing a deleted verifier runs before the stamp, so it is not undone.
    expect(trigger.indexOf("NEW.verified_at := NULL")).toBeLessThan(trigger.indexOf("NEW.verified_by := auth.uid()"));
  });
  it("wraps auth.uid() in a SELECT in every table policy", () => {
    const policies = sql.match(/CREATE POLICY[\s\S]*?;/g) ?? [];
    expect(policies.length).toBe(8);
    for (const p of policies.filter((p) => p.includes("ON public.pet_vaccinations"))) {
      expect(p.replace(/\(SELECT auth\.uid\(\)\)/g, "")).not.toContain("auth.uid()");
    }
  });
  it("constrains dates, notes, source, verification and required vaccines", () => {
    expect(sql).toContain("DEFAULT 'warn'");
    expect(sql).toContain("DEFAULT '{rabies}'");
    expect(sql).toContain("array_position(required_vaccines, NULL) IS NULL");
    expect(sql).toContain("given_on IS NULL OR given_on <= expires_on");
    expect(sql).toContain("vaccine <> 'other' OR NULLIF(btrim(vaccine_note), '') IS NOT NULL");
    expect(sql).toContain("char_length(file_name) <= 200");
    expect(sql).toContain("char_length(vaccine_note) <= 80");
    expect(sql).toContain("(verified_by IS NULL) = (verified_at IS NULL)");
    expect(sql).toContain("REFERENCES auth.users(id) ON DELETE SET NULL");
  });
});
