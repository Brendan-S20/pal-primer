/** Assign by capacity asks about time off as the office, and only about its
 *  own people (#733 follow-up).
 *
 *  assignWalkGroupsByCapacity asked public.is_staff_off through the signed-in
 *  client. That function is service-role only (20260810140000 revoked it from
 *  authenticated: it answers about anyone's time off with no tenant check), so
 *  on production every press of Assign by capacity failed with "permission
 *  denied for function is_staff_off". Main's live-migrations job caught it
 *  (check-rpc-grants, job 129196447331). The fix keeps the grant as it is:
 *  the caller must pass can_write_org first, every id is confirmed to be that
 *  org's staff, and only then is is_staff_off asked as the service role.
 *
 *  This runs the REAL server function the app calls, as each signed-in person,
 *  against the database the job replays from every migration. Only the
 *  framework wrapper is stood in for (its handler runs with the caller's own
 *  authenticated client, the context the auth middleware builds) and the
 *  service-role client is the real one, wrapped to record what it is asked.
 *
 *  Skipped without TEST_SUPABASE_* env, like every file here. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  DB_ANON,
  DB_URL,
  WALK_ORG_TZ,
  dbEnabled,
  insertRow,
  makeWalkOrg,
  type WalkOrg,
} from "../support/walk-db";
import { orgDay } from "../support/org-day";

const caller = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));
/** Every rpc the service-role client was asked, in order. */
const asked = vi.hoisted(() => ({
  rpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    type Builder = {
      middleware: () => Builder;
      inputValidator: (v: (d: unknown) => unknown) => Builder;
      handler: (
        h: (ctx: { data: unknown; context: unknown }) => unknown,
      ) => (opts?: { data?: unknown }) => unknown;
    };
    const b: Builder = {
      middleware: () => b,
      inputValidator: (v) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({
            data: validate(opts.data ?? {}),
            context: { supabase: caller.supabase, userId: caller.userId },
          }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(
    process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:1",
    process.env.TEST_SUPABASE_SERVICE_KEY ?? "unset",
    { auth: { persistSession: false } },
  );
  const rpc = admin.rpc.bind(admin);
  // Records every rpc, then asks the real database exactly as before.
  admin.rpc = ((fn: string, args: Record<string, unknown>, opts?: Parameters<typeof rpc>[2]) => {
    asked.rpc.push({ fn, args });
    return rpc(fn, args, opts);
  }) as typeof admin.rpc;
  return { supabaseAdmin: admin };
});

const password = "capacity-time-off-password-123!";
const today = orgDay(WALK_ORG_TZ);

type Office = { userId: string; client: SupabaseClient };
type Side = { org: WalkOrg; dispatcher: Office; groupServiceId: string; staffIds: string[] };

let A: Side;
let B: Side;
const extraUsers: Array<{ org: WalkOrg; userId: string }> = [];

async function dispatcherOf(org: WalkOrg): Promise<Office> {
  const email = `dispatcher-${Math.random().toString(36).slice(2, 10)}@capacitytimeoff.local`;
  const { data, error } = await org.admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const userId = data.user!.id;
  extraUsers.push({ org, userId });
  await insertRow(org.admin, "user_roles", {
    user_id: userId,
    organization_id: org.orgId,
    role: "dispatcher",
  });
  const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return { userId, client };
}

async function side(label: string): Promise<Side> {
  const org = await makeWalkOrg(label);
  const dispatcher = await dispatcherOf(org);
  const groupServiceId = await insertRow(org.admin, "services", {
    organization_id: org.orgId,
    name: "Pack walk",
    service_line: "dog_walking",
    price_unit: "visit",
    base_price_cents: 2500,
    default_duration_min: 60,
    max_dogs: 6,
  });
  const { data, error } = await org.admin
    .from("staff")
    .select("id")
    .eq("organization_id", org.orgId);
  if (error) throw new Error(error.message);
  return { org, dispatcher, groupServiceId, staffIds: (data ?? []).map((r) => r.id) };
}

/** A walk today for a new client, in a new group with nobody on it. */
async function openGroup(s: Side) {
  const { admin, orgId } = s.org;
  const n = Math.random().toString(36).slice(2, 8);
  const clientId = await insertRow(admin, "clients", {
    organization_id: orgId,
    display_name: `Capacity client ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(admin, "properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Capacity St`,
    city: "Austin",
    postal_code: "78701",
  });
  const subscriptionId = await insertRow(admin, "subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "one_time",
    price_cents: 2500,
    service_id: s.groupServiceId,
    status: "active",
    started_on: today,
  });
  const visitId = await insertRow(admin, "visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: s.groupServiceId,
    scheduled_on: today,
    status: "scheduled",
  });
  const groupId = await insertRow(admin, "walk_groups", {
    organization_id: orgId,
    service_id: s.groupServiceId,
    scheduled_on: today,
  });
  const joined = await admin.from("visits").update({ walk_group_id: groupId }).eq("id", visitId);
  if (joined.error) throw new Error(joined.error.message);
  return { groupId, visitId };
}

async function walkerOf(s: Side, visitId: string) {
  const { data, error } = await s.org.admin
    .from("visits")
    .select("assigned_staff_id")
    .eq("id", visitId)
    .single();
  if (error) throw new Error(error.message);
  return (data as { assigned_staff_id: string | null }).assigned_staff_id;
}

async function groupIdsOf(s: Side) {
  const { data, error } = await s.org.admin
    .from("walk_groups")
    .select("id")
    .eq("organization_id", s.org.orgId);
  if (error) throw new Error(error.message);
  return new Set((data ?? []).map((r) => r.id));
}

async function off(s: Side, staffId: string) {
  await insertRow(s.org.admin, "staff_time_off", {
    organization_id: s.org.orgId,
    staff_id: staffId,
    starts_on: today,
    ends_on: today,
    reason: "test",
  });
}

/** Runs the app's server function as `who`. */
async function assignAs(who: { userId: string; client: SupabaseClient }) {
  const { assignWalkGroupsByCapacity } = await import("@/lib/walk-groups.functions");
  caller.supabase = who.client;
  caller.userId = who.userId;
  return assignWalkGroupsByCapacity({ data: { day: today } }) as Promise<{
    assigned: Array<{ groupId: string; walkerId: string }>;
    kept: Array<{ groupId: string; reason: string }>;
  }>;
}

const staffOffIds = () =>
  asked.rpc.filter((c) => c.fn === "is_staff_off").map((c) => c.args._staff_id as string);

describe.skipIf(!dbEnabled)("Assign by capacity asks about time off as the office", () => {
  beforeAll(async () => {
    A = await side("Capacity time-off A");
    B = await side("Capacity time-off B");
    // Each business has one walker off today. Without time off the tie between
    // two empty walkers goes by name, and "Walker other" sorts first, so in A
    // the group only reaches "Walker walker" if A's time off was really read.
    await off(A, A.org.otherWalker.staffId!);
    await off(B, B.org.walker.staffId!);
  }, 60_000);

  afterAll(async () => {
    for (const { org, userId } of extraUsers) await org.admin.auth.admin.deleteUser(userId);
    await A?.org.cleanup();
    await B?.org.cleanup();
  });

  beforeEach(() => {
    asked.rpc.length = 0;
  });

  it("the old call: a dispatcher's own client cannot execute is_staff_off (what production said)", async () => {
    const { error } = await A.dispatcher.client.rpc("is_staff_off", {
      _staff_id: A.org.walker.staffId,
      _day: today,
    });
    expect(error?.message ?? "no error").toMatch(/permission denied for function is_staff_off/);
  });

  it("a dispatcher's Assign by capacity succeeds, called as authenticated the way the app calls it", async () => {
    const g = await openGroup(A);
    const result = await assignAs(A.dispatcher);
    expect(result.assigned).toContainEqual({ groupId: g.groupId, walkerId: A.org.walker.staffId });
    expect(await walkerOf(A, g.visitId)).toBe(A.org.walker.staffId);
    // Time off was asked on the service role, about A's own people only.
    const ids = staffOffIds();
    expect(ids).toContain(A.org.otherWalker.staffId);
    for (const id of ids) expect(A.staffIds).toContain(id);
    for (const id of ids) expect(B.staffIds).not.toContain(id);
  });

  it("the owner's Assign by capacity succeeds too", async () => {
    const g = await openGroup(A);
    const result = await assignAs(A.org.owner);
    expect(result.assigned).toContainEqual({ groupId: g.groupId, walkerId: A.org.walker.staffId });
    expect(await walkerOf(A, g.visitId)).toBe(A.org.walker.staffId);
    for (const id of staffOffIds()) expect(A.staffIds).toContain(id);
  });

  it("a tech is refused before anything is asked as the service role, and nothing is written", async () => {
    const g = await openGroup(A);
    await expect(assignAs(A.org.walker)).rejects.toThrow(/Not authorized/);
    expect(asked.rpc).toEqual([]);
    expect(await walkerOf(A, g.visitId)).toBeNull();
  });

  it("another business's dispatcher works only their own day: never A's groups, never A's people's time off", async () => {
    const a = await openGroup(A);
    const b = await openGroup(B);
    const result = await assignAs(B.dispatcher);
    // B's own time off is honoured: B's walker is off, so B's other walker.
    expect(result.assigned).toContainEqual({
      groupId: b.groupId,
      walkerId: B.org.otherWalker.staffId,
    });
    // Nothing in the answer is about A, and A's open group is untouched.
    const bGroups = await groupIdsOf(B);
    for (const r of [...result.assigned, ...result.kept]) expect(bGroups).toContain(r.groupId);
    expect(await walkerOf(A, a.visitId)).toBeNull();
    // Time off was asked only about B's people.
    const ids = staffOffIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(B.staffIds).toContain(id);
    for (const id of ids) expect(A.staffIds).not.toContain(id);
  });
});
