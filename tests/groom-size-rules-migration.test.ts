import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVICE_LINES } from "@/lib/service-lines";

const sql = readFileSync(
  new URL(
    "../supabase/migrations/20261016150000_a-groom-is-timed-by-the-pets-size.sql",
    import.meta.url,
  ),
  "utf8",
);
const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

describe("the grooming schema", () => {
  it("extends dogs without constraining imported weight_class or creating another pets table", () => {
    expect(sql).toMatch(/dogs ADD COLUMN IF NOT EXISTS coat_type text/i);
    expect(sql).toMatch(/dogs ADD COLUMN IF NOT EXISTS weight_lb numeric\(5,1\)/i);
    expect(sql).toMatch(/CHECK \(weight_lb > 0 AND weight_lb <= 300\)/);
    expect(sql.match(/'short','medium','long','double','curly','wire'/g)).toHaveLength(2);
    expect(sql).not.toMatch(/CHECK[^;]*weight_class|CREATE TABLE[^;]*public\.pets/i);
  });
  it("sets every rule bound and treats a NULL coat as one unique any-coat rule", () => {
    expect(sql).toMatch(/REFERENCES public\.services\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/size IN \('small','medium','large','xlarge'\)/);
    expect(sql).toMatch(/duration_min BETWEEN 1 AND 720/);
    expect(sql).toMatch(/price_cents BETWEEN 0 AND 10000000/);
    expect(sql).toMatch(/UNIQUE NULLS NOT DISTINCT \(service_id, size, coat_type\)/);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS[^;]+\(service_id\)/);
  });
  it("derives the tenant from the service on every write and refuses other service lines", () => {
    expect(sql).toMatch(
      /SELECT s\.organization_id, s\.service_line INTO NEW\.organization_id, service_line/,
    );
    expect(sql).toMatch(
      /IF service_line <> 'mobile_grooming' THEN\s+RAISE EXCEPTION 'Size rules are only for mobile grooming services\.'/,
    );
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE ON public\.service_size_rules/);
    expect(sql).toMatch(/NEW\.updated_at := now\(\)/);
    expect(sql).toMatch(/SET search_path TO 'public', 'pg_temp'/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_service_size_rules_service\(\) FROM PUBLIC, anon, authenticated/,
    );
  });
  it("uses member reads, existing office write gates, MFA and no anonymous grants", () => {
    expect(sql).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/require_mfa_policy\('public\.service_size_rules'\)/);
    expect(sql).toMatch(/FOR SELECT TO authenticated\s+USING \(public\.is_org_member/);
    expect(sql).toMatch(/FOR INSERT TO authenticated\s+WITH CHECK \(public\.can_write_org/);
    expect(sql).toMatch(
      /FOR UPDATE TO authenticated\s+USING \(public\.can_write_org[\s\S]*?WITH CHECK \(public\.can_write_org/,
    );
    expect(sql).toMatch(/FOR DELETE TO authenticated\s+USING \(public\.can_write_org/);
    expect(sql).toMatch(
      /REVOKE ALL ON public\.service_size_rules FROM PUBLIC, anon, authenticated/,
    );
  });
  it("keeps old add-ons at zero minutes and any line, accepting every known line", () => {
    expect(sql).toMatch(/duration_min smallint NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/duration_min BETWEEN 0 AND 480/);
    expect(sql).toMatch(/service_line IS NULL OR service_line IN/);
    for (const line of SERVICE_LINES) expect(sql).toContain(`'${line}'`);
    expect(sql).not.toMatch(
      /UPDATE public\.(addon_services|services|dogs)|INSERT INTO public\.(addon_services|services|dogs)/i,
    );
  });
  it("ends with structural proofs that need no tenant or live data", () => {
    const post = sql.slice(sql.indexOf("DO $post$"));
    for (const proof of [
      "RAISE EXCEPTION",
      "information_schema.columns",
      "pg_constraint",
      "pg_index",
      "indnullsnotdistinct",
      "pg_trigger",
      "relrowsecurity",
      "pg_policies",
      "has_function_privilege",
      "has_table_privilege",
    ])
      expect(post).toContain(proof);
    expect(post.trim()).toMatch(/END;\s+\$post\$;$/);
    expect(post).not.toMatch(/pg_get_functiondef|FROM public\.(dogs|services|organizations)/);
  });
});

describe("existing writes carry the new facts without changing other paths", () => {
  it("dog creation, editing and inline onboarding accept and persist nullable coat and weight", () => {
    for (const file of ["src/lib/dogs.functions.ts", "src/lib/clients.functions.ts"]) {
      const code = source(file);
      expect(code).toMatch(/coatType: z\.enum\(COAT_TYPES\)\.nullable\(\)\.optional\(\)/);
      expect(code).toMatch(
        /weightLb: z\.number\(\)\.positive\(\)\.max\(300\)\.multipleOf\(0\.1\)\.nullable\(\)\.optional\(\)/,
      );
      expect(code).toMatch(/coat_type: (data|d)\.coatType \?\? null/);
      expect(code).toMatch(/weight_lb: (data|d)\.weightLb \?\? null/);
    }
    const dogs = source("src/lib/dogs.functions.ts");
    expect(dogs).toMatch(/if \(data\.coatType !== undefined\) patch\.coat_type = data\.coatType/);
    expect(dogs).toMatch(/if \(data\.weightLb !== undefined\) patch\.weight_lb = data\.weightLb/);
  });
  it("addon updates only write new fields when supplied and retain the billing permission", () => {
    const code = source("src/lib/addons.functions.ts");
    expect(code).toContain("durationMin: z.number().int().min(0).max(480).optional()");
    expect(code).toContain("serviceLine: z.enum(SERVICE_LINES).nullable().optional()");
    expect(code).toContain(
      "if (data.durationMin !== undefined) payload.duration_min = data.durationMin",
    );
    expect(code).toContain(
      "if (data.serviceLine !== undefined) payload.service_line = data.serviceLine",
    );
    expect(code).toContain('"manage_client_billing"');
  });
});
