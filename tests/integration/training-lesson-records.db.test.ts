/**
 * DB-layer proof that a lesson's note, homework and scores can be saved.
 * training_progress_row_guard runs on all three tables, and each reads only
 * its own columns.
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
let visitId: string;
let dogId: string;
let skillId: string;

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return (data as { id: string }).id;
}

describe.skipIf(!enabled)("training lesson records", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Lesson Records ${runId}`,
      service_lines: ["training"],
    });
    const clientId = await insert("clients", {
      organization_id: orgId,
      display_name: `Client ${runId}`,
      account_type: "residential",
    });
    const propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Test St",
      city: "Testville",
      postal_code: "48000",
    });
    dogId = await insert("dogs", { organization_id: orgId, property_id: propertyId, name: "Rex" });
    const serviceId = await insert("services", {
      organization_id: orgId,
      name: `Private lesson ${runId}`,
      service_line: "training",
      price_unit: "visit",
      default_duration_min: 60,
      active: true,
    });
    const subId = await insert("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      account_type: "residential",
      frequency: "one_time",
      dog_count: 1,
      price_cents: 9500,
      service_id: serviceId,
      started_on: "2026-10-20",
    });
    visitId = await insert("visits", {
      organization_id: orgId,
      subscription_id: subId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      scheduled_on: "2026-10-20",
    });
    skillId = await insert("training_skills", { organization_id: orgId, name: "Recall" });
  });

  it("saves a lesson note with a trainer-only note", async () => {
    const { error } = await admin.from("training_session_notes").insert({
      visit_id: visitId,
      organization_id: orgId,
      note: "Recall at 20 feet.",
      trainer_note: "Owner skipped practice.",
    });
    expect(error).toBeNull();
  });

  it("saves homework for a dog at the lesson", async () => {
    const { error } = await admin.from("homework").insert({
      visit_id: visitId,
      organization_id: orgId,
      dog_id: dogId,
      body: "Recall games in the yard.",
    });
    expect(error).toBeNull();
  });

  it("saves a score and refuses a skill from another business", async () => {
    const ok = await admin
      .from("session_progress")
      .insert({ organization_id: orgId, visit_id: visitId, skill_id: skillId, score: 3 });
    expect(ok.error).toBeNull();
    const otherOrg = await insert("organizations", {
      name: `Other ${runId}`,
      service_lines: ["training"],
    });
    const foreignSkill = await insert("training_skills", { organization_id: otherOrg, name: "Sit" });
    const bad = await admin
      .from("session_progress")
      .insert({ organization_id: orgId, visit_id: visitId, skill_id: foreignSkill, score: 2 });
    expect(bad.error?.message).toContain("Choose a skill from this business.");
  });
});
