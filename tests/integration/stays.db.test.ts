/**
 * Pet sitting in a real database (#411): pets that are not dogs, care
 * instructions, and stays (migrations 20261024080000 and 20261024080100).
 *
 *   * a drop-in stay Mon..Fri with two windows generates ten visits, and an
 *     overnight Mon -> Sat five, through the existing generator, even across
 *     the client's own vacation hold;
 *   * a stay visit takes the stay's sitter;
 *   * a sitter cannot have two overnights on one night;
 *   * canceling a stay cancels its future visits and ends its plans;
 *   * another business cannot read a stay or a pet's care; a tech with a
 *     visit at the home can read the care;
 *   * a pet's species is checked.
 *
 * Local stack only. CI builds the database from migrations before running
 * this suite. Skipped without TEST_SUPABASE_* env.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DB_ANON, DB_SERVICE, DB_URL, dbEnabled, insertRow } from "../support/walk-db";

const password = "stay-test-password-123!";
const runId = Math.random().toString(36).slice(2, 10);

// Next week's Monday, in UTC (the org's timezone below), so every day of a
// stay is in the future and the generator lays all of it.
const nextMonday = new Date();
nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
while (nextMonday.getUTCDay() !== 1) nextMonday.setUTCDate(nextMonday.getUTCDate() + 1);
const day = (offset: number) => {
  const d = new Date(nextMonday);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const MON = day(0);
const FRI = day(4);
const SAT = day(5);
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

let admin: SupabaseClient;
let orgId: string;
let otherOrgId: string;
let dropInServiceId: string;
let overnightServiceId: string;
let sitter: { userId: string; staffId: string; client: SupabaseClient };
let otherSitter: { userId: string; staffId: string; client: SupabaseClient };
let outsider: SupabaseClient;
const userIds: string[] = [];
let serial = 0;

async function signIn(email: string) {
  const c = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const r = await c.auth.signInWithPassword({ email, password });
  if (r.error) throw new Error(r.error.message);
  return c;
}

async function person(org: string, name: string, role: "owner" | "tech") {
  const email = `${name}-${runId}@staytest.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const userId = data.user!.id;
  userIds.push(userId);
  await insertRow(admin, "user_roles", { user_id: userId, organization_id: org, role });
  // A staff row for a sitter, as tests/support/walk-db.ts makes one for a walker.
  const staffId =
    role === "tech"
      ? await insertRow(admin, "staff", {
          organization_id: org,
          user_id: userId,
          role: "tech",
          display_name: `Sitter ${name}`,
        })
      : "";
  return { userId, staffId, client: await signIn(email) };
}

async function household() {
  serial += 1;
  const clientId = await insertRow(admin, "clients", {
    organization_id: orgId,
    display_name: `Stay client ${serial}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(admin, "properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${serial} Stay St`,
    city: "Austin",
    postal_code: "78701",
  });
  const dogId = await insertRow(admin, "dogs", {
    organization_id: orgId,
    property_id: propertyId,
    name: `Biscuit ${serial}`,
    active: true,
  });
  const catId = await insertRow(admin, "dogs", {
    organization_id: orgId,
    property_id: propertyId,
    name: `Miso ${serial}`,
    species: "cat",
    active: true,
  });
  return { clientId, propertyId, dogId, catId };
}

/** A confirmed stay and its plans, the rows createStay writes. */
async function bookStay(
  home: Awaited<ReturnType<typeof household>>,
  opts: {
    kind: "drop_in" | "overnight";
    startsOn: string;
    endsOn: string;
    sitterId?: string | null;
    windows?: Array<[string, string]>;
  },
) {
  const overnight = opts.kind === "overnight";
  const serviceId = overnight ? overnightServiceId : dropInServiceId;
  const windows = overnight ? [["19:00", "21:00"]] : (opts.windows ?? [["08:00", "10:00"]]);
  const stayId = await insertRow(admin, "stays", {
    organization_id: orgId,
    client_id: home.clientId,
    property_id: home.propertyId,
    service_id: serviceId,
    starts_on: opts.startsOn,
    ends_on: opts.endsOn,
    drop_in_windows: overnight ? null : windows.map(([earliest, latest]) => ({ earliest, latest })),
    pet_ids: [home.dogId, home.catId],
    assigned_staff_id: opts.sitterId ?? null,
  });
  const lastDay = overnight
    ? new Date(new Date(`${opts.endsOn}T00:00:00Z`).getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10)
    : opts.endsOn;
  const planIds: string[] = [];
  for (const [earliest, latest] of windows)
    planIds.push(
      await insertRow(admin, "subscriptions", {
        organization_id: orgId,
        client_id: home.clientId,
        property_id: home.propertyId,
        account_type: "residential",
        dog_count: 2,
        frequency: "weekly",
        weekdays: EVERY_DAY,
        price_cents: overnight ? 6000 : 2500,
        service_id: serviceId,
        status: "active",
        started_on: opts.startsOn,
        ends_on: lastDay,
        earliest_time: earliest,
        latest_time: latest,
        stay_id: stayId,
      }),
    );
  const generated = await admin.rpc("generate_visits_core", {
    _org_id: orgId,
    _through: day(20),
    _subscription_id: null,
  });
  if (generated.error) throw new Error(generated.error.message);
  return { stayId, planIds };
}

