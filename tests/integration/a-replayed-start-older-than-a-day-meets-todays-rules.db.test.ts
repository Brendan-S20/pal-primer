// #729, Brendan 2026-11-10: "cap at 24 hours."
//
// supabase/migrations/20261111030000_a-replayed-start-older-than-a-day-meets-todays-rules.sql
//
// start_visit honours a replayed Start made before the owner turned BLOCK on,
// because the tech really did start before the rule existed. Until this file
// that pass held for any _started_at up to 7 days old, so a Start asserted
// 25 hours back walked past a BLOCK set a minute ago. Now the pass holds for
// 24 hours; older, the Start is judged now, against the rule as it is now.
//
// Runs under `npm run test:db` (tests/run-db-tests.sh) against the LOCAL
// stack only, like every *.db.test.ts, and skips when none is configured.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 9);
const HOUR = 3_600_000;

let admin: SupabaseClient;
let tech: SupabaseClient;
let orgId: string;
let techUserId: string;
let staffId: string;
let clientId: string;
let propertyId: string;
let serviceId: string;

async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}
async function groomVisit() {
  const subscriptionId = await insert("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    account_type: "residential",
    frequency: "one_time",
    price_cents: 8000,
    dog_count: 1,
    started_on: "2026-11-10",
    ends_on: "2026-11-10",
  });
  return insert("visits", {
    organization_id: orgId,
    subscription_id: subscriptionId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    assigned_staff_id: staffId,
    scheduled_on: "2026-11-10",
    status: "scheduled",
  });
}
async function visitRow(visitId: string) {
  const { data } = await admin
    .from("visits")
    .select("status, started_at")
    .eq("id", visitId)
    .single();
  return data as { status: string; started_at: string | null };
}
/** The rule as the owner would leave it, set one minute ago. */
async function setRule(rule: "warn" | "block") {
  const { error } = await admin
    .from("organizations")
    .update({
      vaccine_start_rule: rule,
      vaccine_start_rule_set_at: new Date(Date.now() - 60_000).toISOString(),
    })
    .eq("id", orgId);
  if (error) throw error;
}
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR).toISOString();

describe.skipIf(!enabled)("#729 a replayed Start older than 24 hours meets today's rules", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname))
      throw new Error("Local Supabase only");
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Replay cap ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    const email = `replay-cap-tech-${runId}@test.local`;
    const password = "replay-cap-password-123!";
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    techUserId = created.data.user.id;
    await insert("user_roles", { user_id: techUserId, organization_id: orgId, role: "tech" });
    staffId = await insert("staff", {
      user_id: techUserId,
      organization_id: orgId,
      role: "tech",
      display_name: "Rae Replay",
      active: true,
    });
    tech = createClient(URL!, ANON!, { auth: { persistSession: false } });
    const signed = await tech.auth.signInWithPassword({ email, password });
    if (signed.error) throw signed.error;
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Replay client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Replay St",
      city: "Austin",
      postal_code: "78701",
    });
    // No vaccine record: under BLOCK this pet stops every Start it is judged by.
    await insert("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Pepper",
      active: true,
    });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: "Replay cap groom",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 8000,
      default_duration_min: 60,
      active: true,
    });
  }, 120_000);
  afterAll(async () => {
    if (!admin) return;
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    if (techUserId) await admin.auth.admin.deleteUser(techUserId);
  });

  it("refuses a Start replayed from 25 hours ago when BLOCK is on now", async () => {
    await setRule("block");
    const visitId = await groomVisit();
    const replay = await tech.rpc("start_visit", {
      _visit_id: visitId,
      _started_at: hoursAgo(25),
    });
    // Before the cap this passed: 25 hours is inside the 7-day window and
    // before the rule was set, so the check was skipped.
    expect(replay.error?.message).toMatch(/^VACCINE_START_BLOCKED: .*Pepper \(rabies\)/);
    expect(await visitRow(visitId)).toEqual({ status: "scheduled", started_at: null });
  });

  it("still honours a Start replayed from 2 hours ago, before BLOCK was set, at its own time", async () => {
    await setRule("block");
    const visitId = await groomVisit();
    const startedAt = hoursAgo(2);
    const replay = await tech.rpc("start_visit", { _visit_id: visitId, _started_at: startedAt });
    expect(replay.error).toBeNull();
    const row = await visitRow(visitId);
    expect(row.status).toBe("in_progress");
    expect(new Date(row.started_at!).toISOString()).toBe(startedAt);
  });

  it("honours one from just inside the day, 23 hours ago", async () => {
    await setRule("block");
    const visitId = await groomVisit();
    const replay = await tech.rpc("start_visit", {
      _visit_id: visitId,
      _started_at: hoursAgo(23),
    });
    expect(replay.error).toBeNull();
    expect((await visitRow(visitId)).status).toBe("in_progress");
  });

  it("changes nothing under WARN: a 25-hour-old replay starts and keeps its own time", async () => {
    // The stamp's own 7-day window is unchanged, because complete_visit
    // validates a replayed completion against it.
    await setRule("warn");
    const visitId = await groomVisit();
    const startedAt = hoursAgo(25);
    const replay = await tech.rpc("start_visit", { _visit_id: visitId, _started_at: startedAt });
    expect(replay.error).toBeNull();
    const row = await visitRow(visitId);
    expect(row.status).toBe("in_progress");
    expect(new Date(row.started_at!).toISOString()).toBe(startedAt);
  });
});
