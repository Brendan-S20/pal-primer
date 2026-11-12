/** A walk over its dog cap is warned, then allowed (#731), through the app's
 *  own server functions against the database the job replays.
 *
 *  Brendan, 2026-11-10 2:24 PM ET: "Warn but allow going over the dog cap".
 *  The SQL half is proved in supabase/proofs/20261111160000-... This file
 *  proves what only a real stack can: that "Assign anyway" reaches the
 *  database. The confirmation is a request header (x-dog-cap-acknowledged)
 *  that supabase-js sends and PostgREST turns into request.headers, which the
 *  trigger reads; no stub can show that chain works.
 *
 *  Each acceptance item, as the signed-in office:
 *    - one dog over the cap: the warning, and nothing saved (Cancel is this);
 *    - confirmed: saved, recorded (who, how far over) and flagged for the
 *      office and for the walker, until it is back under;
 *    - bulk assignment, drag (reassignVisit) and Cover (both its paths) give
 *      the same warning, and save and record when confirmed.
 *
 *  Only the framework wrapper and the notification side effects (pushes,
 *  live activities, the timeline) are stood in for; every write is real.
 *  Skipped without TEST_SUPABASE_* env, like every file here. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { WALK_ORG_TZ, dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";
import { orgDay } from "../support/org-day";

const caller = vi.hoisted(() => ({ supabase: null as unknown, userId: "" }));

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
        (h) =>
        (opts = {}) =>
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
  return {
    supabaseAdmin: createClient(
      process.env.TEST_SUPABASE_URL ?? "http://127.0.0.1:1",
      process.env.TEST_SUPABASE_SERVICE_KEY ?? "unset",
      { auth: { persistSession: false } },
    ),
  };
});
// Side effects of a move that are not under test here.
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
  refreshOrgRouteLiveActivities: async () => {},
  refreshRouteLiveActivities: async () => {},
}));
vi.mock("@/lib/notify-center.server", () => ({ notifyRoles: async () => {} }));
vi.mock("@/lib/activity.server", () => ({ logActivity: async () => {} }));
vi.mock("@/lib/overnight-clashes.server", () => ({ overnightClashWarning: async () => null }));
vi.mock("@/lib/training-packages.server", () => ({ lessonClashesAfterMove: async () => [] }));
vi.mock("@/lib/groom-clash.server", () => ({
  refuseGroomMoveClash: async () => {},
  groomWriteError: async (_db: unknown, e: { message: string }) => new Error(e.message),
}));

const today = orgDay(WALK_ORG_TZ);

let org: WalkOrg;
let groupServiceId: string;

type Person = { userId: string; client: SupabaseClient };

async function asCaller<T>(who: Person, run: () => Promise<T>): Promise<T> {
  caller.supabase = who.client;
  caller.userId = who.userId;
  return run();
}

/** A walk today with `dogs` dogs, in group `groupId` (or none). */
async function walk(dogs: number, groupId: string | null, staffId: string | null = null) {
  const { admin, orgId } = org;
  const n = Math.random().toString(36).slice(2, 8);
  const clientId = await insertRow(admin, "clients", {
    organization_id: orgId,
    display_name: `Cap client ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(admin, "properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Cap St`,
    city: "Austin",
    postal_code: "78701",
  });
  const subscriptionId = await insertRow(admin, "subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    dog_count: dogs,
    frequency: "one_time",
    price_cents: 2500,
    service_id: groupServiceId,
    status: "active",
    started_on: today,
  });
  const visitId = await insertRow(admin, "visits", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    subscription_id: subscriptionId,
    service_id: groupServiceId,
    scheduled_on: today,
    status: "scheduled",
    assigned_staff_id: staffId,
  });
  if (groupId) {
    const joined = await admin.from("visits").update({ walk_group_id: groupId }).eq("id", visitId);
    if (joined.error) throw new Error(joined.error.message);
  }
  return visitId;
}

async function group(walkerId: string | null = null) {
  return insertRow(org.admin, "walk_groups", {
    organization_id: org.orgId,
    service_id: groupServiceId,
    scheduled_on: today,
    assigned_staff_id: walkerId,
  });
}

async function visitRow(id: string) {
  const { data, error } = await org.admin
    .from("visits")
    .select("walk_group_id, assigned_staff_id")
    .eq("id", id)
    .single();
  if (error) throw new Error(error.message);
  return data as { walk_group_id: string | null; assigned_staff_id: string | null };
}

