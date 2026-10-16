/** Local stack only. CI builds the database from migrations before running this suite. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const enabled = Boolean(URL && SERVICE && ANON);
const runId = Math.random().toString(36).slice(2, 10);
const password = "walk-test-password-123!";
const nextMonday = new Date();
nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
while (nextMonday.getUTCDay() !== 1) nextMonday.setUTCDate(nextMonday.getUTCDate() + 1);
const monday = nextMonday.toISOString().slice(0, 10);
const fridayDate = new Date(nextMonday);
fridayDate.setUTCDate(fridayDate.getUTCDate() + 4);
const friday = fridayDate.toISOString().slice(0, 10);

let admin: SupabaseClient;
let tech: SupabaseClient;
let orgId: string;
let soloServiceId: string;
let groupServiceId: string;
let techStaffId: string;
let otherStaffId: string;
const userIds: string[] = [];
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return data.id;
}

async function household(temperament = "friendly") {
  const clientId = await ins("clients", {
    organization_id: orgId,
    display_name: `Walk client ${++serial}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await ins("properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${serial} Walk St`,
    city: "Austin",
    postal_code: "78701",
  });
  const dogId = await ins("dogs", {
    organization_id: orgId,
    property_id: propertyId,
    name: `Dog ${serial}`,
    active: true,
    temperament,
  });
  return { clientId, propertyId, dogId };
}

async function makeWalk(
  options: {
    temperament?: string;
    groupId?: string;
    assignedStaffId?: string;
    home?: Awaited<ReturnType<typeof household>>;
  } = {},
) {
  const home = options.home ?? (await household(options.temperament));
  const subscriptionId = await ins("subscriptions", {
    organization_id: orgId,
    client_id: home.clientId,
    property_id: home.propertyId,
    account_type: "residential",
    dog_count: 1,
    frequency: "one_time",
    price_cents: 2000,
    service_id: groupServiceId,
    status: "active",
    started_on: monday,
  });
  const visitId = await ins("visits", {
    organization_id: orgId,
    client_id: home.clientId,
    property_id: home.propertyId,
    subscription_id: subscriptionId,
    service_id: groupServiceId,
    scheduled_on: monday,
    status: "scheduled",
    assigned_staff_id: options.assignedStaffId ?? null,
    walk_group_id: options.groupId ?? null,
  });
  return { ...home, subscriptionId, visitId };
}

async function makeGroup() {
  return ins("walk_groups", {
    organization_id: orgId,
    service_id: groupServiceId,
    scheduled_on: monday,
  });
}

async function join(visitId: string, groupId: string) {
  return admin.from("visits").update({ walk_group_id: groupId }).eq("id", visitId);
}

describe.skipIf(!enabled)("walk scheduling and group walks in the database", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Walks ${runId}`,
      service_lines: ["dog_walking"],
      timezone: "UTC",
    });
    soloServiceId = await ins("services", {
      organization_id: orgId,
      name: "Solo walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 30,
    });
    groupServiceId = await ins("services", {
      organization_id: orgId,
      name: "Group walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2000,
      default_duration_min: 30,
      max_dogs: 2,
    });
    for (const name of ["tech", "other"]) {
      const email = `${name}-${runId}@walktest.local`;
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error) throw new Error(error.message);
      const uid = data.user!.id;
      userIds.push(uid);
      await ins("user_roles", { user_id: uid, organization_id: orgId, role: "tech" });
      const staffId = await ins("staff", {
        organization_id: orgId,
        user_id: uid,
        role: "tech",
        display_name: `Walker ${name}`,
      });
      if (name === "tech") {
        techStaffId = staffId;
        tech = createClient(URL!, ANON!, { auth: { persistSession: false } });
        const signedIn = await tech.auth.signInWithPassword({ email, password });
        if (signedIn.error) throw new Error(signedIn.error.message);
      } else otherStaffId = staffId;
    }
  });

  afterAll(async () => {
    if (!admin) return;
    if (orgId) await admin.from("organizations").delete().eq("id", orgId);
    for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
  });

  it("generates two Mon/Wed/Fri walks per property and repeats without duplicates", async () => {
    const home = await household();
    const plans: string[] = [];
    for (const [earliest_time, latest_time] of [
      ["11:00", "13:00"],
      ["16:00", "18:00"],
    ]) {
      plans.push(
        await ins("subscriptions", {
          organization_id: orgId,
          client_id: home.clientId,
          property_id: home.propertyId,
          account_type: "residential",
          dog_count: 1,
          frequency: "weekly",
          weekdays: [1, 3, 5],
          price_cents: 2500,
          service_id: soloServiceId,
          status: "active",
          started_on: monday,
          earliest_time,
          latest_time,
        }),
      );
    }
    const generate = () =>
      admin.rpc("generate_visits_core", {
        _org_id: orgId,
        _through: friday,
        _subscription_id: null,
      });
    const first = await generate();
    expect(first.error).toBeNull();
    expect(first.data).toBe(6);
    const readVisits = () =>
      admin
        .from("visits")
        .select(
          "id, subscription_id, scheduled_on, property_id, service_id, subscriptions(earliest_time, latest_time)",
        )
        .in("subscription_id", plans)
        .order("scheduled_on");
    const before = await readVisits();
    expect(before.error).toBeNull();
    expect(before.data).toHaveLength(6);
    for (const day of [...new Set(before.data!.map((visit) => visit.scheduled_on))]) {
      const visits = before.data!.filter((visit) => visit.scheduled_on === day);
      expect(visits).toHaveLength(2);
      expect(
        visits.every(
          (visit) => visit.property_id === home.propertyId && visit.service_id === soloServiceId,
        ),
      ).toBe(true);
      const windows = visits.map(
        (visit) => visit.subscriptions as unknown as { earliest_time: string; latest_time: string },
      );
      expect(
        windows
          .map((window) => [window.earliest_time.slice(0, 5), window.latest_time.slice(0, 5)])
          .sort(),
      ).toEqual([
        ["11:00", "13:00"],
        ["16:00", "18:00"],
      ]);
    }
    expect(before.data!.filter((visit) => visit.scheduled_on === monday)).toHaveLength(2);
    const second = await generate();
    expect(second.error).toBeNull();
    expect(second.data).toBe(0);
    const after = await readVisits();
    expect(after.error).toBeNull();
    expect(after.data!.map((visit) => visit.id).sort()).toEqual(
      before.data!.map((visit) => visit.id).sort(),
    );
  });

  it("allows two one-dog visits and refuses a third", async () => {
    const groupId = await makeGroup();
    const a = await makeWalk();
    const b = await makeWalk();
    const c = await makeWalk();
    expect((await join(a.visitId, groupId)).error).toBeNull();
    expect((await join(b.visitId, groupId)).error).toBeNull();
    const full = await join(c.visitId, groupId);
    expect(full.error?.code).toBe("23514");
    expect(full.error?.message).toBe("This group walk is full: 3 of 2 dogs.");
    const dogs = await admin.rpc("walk_dogs_on_visit", { _visit_id: a.visitId });
    expect(dogs.error).toBeNull();
    expect(dogs.data).toBe(1);
  });

  it("refuses a solo service, a mismatched visit and a canceled visit", async () => {
    const soloGroup = await admin.from("walk_groups").insert({
      organization_id: orgId,
      service_id: soloServiceId,
      scheduled_on: monday,
    });
    expect(soloGroup.error?.message).toBe(
      "Choose a group walk service. Set its group size in Settings > Services.",
    );
    const groupId = await makeGroup();
    const walk = await makeWalk();
    const tomorrow = new Date(nextMonday);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    for (const patch of [
      { scheduled_on: tomorrow.toISOString().slice(0, 10) },
      { scheduled_on: monday, service_id: soloServiceId },
      { service_id: groupServiceId, status: "canceled" },
    ]) {
      expect((await admin.from("visits").update(patch).eq("id", walk.visitId)).error).toBeNull();
      const refused = await join(walk.visitId, groupId);
      expect(refused.error?.code).toBe("23514");
      expect(refused.error?.message).toBe("That walk is on another day or for another service.");
    }
  });

  it("keeps group reads within the org and denies tech group writes and anonymous reads", async () => {
    const groupId = await makeGroup();
    const memberRead = await tech.from("walk_groups").select("id").eq("id", groupId).single();
    expect(memberRead.error).toBeNull();
    const write = await tech.from("walk_groups").insert({
      organization_id: orgId,
      service_id: groupServiceId,
      scheduled_on: monday,
    });
    expect(write.error?.code).toBe("42501");
    const anonymous = createClient(URL!, ANON!, { auth: { persistSession: false } });
    expect((await anonymous.from("walk_groups").select("id")).error?.code).toBe("42501");
    const foreignOrg = await ins("organizations", {
      name: `Other walks ${runId}`,
      service_lines: ["dog_walking"],
    });
    try {
      const foreignService = await ins("services", {
        organization_id: foreignOrg,
        name: "Other group",
        service_line: "dog_walking",
        default_duration_min: 30,
        max_dogs: 2,
      });
      const foreignGroup = await ins("walk_groups", {
        organization_id: foreignOrg,
        service_id: foreignService,
        scheduled_on: monday,
      });
      const hidden = await tech.from("walk_groups").select("id").eq("id", foreignGroup);
      expect(hidden.error).toBeNull();
      expect(hidden.data).toEqual([]);
      const wrongService = await admin.from("walk_groups").insert({
        organization_id: orgId,
        service_id: foreignService,
        scheduled_on: monday,
      });
      expect(wrongService.error?.code).toBe("23514");
      const foreignStaff = await ins("staff", {
        organization_id: foreignOrg,
        user_id: userIds[0],
        role: "tech",
        display_name: "Other business walker",
      });
      const wrongWalker = await admin
        .from("walk_groups")
        .update({ assigned_staff_id: foreignStaff })
        .eq("id", groupId);
      expect(wrongWalker.error?.message).toBe("Choose a walker from this business.");
      const walk = await makeWalk();
      expect((await join(walk.visitId, foreignGroup)).error?.message).toBe(
        "That walk is on another day or for another service.",
      );
    } finally {
      await admin.from("organizations").delete().eq("id", foreignOrg);
    }
  });

  it("deletes a group while retaining its visits as solo assignments", async () => {
    const groupId = await makeGroup();
    const walk = await makeWalk({ groupId, assignedStaffId: techStaffId });
    expect((await admin.from("walk_groups").delete().eq("id", groupId)).error).toBeNull();
    const remaining = await admin
      .from("visits")
      .select("walk_group_id, assigned_staff_id")
      .eq("id", walk.visitId)
      .single();
    expect(remaining.error).toBeNull();
    expect(remaining.data?.walk_group_id).toBeNull();
    expect(remaining.data?.assigned_staff_id).toBe(techStaffId);
  });

  it("serializes competing joins at capacity", async () => {
    const groupId = await makeGroup();
    const first = await makeWalk({ groupId });
    const a = await makeWalk();
    const b = await makeWalk();
    const results = await Promise.all([join(a.visitId, groupId), join(b.visitId, groupId)]);
    expect(results.filter((result) => !result.error)).toHaveLength(1);
    expect(results.find((result) => result.error)?.error?.message).toContain(
      "This group walk is full",
    );
    const members = await admin.from("visits").select("id").eq("walk_group_id", groupId);
    expect(members.error).toBeNull();
    expect(members.data).toHaveLength(2);
    expect(members.data!.map((visit) => visit.id)).toContain(first.visitId);
  });

  it("refuses an aggressive dog from another client in either join order", async () => {
    for (const aggressiveFirst of [false, true]) {
      const groupId = await makeGroup();
      const friendly = await makeWalk();
      const aggressive = await makeWalk({ temperament: "aggressive" });
      const first = aggressiveFirst ? aggressive : friendly;
      const second = aggressiveFirst ? friendly : aggressive;
      expect((await join(first.visitId, groupId)).error).toBeNull();
      const refused = await join(second.visitId, groupId);
      expect(refused.error?.code).toBe("23514");
      expect(refused.error?.message).toBe(
        "A dog marked aggressive walks alone. Book a solo walk instead.",
      );
    }
  });

  it("allows aggressive dogs within one client and ignores inactive aggressive dogs", async () => {
    const home = await household("aggressive");
    const groupId = await makeGroup();
    const a = await makeWalk({ home });
    const b = await makeWalk({ home });
    expect((await join(a.visitId, groupId)).error).toBeNull();
    expect((await join(b.visitId, groupId)).error).toBeNull();
    const inactiveHome = await household("aggressive");
    expect(
      (await admin.from("dogs").update({ active: false }).eq("id", inactiveHome.dogId)).error,
    ).toBeNull();
    const inactive = await makeWalk({ home: inactiveHome });
    const other = await makeWalk();
    const otherGroup = await makeGroup();
    expect((await join(inactive.visitId, otherGroup)).error).toBeNull();
    expect((await join(other.visitId, otherGroup)).error).toBeNull();
  });

  it("refuses group membership changes with a tech JWT, both joining and leaving", async () => {
    const groupId = await makeGroup();
    const walk = await makeWalk({ assignedStaffId: techStaffId });
    const read = await tech.from("visits").select("id").eq("id", walk.visitId).single();
    expect(read.error).toBeNull();
    const refused = await tech
      .from("visits")
      .update({ walk_group_id: groupId })
      .eq("id", walk.visitId)
      .select("id");
    expect(refused.error?.code).toBe("42501");
    expect(refused.error?.message).toContain("Not authorized to change the group");
    expect((await join(walk.visitId, groupId)).error).toBeNull();
    const leave = await tech
      .from("visits")
      .update({ walk_group_id: null })
      .eq("id", walk.visitId)
      .select("id");
    expect(leave.error?.code).toBe("42501");
    const unchanged = await admin
      .from("visits")
      .select("walk_group_id")
      .eq("id", walk.visitId)
      .single();
    expect(unchanged.data?.walk_group_id).toBe(groupId);
  });

  async function walkedGroup() {
    const groupId = await makeGroup();
    expect(
      (await admin.from("walk_groups").update({ assigned_staff_id: techStaffId }).eq("id", groupId))
        .error,
    ).toBeNull();
    const a = await makeWalk({ groupId });
    const b = await makeWalk({ groupId });
    return { groupId, a, b };
  }

  async function readVisit(visitId: string) {
    const { data, error } = await admin
      .from("visits")
      .select("scheduled_on, status, walk_group_id, assigned_staff_id")
      .eq("id", visitId)
      .single();
    expect(error).toBeNull();
    return data!;
  }

  const tuesday = (() => {
    const date = new Date(nextMonday);
    date.setUTCDate(date.getUTCDate() + 1);
    return date.toISOString().slice(0, 10);
  })();

  it("moves a group member to another day and takes it out of the group", async () => {
    const { groupId, a, b } = await walkedGroup();
    const moved = await admin.from("visits").update({ scheduled_on: tuesday }).eq("id", a.visitId);
    expect(moved.error).toBeNull();
    expect(await readVisit(a.visitId)).toEqual({
      scheduled_on: tuesday,
      status: "scheduled",
      walk_group_id: null,
      assigned_staff_id: techStaffId,
    });
    expect(await readVisit(b.visitId)).toEqual({
      scheduled_on: monday,
      status: "scheduled",
      walk_group_id: groupId,
      assigned_staff_id: techStaffId,
    });
  });

  it("moves several visits in one statement when one of them is in a group", async () => {
    const { groupId, a, b } = await walkedGroup();
    const solo = await makeWalk();
    const moved = await admin
      .from("visits")
      .update({ scheduled_on: tuesday })
      .in("id", [a.visitId, solo.visitId]);
    expect(moved.error).toBeNull();
    for (const visitId of [a.visitId, solo.visitId]) {
      const visit = await readVisit(visitId);
      expect(visit.scheduled_on).toBe(tuesday);
      expect(visit.walk_group_id).toBeNull();
    }
    expect((await readVisit(b.visitId)).walk_group_id).toBe(groupId);
  });

  it("still refuses a walk that is put into a group on another day", async () => {
    const groupId = await makeGroup();
    const walk = await makeWalk();
    const refused = await admin
      .from("visits")
      .update({ scheduled_on: tuesday, walk_group_id: groupId })
      .eq("id", walk.visitId);
    expect(refused.error?.code).toBe("23514");
    expect(refused.error?.message).toBe("That walk is on another day or for another service.");
  });

  it("frees a place in a full group when a dog is skipped, so another can join", async () => {
    const { groupId, a, b } = await walkedGroup();
    const waiting = await makeWalk();
    const full = await join(waiting.visitId, groupId);
    expect(full.error?.message).toBe("This group walk is full: 3 of 2 dogs.");
    expect(
      (await admin.from("visits").update({ status: "skipped" }).eq("id", a.visitId)).error,
    ).toBeNull();
    expect(await readVisit(a.visitId)).toMatchObject({
      status: "skipped",
      walk_group_id: null,
      assigned_staff_id: techStaffId,
    });
    expect((await join(waiting.visitId, groupId)).error).toBeNull();
    const members = await admin.from("visits").select("id").eq("walk_group_id", groupId);
    expect(members.error).toBeNull();
    expect(members.data!.map((visit) => visit.id).sort()).toEqual(
      [b.visitId, waiting.visitId].sort(),
    );
  });

  it("keeps a completed walk in its group without holding a place", async () => {
    const { groupId, a } = await walkedGroup();
    expect(
      (
        await admin
          .from("visits")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", a.visitId)
      ).error,
    ).toBeNull();
    expect((await readVisit(a.visitId)).walk_group_id).toBe(groupId);
    const another = await makeWalk();
    expect((await join(another.visitId, groupId)).error).toBeNull();
  });

  it("copies group walker changes onto scheduled members, including a cleared walker", async () => {
    const groupId = await makeGroup();
    const a = await makeWalk({ groupId });
    const b = await makeWalk({ groupId });
    for (const walkerId of [techStaffId, otherStaffId, null]) {
      const update = await admin
        .from("walk_groups")
        .update({ assigned_staff_id: walkerId })
        .eq("id", groupId);
      expect(update.error).toBeNull();
      const members = await admin
        .from("visits")
        .select("assigned_staff_id")
        .in("id", [a.visitId, b.visitId]);
      expect(members.error).toBeNull();
      expect(members.data).toHaveLength(2);
      expect(members.data!.every((visit) => visit.assigned_staff_id === walkerId)).toBe(true);
    }
    const otherGroup = await makeGroup();
    expect(
      (
        await admin
          .from("walk_groups")
          .update({ assigned_staff_id: techStaffId })
          .eq("id", otherGroup)
      ).error,
    ).toBeNull();
    const later = await makeWalk({ groupId: otherGroup, assignedStaffId: otherStaffId });
    const visit = await admin
      .from("visits")
      .select("assigned_staff_id")
      .eq("id", later.visitId)
      .single();
    expect(visit.data?.assigned_staff_id).toBe(techStaffId);
  });
});
