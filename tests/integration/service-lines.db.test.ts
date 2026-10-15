/**
 * DB-layer proof for launch service lines.
 *
 * Local stack only. Skipped without TEST_SUPABASE_* env.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);

const runId = Math.random().toString(36).slice(2, 8);
let admin: SupabaseClient;
let orgId: string;

describe.skipIf(!enabled)("service lines in the database", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    const { data, error } = await admin
      .from("organizations")
      .insert({
        name: `Service Lines ${runId}`,
        service_lines: ["training"],
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    orgId = (data as any).id;
  });

  it("accepts training on organizations and services", async () => {
    const { error: orgError } = await admin
      .from("organizations")
      .update({ service_lines: ["dog_walking", "training"] })
      .eq("id", orgId);
    expect(orgError).toBeNull();

    const { error: serviceError } = await admin.from("services").insert({
      organization_id: orgId,
      name: `Private lesson ${runId}`,
      service_line: "training",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    });
    expect(serviceError).toBeNull();
  });

  it("refuses empty and duplicate service-line sets", async () => {
    const empty = await admin.from("organizations").update({ service_lines: [] }).eq("id", orgId);
    expect(empty.error).not.toBeNull();

    const dup = await admin
      .from("organizations")
      .update({ service_lines: ["training", "training"] })
      .eq("id", orgId);
    expect(dup.error).not.toBeNull();
  });

  it("keeps seeded service names idempotent", async () => {
    const row = {
      organization_id: orgId,
      name: "Private lesson (60 min)",
      service_line: "training",
      price_unit: "visit",
      base_price_cents: null,
      extra_pet_cents: 0,
      default_duration_min: 60,
      active: true,
    };
    const first = await admin.from("services").insert(row);
    expect(first.error).toBeNull();
    const second = await admin.from("services").insert(row);
    expect(second.error).not.toBeNull();

    const { data, error } = await admin
      .from("services")
      .select("id")
      .eq("organization_id", orgId)
      .ilike("name", "Private lesson (60 min)");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