async function records(groupId: string) {
  const { data, error } = await org.admin
    .from("walk_dog_cap_overrides")
    .select("staff_id, dogs, cap, over_by, recorded_by")
    .eq("walk_group_id", groupId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

const ann = () => org.walker.staffId!;
const bo = () => org.otherWalker.staffId!;
const owner = () => org.owner as Person;

describe.skipIf(!dbEnabled)("a walk over its dog cap is warned, then allowed", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Dog cap warning");
    groupServiceId = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Pack walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 60,
      max_dogs: 10,
    });
    const capped = await org.admin
      .from("staff")
      .update({ max_dogs_per_walk: 3 })
      .eq("id", org.walker.staffId!);
    if (capped.error) throw new Error(capped.error.message);
  }, 60_000);

  afterAll(async () => {
    await org?.cleanup();
  });

  it("one dog over: the warning, and nothing is saved until the person confirms", async () => {
    const { setWalkGroupMember, listWalksOverDogCap } = await import("@/lib/walk-groups.functions");
    const g = await group(ann());
    await walk(2, g);
    await walk(1, g);
    const fourth = await walk(1, null);

    const warned = await asCaller(owner(), () =>
      setWalkGroupMember({ data: { visitId: fourth, groupId: g } }),
    );
    expect(warned).toMatchObject({ overCap: { dogs: 4, cap: 3, walker: "Walker walker" } });
    // Cancel is this state: nothing joined, nothing recorded, nothing flagged.
    expect((await visitRow(fourth)).walk_group_id).toBeNull();
    expect(await records(g)).toEqual([]);

    const saved = await asCaller(owner(), () =>
      setWalkGroupMember({ data: { visitId: fourth, groupId: g, overCapAcknowledged: true } }),
    );
    expect(saved).toEqual({ ok: true });
    expect((await visitRow(fourth)).walk_group_id).toBe(g);
    expect(await records(g)).toEqual([
      { staff_id: ann(), dogs: 4, cap: 3, over_by: 1, recorded_by: org.owner.userId },
    ]);

    // Flagged for the office and for Ann herself.
    const forOffice = await asCaller(owner(), () => listWalksOverDogCap({ data: { day: today } }));
    expect(forOffice.walks).toContainEqual(
      expect.objectContaining({ walkGroupId: g, staffId: ann(), dogs: 4, cap: 3 }),
    );
    const forAnn = await asCaller(org.walker as Person, () =>
      listWalksOverDogCap({ data: { day: today } }),
    );
    expect(forAnn.walks.map((w) => w.walkGroupId)).toContain(g);
    const forBo = await asCaller(org.otherWalker as Person, () =>
      listWalksOverDogCap({ data: { day: today } }),
    );
    expect(forBo.walks.map((w) => w.walkGroupId)).not.toContain(g);

    // Back under the cap, the flag goes.
    const out = await asCaller(owner(), () =>
      setWalkGroupMember({ data: { visitId: fourth, groupId: null } }),
    );
    expect(out).toEqual({ ok: true });
    const after = await asCaller(owner(), () => listWalksOverDogCap({ data: { day: today } }));
    expect(after.walks.map((w) => w.walkGroupId)).not.toContain(g);
  });

  it("bulk assignment: the same warning, nothing moved; confirmed, moved and recorded", async () => {
    const { bulkAssignVisits } = await import("@/lib/visits.functions");
    const g = await group(null);
    const a = await walk(2, g);
    const b = await walk(2, g);
    const warned = await asCaller(owner(), () =>
      bulkAssignVisits({ data: { visitIds: [a, b], staffId: ann() } }),
    );
    expect(warned).toMatchObject({ moved: 0, overCap: { dogs: 4, cap: 3 } });
    expect((await visitRow(a)).assigned_staff_id).toBeNull();
    expect((await visitRow(b)).assigned_staff_id).toBeNull();

    const moved = await asCaller(owner(), () =>
      bulkAssignVisits({ data: { visitIds: [a, b], staffId: ann(), overCapAcknowledged: true } }),
    );
    expect(moved).toMatchObject({ moved: 2 });
    expect((await records(g))[0]).toMatchObject({ dogs: 4, cap: 3, over_by: 1 });
  });

  it("drag on the board: the same warning, nothing moved; confirmed, moved and recorded", async () => {
    const { reassignVisit } = await import("@/lib/visits.functions");
    const g = await group(null);
    const a = await walk(2, g, ann());
    const b = await walk(2, g);
    const warned = await asCaller(owner(), () =>
      reassignVisit({ data: { visitId: b, staffId: ann() } }),
    );
    expect(warned).toMatchObject({ overCap: { dogs: 4, cap: 3 } });
    expect((await visitRow(b)).assigned_staff_id).toBeNull();
    const moved = await asCaller(owner(), () =>
      reassignVisit({ data: { visitId: b, staffId: ann(), overCapAcknowledged: true } }),
    );
    expect(moved).toMatchObject({ ok: true });
    expect((await visitRow(b)).assigned_staff_id).toBe(ann());
    expect((await visitRow(a)).assigned_staff_id).toBe(ann());
    expect(await records(g)).toHaveLength(1);
  });

  it("Cover, for the dates away: what fits moves, the rest is the same warning; confirmed, it moves", async () => {
    const { redistributeStaffWork } = await import("@/lib/visits.functions");
    const g = await group(bo());
    const k1 = await walk(2, g);
    const k2 = await walk(2, g);
    // Every other walk Ann holds today is in other groups, so on this one she
    // has room for one of these two and not both.
    const first = await asCaller(owner(), () =>
      redistributeStaffWork({ data: { staffId: bo(), from: today, to: today } }),
    );
    expect(first).toMatchObject({ overCap: { dogs: 4, cap: 3 }, overCapVisits: 1 });
    const heldByBo = [await visitRow(k1), await visitRow(k2)].filter(
      (v) => v.assigned_staff_id === bo(),
    );
    expect(heldByBo).toHaveLength(1);
    expect(await records(g)).toEqual([]);

    await asCaller(owner(), () =>
      redistributeStaffWork({
        data: { staffId: bo(), from: today, to: today, overCapAcknowledged: true },
      }),
    );
    expect((await visitRow(k1)).assigned_staff_id).toBe(ann());
    expect((await visitRow(k2)).assigned_staff_id).toBe(ann());
    expect((await records(g))[0]).toMatchObject({ staff_id: ann(), dogs: 4, cap: 3 });
  });

  it("Cover, for everything from today: one piece, so nothing moves until it is confirmed", async () => {
    const { redistributeStaffWork } = await import("@/lib/visits.functions");
    const g = await group(bo());
    const k1 = await walk(2, g);
    const k2 = await walk(2, g);
    const first = await asCaller(owner(), () =>
      redistributeStaffWork({ data: { staffId: bo(), includeLater: true } }),
    );
    expect(first).toMatchObject({ moved: 0, overCap: { cap: 3 } });
    expect((await visitRow(k1)).assigned_staff_id).toBe(bo());
    expect((await visitRow(k2)).assigned_staff_id).toBe(bo());

    await asCaller(owner(), () =>
      redistributeStaffWork({
        data: { staffId: bo(), includeLater: true, overCapAcknowledged: true },
      }),
    );
    expect((await visitRow(k1)).assigned_staff_id).toBe(ann());
    expect((await visitRow(k2)).assigned_staff_id).toBe(ann());
    expect(await records(g)).toHaveLength(1);
  });

  it("reopening a completed walk: the same warning, still completed; confirmed, reopened and recorded", async () => {
    const { reopenVisitFromOffice } = await import("@/lib/visits.functions");
    const g = await group(ann());
    const done = await walk(2, g);
    // Completed, it gives its place back, and the group fills to the cap.
    const finished = await org.admin
      .from("visits")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", done);
    if (finished.error) throw new Error(finished.error.message);
    await walk(2, g);
    await walk(1, g);

    const warned = await asCaller(owner(), () =>
      reopenVisitFromOffice({ data: { visitId: done } }),
    );
    expect(warned).toMatchObject({ overCap: { dogs: 5, cap: 3 } });
    const still = await org.admin.from("visits").select("status").eq("id", done).single();
    expect(still.data?.status).toBe("completed");
    expect(await records(g)).toEqual([]);

    const reopened = await asCaller(owner(), () =>
      reopenVisitFromOffice({ data: { visitId: done, overCapAcknowledged: true } }),
    );
    expect(reopened).toEqual({ ok: true });
    const after = await org.admin.from("visits").select("status").eq("id", done).single();
    expect(after.data?.status).toBe("scheduled");
    expect((await records(g))[0]).toMatchObject({ staff_id: ann(), dogs: 5, cap: 3, over_by: 2 });
  });

  it("a signed-in client cannot write a record of its own", async () => {
    const g = await group(ann());
    const { error } = await owner().client.from("walk_dog_cap_overrides").insert({
      organization_id: org.orgId,
      walk_group_id: g,
      staff_id: ann(),
      dogs: 9,
      cap: 3,
    });
    expect(error).not.toBeNull();
  });
});
