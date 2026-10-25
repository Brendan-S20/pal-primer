import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
let admin: SupabaseClient;
let owner: SupabaseClient;
let outsider: SupabaseClient;
let orgId: string;
let otherOrg: string;
let serviceId: string;
let wasteService: string;
let ruleId: string;
const users: string[] = [];

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

async function member(org: string, label: string) {
  const email = `groom-${label}-${runId}@test.local`;
  const password = "groom-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const user = data.user!.id;
  users.push(user);
  await insert("user_roles", { organization_id: org, user_id: user, role: "owner" });
  await insert("staff", {
    organization_id: org,
    user_id: user,
    role: "owner",
    display_name: label,
  });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(signed.error.message);
  return client;
}

describe.skipIf(!enabled)("groom size rules in the database", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Groom ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    otherOrg = await insert("organizations", {
      name: `Other groom ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    owner = await member(orgId, "owner");
    outsider = await member(otherOrg, "outsider");
    const base = {
      organization_id: orgId,
      price_unit: "visit",
      default_duration_min: 60,
      base_price_cents: 6000,
    };
    serviceId = await insert("services", {
      ...base,
      name: `Groom ${runId}`,
      service_line: "mobile_grooming",
    });
    wasteService = await insert("services", {
      ...base,
      name: `Waste ${runId}`,
      service_line: "pet_waste",
    });
  });

  it("inserts general and coat rules and derives organization_id, including when omitted or spoofed", async () => {
    const result = await owner
      .from("service_size_rules")
      .insert({
        service_id: serviceId,
        size: "small",
        coat_type: null,
        duration_min: 60,
        price_cents: 6000,
        organization_id: otherOrg,
      })
      .select("*")
      .single();
    expect(result.error).toBeNull();
    expect(result.data?.organization_id).toBe(orgId);
    ruleId = result.data!.id;
    const coat = await owner
      .from("service_size_rules")
      .insert({
        service_id: serviceId,
        size: "small",
        coat_type: "long",
        duration_min: 90,
        price_cents: 9000,
      })
      .select("organization_id")
      .single();
    expect(coat.error).toBeNull();
    expect(coat.data?.organization_id).toBe(orgId);
    const update = await owner
      .from("service_size_rules")
      .update({ organization_id: otherOrg, duration_min: 65 })
      .eq("id", ruleId)
      .select("organization_id, duration_min")
      .single();
    expect(update.error).toBeNull();
    expect(update.data).toEqual({ organization_id: orgId, duration_min: 65 });
  });

  it("refuses duplicate rules including NULL coat", async () => {
    for (const coat of [null, "long"]) {
      const result = await owner
        .from("service_size_rules")
        .insert({
          service_id: serviceId,
          size: "small",
          coat_type: coat,
          duration_min: 60,
          price_cents: 6000,
        });
      expect(result.error?.code).toBe("23505");
    }
  });

  it("refuses rules on pet-waste services", async () => {
    const result = await admin
      .from("service_size_rules")
      .insert({ service_id: wasteService, size: "large", duration_min: 60, price_cents: 6000 });
    expect(result.error?.message).toContain("only for mobile grooming");
  });

  it("refuses invalid size, coat, length and price", async () => {
    for (const patch of [
      { size: "giant" },
      { coat_type: "silky" },
      { duration_min: 0 },
      { duration_min: 721 },
      { price_cents: -1 },
      { price_cents: 10000001 },
    ]) {
      const result = await admin
        .from("service_size_rules")
        .insert({
          service_id: serviceId,
          size: "large",
          duration_min: 60,
          price_cents: 6000,
          ...patch,
        });
      expect(result.error?.code).toBe("23514");
    }
  });

  it("allows upsert of the any-coat rule with NULLS NOT DISTINCT", async () => {
    const result = await owner
      .from("service_size_rules")
      .upsert(
        {
          service_id: serviceId,
          size: "medium",
          coat_type: null,
          duration_min: 70,
          price_cents: 7500,
        },
        { onConflict: "service_id,size,coat_type" },
      )
      .select("id")
      .single();
    expect(result.error).toBeNull();
    const again = await owner
      .from("service_size_rules")
      .upsert(
        {
          service_id: serviceId,
          size: "medium",
          coat_type: null,
          duration_min: 75,
          price_cents: 8000,
        },
        { onConflict: "service_id,size,coat_type" },
      )
      .select("id")
      .single();
    expect(again.error).toBeNull();
    expect(again.data?.id).toBe(result.data?.id);
  });

  it("keeps another organization's member from reading, inserting, updating or deleting a rule", async () => {
    const read = await outsider.from("service_size_rules").select("*").eq("service_id", serviceId);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([]);
    const added = await outsider
      .from("service_size_rules")
      .insert({
        organization_id: otherOrg,
        service_id: serviceId,
        size: "xlarge",
        duration_min: 90,
        price_cents: 9500,
      });
    expect(added.error?.code).toBe("42501");
    for (const op of ["update", "delete"] as const) {
      const query =
        op === "update"
          ? outsider.from("service_size_rules").update({ price_cents: 1 })
          : outsider.from("service_size_rules").delete();
      const result = await query.eq("id", ruleId).select("id");
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    }
    const kept = await admin
      .from("service_size_rules")
      .select("price_cents")
      .eq("id", ruleId)
      .single();
    expect(kept.data?.price_cents).toBe(6000);
  });

  afterAll(async () => {
    if (!admin) return;
    // Remove fixture dependents before the organizations' default services.
    for (const org of [orgId, otherOrg].filter(Boolean)) {
      await admin.from("service_size_rules").delete().eq("organization_id", org);
      await admin.from("organizations").delete().eq("id", org);
    }
    for (const user of users) await admin.auth.admin.deleteUser(user);
  });
});
