// Two grooms for the same groomer cannot overlap, in a real database
// (zz_visits_groom_no_overlap, 20261023122400). The server's check in
// groom-clash.server.ts reads and then writes, so two saves at once, a direct
// write and Cover's redistribution all went around it. The trigger refuses
// with 23P01 whoever writes, and redistribute_staff_work leaves a groom that
// fits nobody with the tech it was on instead of failing the time-off.
// Skipped unless TEST_SUPABASE_* point at a local stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
const CLASH = /^This groomer already has a groom at that time on \d{4}-\d{2}-\d{2}\.$/;
let admin: SupabaseClient;
let owner: SupabaseClient;
let orgId: string;
let clientId: string;
let propertyId: string;
let groomServiceId: string;
let scoopServiceId: string;
let g1: string;
let g2: string;
let g3: string;
const users: string[] = [];

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

function day(offset: number) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function makeUser(label: string) {
  const email = `groom-overlap-${label}-${runId}@test.local`;
  const password = "groom-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user!.id);
  return { id: data.user!.id, email, password };
}

async function groomer(name: string) {
  const u = await makeUser(name.toLowerCase().replace(/\W+/g, "-"));
  await insert("user_roles", { organization_id: orgId, user_id: u.id, role: "tech" });
  return insert("staff", {
    organization_id: orgId,
    user_id: u.id,
    role: "tech",
    display_name: name,
  });
}

/** A visit row for `staffId` on `on`, with its own plan so two on one day
 *  do not meet the (subscription_id, scheduled_on) unique key. */
function visitRow(
  staffId: string | null,
  on: string,
  startTime: string | null,
  minutes: number | null,
  serviceId = groomServiceId,
) {
  return insert("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    frequency: "one_time",
    price_cents: 8000,
    service_id: serviceId,
    dog_count: 1,
    started_on: on,
    ends_on: on,
  }).then((subId) => ({
    organization_id: orgId,
    subscription_id: subId,
    client_id: clientId,
    property_id: propertyId,
    service_id: serviceId,
    scheduled_on: on,
    assigned_staff_id: staffId,
    start_time: startTime,
    duration_min: minutes,
  }));
}

/** Inserted by the owner, through REST, as any office write would be. */
async function ownerInsert(row: Record<string, unknown>) {
  return owner.from("visits").insert(row).select("id").single();
}

