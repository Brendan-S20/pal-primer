// #851 follow-up in a real database. Brendan, 2026-11-10: "No, provide a
// warning as to why they were blocked." So BLOCK (the owner's vaccine Start
// rule, #729) never stops a Complete, on any path, and a completion of a
// blocked groom is written down.
//
// What only a real database can say:
//   - complete_visit (the tech's, My Day and the apps), office_complete_visit
//     (the drawer, the board, the Visits tab) and a direct status write each
//     complete a NEVER-STARTED blocked groom, while Start is still refused;
//   - the lookup behind the warning reads what RLS lets each caller read: the
//     tech gets the reason and "the owner", the office gets the owner's name;
//   - the office's real server function writes the activity_log row with the
//     block, who completed it, when, and that the warning was acknowledged.
//
// Runs under `npm run test:db` against the LOCAL stack only, and skips when
// none is configured. No migration: the warning is UI, the record is the
// existing timeline (activity_log via logActivity).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 9);
const users: string[] = [];

type Caller = { client: SupabaseClient; userId: string; staffId: string };
let admin: SupabaseClient;
let orgId: string;
let owner: Caller;
let tech: Caller;
let clientId: string;
let propertyId: string;
let serviceId: string;

// The server function runs for real, with the OWNER's own client as its
// context, so RLS decides what it may read and write. Only the side trips
// that need a live Worker (route notices, live activities) are stubbed.
const ctx = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({
            data: validate(args?.data),
            context: { supabase: ctx.supabase, userId: ctx.userId },
          }),
    };
    return b;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => null }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));

async function insert(table: string, row: Record<string, unknown>) {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id as string;
}
async function makeUser(role: "owner" | "tech", name: string): Promise<Caller> {
  const email = `blocked-complete-${role}-${users.length}-${runId}@test.local`;
  const password = "blocked-complete-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;
  users.push(data.user.id);
  await insert("user_roles", { user_id: data.user.id, organization_id: orgId, role });
  const staffId = await insert("staff", {
    user_id: data.user.id,
    organization_id: orgId,
    role,
    display_name: name,
    active: true,
  });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw signed.error;
  return { client, staffId, userId: data.user.id };
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
    started_on: "2026-11-08",
    ends_on: "2026-11-08",
  });
  return insert("visits", {
    organization_id: orgId,
    subscription_id: subscriptionId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    assigned_staff_id: tech.staffId,
    scheduled_on: "2026-11-08",
    status: "scheduled",
  });
}
async function statusOf(visitId: string) {
  const { data } = await admin.from("visits").select("status").eq("id", visitId).single();
  return data?.status;
}

describe.skipIf(!enabled)("#851 follow-up: BLOCK warns at Complete and never stops it", () => {
  beforeAll(async () => {
    if (!["127.0.0.1", "localhost", "[::1]"].includes(new globalThis.URL(URL!).hostname))
      throw new Error("Local Supabase only");
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Blocked complete ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    owner = await makeUser("owner", "Olive Owner");
    tech = await makeUser("tech", "Theo Tech");
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Blocked client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Block St",
      city: "Austin",
      postal_code: "78701",
    });
    await insert("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Biscuit",
      active: true,
    });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: "Blocked groom",
      service_line: "mobile_grooming",
      price_unit: "visit",
      base_price_cents: 8000,
      default_duration_min: 60,
      active: true,
    });
    // The owner turns BLOCK on through the real door, so the trail has a row.
    const set = await owner.client.rpc("set_vaccine_start_rule", {
      _org_id: orgId,
      _rule: "block",
    });
    expect(set.error).toBeNull();
  }, 120_000);
  afterAll(async () => {
    if (!admin) return;
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    for (const user of users) await admin.auth.admin.deleteUser(user);
  });

  it("Start is still refused (no change to Start)", async () => {
    const visitId = await groomVisit();
    const refused = await tech.client.rpc("start_visit", { _visit_id: visitId });
    expect(refused.error?.message).toMatch(/^VACCINE_START_BLOCKED: .*Biscuit \(rabies\)/);
    expect(await statusOf(visitId)).toBe("scheduled");
  });

  it("the tech's complete_visit completes a never-started blocked groom", async () => {
    const visitId = await groomVisit();
    const done = await tech.client.rpc("complete_visit", {
      _visit_id: visitId,
      _no_photo_reason: "Camera broke on site, groom was done",
    });
    expect(done.error).toBeNull();
    expect(await statusOf(visitId)).toBe("completed");
  });

  it("a direct status write to completed is not refused by the BLOCK guard", async () => {
    const visitId = await groomVisit();
    const direct = await tech.client
      .from("visits")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", visitId)
      .select("id");
    // Whatever else the row's own rules say, it is never the vaccine rule.
    expect(direct.error?.message ?? "").not.toMatch(/VACCINE_START_BLOCKED/);
  });

  it("the warning's lookup gives the tech the reason, and the office the owner's name too", async () => {
    const visitId = await groomVisit();
    const { completionBlockWarning } = await import("@/lib/completion-block.server");
    const forTech = await completionBlockWarning(tech.client as any, visitId);
    expect(forTech?.missing).toEqual([
      expect.objectContaining({ dog_name: "Biscuit", vaccine: "rabies" }),
    ]);
    expect(forTech?.setAt).toBeTruthy();
    expect(forTech?.setBy).toBeNull(); // the trail is office-only; the dialog says "the owner"
    const forOwner = await completionBlockWarning(owner.client as any, visitId);
    expect(forOwner?.setBy).toBe("Olive Owner");
  });

  it("the office Complete goes through and the timeline records who, when, why, and the acknowledgement", async () => {
    const visitId = await groomVisit();
    ctx.supabase = owner.client;
    ctx.userId = owner.userId;
    const { completeVisitFromOffice } = await import("@/lib/visits.functions");
    const run = (data: Record<string, unknown>) =>
      (completeVisitFromOffice as any)({ data: { visitId, blockAcknowledged: true, ...data } });
    const before = Date.now();
    let r = await run({});
    // The business may ask why there is no photo (#658); that is not the block.
    if (r.ok === false) r = await run({ overrideReason: "Done; photo on the groomer's phone" });
    expect(r).toEqual({ ok: true });
    expect(await statusOf(visitId)).toBe("completed");

    const { data: rows, error } = await admin
      .from("activity_log")
      .select("kind, actor_user_id, summary, meta, created_at")
      .eq("organization_id", orgId)
      .eq("kind", "visit.completed")
      .order("created_at", { ascending: false })
      .limit(1);
    expect(error).toBeNull();
    const row = rows![0] as any;
    expect(row.actor_user_id).toBe(owner.userId);
    expect(row.summary).toMatch(
      /despite the block, after the warning \(Blocked: Biscuit: rabies\)/,
    );
    expect(row.meta.blocked_completion).toMatchObject({
      reason: "Biscuit: rabies",
      rule_set_by: "Olive Owner",
      warning_acknowledged: true,
      completed_by: owner.userId,
    });
    expect(Date.parse(row.meta.blocked_completion.completed_at)).toBeGreaterThanOrEqual(
      before - 1000,
    );
  });
});