async function visitsOf(planIds: string[]) {
  const { data, error } = await admin
    .from("visits")
    .select("id, scheduled_on, status, assigned_staff_id, subscription_id")
    .in("subscription_id", planIds)
    .order("scheduled_on");
  if (error) throw new Error(error.message);
  return data ?? [];
}

describe.skipIf(!dbEnabled)("pet sitting in the database", () => {
  beforeAll(async () => {
    admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
    orgId = await insertRow(admin, "organizations", {
      name: `Stays ${runId}`,
      service_lines: ["pet_sitting"],
      timezone: "UTC",
    });
    otherOrgId = await insertRow(admin, "organizations", {
      name: `Other stays ${runId}`,
      service_lines: ["pet_sitting"],
      timezone: "UTC",
    });
    dropInServiceId = await insertRow(admin, "services", {
      organization_id: orgId,
      name: `Test drop-in ${runId}`,
      service_line: "pet_sitting",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 30,
    });
    overnightServiceId = await insertRow(admin, "services", {
      organization_id: orgId,
      name: `Test overnight ${runId}`,
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: 6000,
    });
    sitter = await person(orgId, "sitter", "tech");
    otherSitter = await person(orgId, "other", "tech");
    outsider = (await person(otherOrgId, "outsider", "owner")).client;
  });

  afterAll(async () => {
    if (!admin) return;
    await admin.from("organizations").delete().in("id", [orgId, otherOrgId]);
    for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
  });

  it("checks a pet's species, and a dog is the default", async () => {
    const home = await household();
    const { data } = await admin.from("dogs").select("species").eq("id", home.dogId).single();
    expect(data?.species).toBe("dog");
    const bad = await admin.from("dogs").insert({
      organization_id: orgId,
      property_id: home.propertyId,
      name: "Nemo",
      species: "fish",
    });
    expect(bad.error).not.toBeNull();
    const ok = await admin.from("dogs").insert({
      organization_id: orgId,
      property_id: home.propertyId,
      name: "Thumper",
      species: "other",
      species_note: "rabbit",
    });
    expect(ok.error).toBeNull();
  });

  it("drop-ins Mon..Fri with two windows are ten visits, all with the sitter, through a client hold", async () => {
    const home = await household();
    // The client paused their scooping for the same trip; the sitter still goes.
    await insertRow(admin, "client_holds", {
      organization_id: orgId,
      client_id: home.clientId,
      starts_on: MON,
      ends_on: FRI,
    });
    const { stayId, planIds } = await bookStay(home, {
      kind: "drop_in",
      startsOn: MON,
      endsOn: FRI,
      sitterId: sitter.staffId,
      windows: [
        ["08:00", "10:00"],
        ["17:00", "19:00"],
      ],
    });
    const visits = await visitsOf(planIds);
    expect(visits).toHaveLength(10);
    expect(new Set(visits.map((v) => v.scheduled_on)).size).toBe(5);
    expect(visits.every((v) => v.assigned_staff_id === sitter.staffId)).toBe(true);
    const { data: stay } = await admin.from("stays").select("kind").eq("id", stayId).single();
    expect(stay?.kind).toBe("drop_in");
  });

  it("an overnight Mon -> Sat is five nights, and kind follows the service", async () => {
    const home = await household();
    const { stayId, planIds } = await bookStay(home, {
      kind: "overnight",
      startsOn: MON,
      endsOn: SAT,
    });
    const visits = await visitsOf(planIds);
    expect(visits.map((v) => v.scheduled_on)).toEqual([MON, day(1), day(2), day(3), FRI]);
    const { data: stay } = await admin
      .from("stays")
      .select("kind, overnight_arrival_earliest, overnight_arrival_latest")
      .eq("id", stayId)
      .single();
    expect(stay?.kind).toBe("overnight");
    expect(String(stay?.overnight_arrival_earliest)).toMatch(/^19:00/);
    expect(String(stay?.overnight_arrival_latest)).toMatch(/^21:00/);
  });

  it("refuses a stay on a service that is not pet sitting, and an overnight with no night", async () => {
    const home = await household();
    const walk = await insertRow(admin, "services", {
      organization_id: orgId,
      name: `Walk ${runId}`,
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2000,
      default_duration_min: 30,
    });
    const wrong = await admin.from("stays").insert({
      organization_id: orgId,
      client_id: home.clientId,
      property_id: home.propertyId,
      service_id: walk,
      starts_on: MON,
      ends_on: FRI,
      drop_in_windows: [{ earliest: "08:00", latest: "10:00" }],
    });
    expect(wrong.error?.message).toMatch(/pet sitting service/);
    const noNight = await admin.from("stays").insert({
      organization_id: orgId,
      client_id: home.clientId,
      property_id: home.propertyId,
      service_id: overnightServiceId,
      starts_on: MON,
      ends_on: MON,
    });
    expect(noNight.error).not.toBeNull();
  });

  it("a sitter cannot have two overnights on the same night", async () => {
    const first = await household();
    const { planIds } = await bookStay(first, {
      kind: "overnight",
      startsOn: day(7),
      endsOn: day(10),
      sitterId: otherSitter.staffId,
    });
    expect(
      (await visitsOf(planIds)).every((v) => v.assigned_staff_id === otherSitter.staffId),
    ).toBe(true);

    // A second overnight overlapping two of those nights, booked unassigned,
    // then given the same sitter: refused, naming the night.
    const second = await household();
    const { stayId } = await bookStay(second, {
      kind: "overnight",
      startsOn: day(9),
      endsOn: day(12),
    });
    const clash = await admin
      .from("stays")
      .update({ assigned_staff_id: otherSitter.staffId })
      .eq("id", stayId);
    expect(clash.error?.message).toMatch(/already has an overnight stay on the night of/);
    const { data: still } = await admin
      .from("stays")
      .select("assigned_staff_id")
      .eq("id", stayId)
      .single();
    expect(still?.assigned_staff_id).toBeNull();

    // A drop-in the same day is no clash.
    const third = await household();
    const dropIn = await bookStay(third, {
      kind: "drop_in",
      startsOn: day(9),
      endsOn: day(9),
      sitterId: otherSitter.staffId,
    });
    expect((await visitsOf(dropIn.planIds))[0]?.assigned_staff_id).toBe(otherSitter.staffId);
  });

  it("canceling a stay cancels its future visits and ends its plans", async () => {
    const home = await household();
    const { stayId, planIds } = await bookStay(home, {
      kind: "drop_in",
      startsOn: MON,
      endsOn: day(2),
    });
    expect(await visitsOf(planIds)).toHaveLength(3);
    const { error } = await admin.from("stays").update({ status: "canceled" }).eq("id", stayId);
    expect(error).toBeNull();
    const visits = await visitsOf(planIds);
    expect(visits.every((v) => v.status === "canceled")).toBe(true);
    const { data: plans } = await admin.from("subscriptions").select("status").in("id", planIds);
    expect((plans ?? []).every((p) => p.status === "canceled")).toBe(true);
    const reopen = await admin.from("stays").update({ status: "confirmed" }).eq("id", stayId);
    expect(reopen.error?.message).toMatch(/cannot be reopened/);
  });

  it("another business reads no stay and no care; a tech at the home reads the care", async () => {
    const home = await household();
    const { stayId, planIds } = await bookStay(home, {
      kind: "drop_in",
      startsOn: day(14),
      endsOn: day(14),
      sitterId: sitter.staffId,
    });
    expect(await visitsOf(planIds)).toHaveLength(1);
    const care = await admin.from("pet_care_instructions").insert({
      pet_id: home.catId,
      organization_id: orgId,
      feeding: "Half a cup at 7",
      meds: [{ name: "Thyroid pill", dose: "1", times: ["08:00"], notes: null }],
    });
    expect(care.error).toBeNull();

    const theirStay = await outsider.from("stays").select("id").eq("id", stayId);
    expect(theirStay.error).toBeNull();
    expect(theirStay.data).toEqual([]);
    const theirCare = await outsider
      .from("pet_care_instructions")
      .select("pet_id")
      .eq("pet_id", home.catId);
    expect(theirCare.data).toEqual([]);

    const mine = await sitter.client
      .from("pet_care_instructions")
      .select("feeding, meds")
      .eq("pet_id", home.catId)
      .single();
    expect(mine.error).toBeNull();
    expect(mine.data?.feeding).toBe("Half a cup at 7");

    // A tech writes no care: that is the office's.
    const write = await sitter.client
      .from("pet_care_instructions")
      .update({ feeding: "Nothing" })
      .eq("pet_id", home.catId)
      .select("pet_id");
    expect(write.data ?? []).toEqual([]);
  });

  it("refuses a medication list of the wrong shape", async () => {
    const home = await household();
    const bad = await admin.from("pet_care_instructions").insert({
      pet_id: home.dogId,
      organization_id: orgId,
      meds: [{ name: "Pill", times: ["8am"] }],
    });
    expect(bad.error).not.toBeNull();
    const elsewhere = await admin.from("pet_care_instructions").insert({
      pet_id: home.dogId,
      organization_id: otherOrgId,
      meds: [],
    });
    expect(elsewhere.error?.message).toMatch(/another business/);
  });
});