async function groom(staffId: string | null, on: string, startTime: string, minutes: number) {
  const { data, error } = await ownerInsert(await visitRow(staffId, on, startTime, minutes));
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function placement(visitId: string) {
  const { data, error } = await admin
    .from("visits")
    .select("assigned_staff_id, scheduled_on, start_time")
    .eq("id", visitId)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

async function groomsHeld(staffId: string, on: string) {
  const { data, error } = await admin
    .from("visits")
    .select("id, start_time, duration_min")
    .eq("assigned_staff_id", staffId)
    .eq("scheduled_on", on)
    .eq("service_id", groomServiceId)
    .in("status", ["scheduled", "in_progress", "completed"])
    .order("start_time");
  if (error) throw new Error(error.message);
  return data ?? [];
}

describe.skipIf(!enabled)("two grooms cannot share a groomer", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Groom overlap ${runId}`,
      service_lines: ["mobile_grooming", "pet_waste"],
    });
    const o = await makeUser("owner");
    await insert("user_roles", { organization_id: orgId, user_id: o.id, role: "owner" });
    await insert("staff", {
      organization_id: orgId,
      user_id: o.id,
      role: "owner",
      display_name: "Owner",
      // The owner does not run routes, so Cover never offers them work.
      is_field_tech: false,
      is_field_tech_overridden: true,
    });
    owner = createClient(URL!, ANON!, { auth: { persistSession: false } });
    const signed = await owner.auth.signInWithPassword({ email: o.email, password: o.password });
    if (signed.error) throw new Error(signed.error.message);

    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Groom overlap client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "2 Groom St",
      city: "Austin",
      postal_code: "78701",
    });
    groomServiceId = await insert("services", {
      organization_id: orgId,
      name: `Groom ${runId}`,
      service_line: "mobile_grooming",
      price_unit: "visit",
      default_duration_min: 90,
      base_price_cents: 8000,
    });
    scoopServiceId = await insert("services", {
      organization_id: orgId,
      name: `Scoop ${runId}`,
      service_line: "pet_waste",
      price_unit: "visit",
      default_duration_min: 15,
      base_price_cents: 2000,
    });
    g1 = await groomer("Groomer One");
    g2 = await groomer("Groomer Two");
    g3 = await groomer("Groomer Three");
  });

  it("refuses a REST insert of a groom that overlaps the same groomer's groom", async () => {
    const on = day(10);
    await groom(g1, on, "09:00", 120);
    const { data, error } = await ownerInsert(await visitRow(g1, on, "10:30", 60));
    expect(data).toBeNull();
    expect(error?.code).toBe("23P01");
    expect(error?.message).toMatch(CLASH);
    expect(await groomsHeld(g1, on)).toHaveLength(1);
  });

  it("lets a groom in that starts when the other ends, or goes to another groomer", async () => {
    const on = day(11);
    await groom(g1, on, "09:00", 120);
    // Half-open, as groomClashes: 11:00 is when the first one is done.
    await groom(g1, on, "11:00", 60);
    await groom(g2, on, "09:00", 120);
    await groom(null, on, "09:30", 60);
    // A route stop has no start time and is never a groom.
    const stop = await ownerInsert(await visitRow(g1, on, null, null, scoopServiceId));
    expect(stop.error).toBeNull();
    expect((await groomsHeld(g1, on)).map((v) => v.start_time)).toEqual(["09:00:00", "11:00:00"]);
    expect(await groomsHeld(g2, on)).toHaveLength(1);
  });

  it("does not count a canceled groom as holding the time", async () => {
    const on = day(12);
    const gone = await groom(g1, on, "09:00", 120);
    await admin.from("visits").update({ status: "canceled" }).eq("id", gone);
    await groom(g1, on, "09:00", 120);
    // And bringing the canceled one back would put two on one van.
    const back = await admin.from("visits").update({ status: "scheduled" }).eq("id", gone);
    expect(back.error?.code).toBe("23P01");
    expect((await admin.from("visits").select("status").eq("id", gone).single()).data!.status).toBe(
      "canceled",
    );
  });

  it("refuses moving a groom onto a clash by day, by groomer or by start time", async () => {
    const on = day(13);
    const next = day(14);
    await groom(g1, on, "09:00", 120);
    const other = await groom(g2, on, "10:00", 60);
    const later = await groom(g1, next, "10:00", 60);
    const sameDayLater = await groom(g1, on, "13:00", 60);

    // Reassigned through the RPC the board's drag calls.
    const reassign = await owner.rpc("reassign_visit", { _visit_id: other, _staff_id: g1 });
    expect(reassign.error?.code).toBe("23P01");
    expect(reassign.error?.message).toMatch(CLASH);
    expect(await placement(other)).toMatchObject({ assigned_staff_id: g2, scheduled_on: on });

    // Moved to another day by a direct update.
    const moved = await owner.from("visits").update({ scheduled_on: on }).eq("id", later);
    expect(moved.error?.code).toBe("23P01");
    expect(await placement(later)).toMatchObject({ assigned_staff_id: g1, scheduled_on: next });

    // Its start time moved into the other groom.
    const retimed = await owner.from("visits").update({ start_time: "10:30" }).eq("id", sameDayLater);
    expect(retimed.error?.code).toBe("23P01");
    expect(await placement(sameDayLater)).toMatchObject({ start_time: "13:00:00" });

    // A move that fits still goes through.
    const fits = await owner.rpc("reassign_visit", { _visit_id: later, _staff_id: g2 });
    expect(fits.error).toBeNull();
    expect(await placement(later)).toMatchObject({ assigned_staff_id: g2, scheduled_on: next });
  });

  it("lets only one of two overlapping saves at once through", async () => {
    const on = day(15);
    const [a, b] = await Promise.all([visitRow(g2, on, "09:00", 120), visitRow(g2, on, "10:00", 120)]);
    const results = await Promise.all([ownerInsert(a), ownerInsert(b)]);
    expect(results.filter((r) => r.error === null)).toHaveLength(1);
    expect(results.filter((r) => r.error?.code === "23P01")).toHaveLength(1);
    expect(await groomsHeld(g2, on)).toHaveLength(1);
  });

  it("marking a groomer out moves their work without double-booking a groom, and the time off saves", async () => {
    const busyDay = day(20);
    const freeDay = day(21);
    // Groomer Three is going to be out on both days.
    const stuck = await groom(g3, busyDay, "09:00", 120);
    const stop = (await ownerInsert(await visitRow(g3, busyDay, null, null, scoopServiceId))).data!
      .id as string;
    const movable = await groom(g3, freeDay, "13:00", 60);
    // On the first day both other groomers have a groom over 09:00.
    await groom(g1, busyDay, "09:30", 60);
    await groom(g2, busyDay, "08:00", 120);
    // On the second, Groomer One is busy at 13:00 and Groomer Two is free.
    await groom(g1, freeDay, "12:30", 60);

    // The time-off path: the leave is recorded (addTimeOff), then Cover
    // hands the work on (redistributeStaffWork).
    const leave = await owner
      .from("staff_time_off")
      .insert({ organization_id: orgId, staff_id: g3, starts_on: busyDay, ends_on: freeDay })
      .select("id")
      .single();
    expect(leave.error).toBeNull();
    const cover = await owner.rpc("redistribute_staff_work", { _staff_id: g3, _from: busyDay });
    expect(cover.error).toBeNull();
    expect(cover.data).toBe(2);

    // The leave is there.
    const saved = await admin.from("staff_time_off").select("staff_id").eq("id", leave.data!.id);
    expect(saved.data).toEqual([{ staff_id: g3 }]);
    // The groom nobody had room for stayed where it was, for the office.
    expect(await placement(stuck)).toMatchObject({ assigned_staff_id: g3, scheduled_on: busyDay });
    // The route stop and the groom that fit somewhere moved.
    expect([g1, g2]).toContain((await placement(stop)).assigned_staff_id);
    expect(await placement(movable)).toMatchObject({ assigned_staff_id: g2, scheduled_on: freeDay });
    // Nobody holds two grooms at once.
    expect((await groomsHeld(g1, busyDay)).map((v) => v.start_time)).toEqual(["09:30:00"]);
    expect((await groomsHeld(g2, busyDay)).map((v) => v.start_time)).toEqual(["08:00:00"]);
    expect((await groomsHeld(g1, freeDay)).map((v) => v.start_time)).toEqual(["12:30:00"]);
    expect((await groomsHeld(g2, freeDay)).map((v) => v.start_time)).toEqual(["13:00:00"]);
  });

  afterAll(async () => {
    if (!admin || !orgId) return;
    await admin.from("staff_time_off").delete().eq("organization_id", orgId);
    await admin.from("visits").delete().eq("organization_id", orgId);
    await admin.from("subscriptions").delete().eq("organization_id", orgId);
    await admin.from("organizations").delete().eq("id", orgId);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });
});
