/** #555: the training office books a sold package's lessons, dispatcher
 *  included, through book_training_package_plan. The subscriptions write
 *  policy stays manage_pricing, so a dispatcher still cannot write a plan of
 *  its own.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { DB_ANON, DB_SERVICE, DB_URL, dbEnabled, insertRow } from "../support/walk-db";

const runId = Math.random().toString(36).slice(2, 10);
const password = "training-office-password-123!";
const today = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
/** A Wednesday at least a week out, so no business's days off can skip it. */
const START = (() => {
  let n = 7;
  while (weekdayOf(shift(n)) !== 3) n++;
  return n;
})();

let admin: SupabaseClient;
let anon: SupabaseClient;
const orgIds: string[] = [];
const userIds: string[] = [];
let orgId: string;
let serviceId: string;
let clientId: string;
let propertyId: string;
let otherPropertyId: string;
let packageId: string;
let dispatcher: SupabaseClient;
let tech: SupabaseClient;
let strangerDispatcher: SupabaseClient;

async function person(org: string, name: string, role: "dispatcher" | "tech") {
  const email = `${name}-${runId}@trainingoffice.local`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  const userId = data.user!.id;
  userIds.push(userId);
  await insertRow(admin, "user_roles", { user_id: userId, organization_id: org, role });
  const client = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(signedIn.error.message);
  return client;
}

const book = (who: SupabaseClient, patch: Record<string, unknown> = {}) => {
  return who.rpc("book_training_package_plan", {
    _client_package_id: packageId,
    _property_id: propertyId,
    _started_on: shift(START),
    _ends_on: shift(START + 14),
    _weekday: 3,
    _earliest_time: "10:00",
    _latest_time: "11:00",
    ...patch,
  });
};

describe.skipIf(!dbEnabled)("a dispatcher books a sold package", () => {
  beforeAll(async () => {
    admin = createClient(DB_URL!, DB_SERVICE!, { auth: { persistSession: false } });
    anon = createClient(DB_URL!, DB_ANON!, { auth: { persistSession: false } });
    orgId = await insertRow(admin, "organizations", {
      name: `Training office ${runId}`,
      service_lines: ["training"],
      timezone: "UTC",
    });
    orgIds.push(orgId);
    const otherOrg = await insertRow(admin, "organizations", {
      name: `Other office ${runId}`,
      service_lines: ["training"],
      timezone: "UTC",
    });
    orgIds.push(otherOrg);
    serviceId = await insertRow(admin, "services", {
      organization_id: orgId,
      name: `Private lesson ${runId}`,
      service_line: "training",
      price_unit: "visit",
      default_duration_min: 60,
      active: true,
    });
    clientId = await insertRow(admin, "clients", {
      organization_id: orgId,
      display_name: `Priya ${runId}`,
      account_type: "residential",
    });
    propertyId = await insertRow(admin, "properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Lesson St",
      city: "Austin",
      postal_code: "78701",
    });
    await insertRow(admin, "dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: "Biscuit",
      active: true,
    });
    const otherClient = await insertRow(admin, "clients", {
      organization_id: orgId,
      display_name: `Someone else ${runId}`,
      account_type: "residential",
    });
    otherPropertyId = await insertRow(admin, "properties", {
      organization_id: orgId,
      client_id: otherClient,
      street: "2 Lesson St",
      city: "Austin",
      postal_code: "78701",
    });
    const servicePackageId = await insertRow(admin, "service_packages", {
      organization_id: orgId,
      service_id: serviceId,
      name: `Private lessons 4-pack ${runId}`,
      sessions_count: 4,
      price_cents: 40000,
    });
    packageId = await insertRow(admin, "client_packages", {
      organization_id: orgId,
      client_id: clientId,
      service_package_id: servicePackageId,
      service_id: serviceId,
      name: "Private lessons 4-pack",
      sessions_count: 4,
      price_cents: 40000,
      purchased_on: today,
      expires_on: shift(START + 30),
    });
    dispatcher = await person(orgId, "dispatcher", "dispatcher");
    tech = await person(orgId, "tech", "tech");
    strangerDispatcher = await person(otherOrg, "stranger", "dispatcher");
  });

  afterAll(async () => {
    if (!admin) return;
    for (const id of orgIds) await admin.from("organizations").delete().eq("id", id);
    for (const uid of userIds) await admin.auth.admin.deleteUser(uid);
  });

  it("still cannot write a plan directly: the subscriptions policy is manage_pricing", async () => {
    const direct = await dispatcher.from("subscriptions").insert({
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      account_type: "residential",
      frequency: "weekly",
      price_cents: 999,
    });
    expect(direct.error).not.toBeNull();
  });

  it("refuses a tech, another business's dispatcher and anon, and writes nothing", async () => {
    for (const who of [tech, strangerDispatcher]) {
      const r = await book(who);
      expect(r.error?.message).toBe("Not authorized");
    }
    expect((await book(anon)).error).not.toBeNull();
    const plans = await admin.from("subscriptions").select("id").eq("client_package_id", packageId);
    expect(plans.data).toEqual([]);
  });

  it("refuses another client's address and a last lesson past expiry", async () => {
    const elsewhere = await book(dispatcher, { _property_id: otherPropertyId });
    expect(elsewhere.error?.message).toBe("Choose an address for this client.");
    const late = await book(dispatcher, { _ends_on: shift(START + 31) });
    expect(late.error?.message).toBe(`This package expired on ${shift(START + 30)}.`);
  });

  it("books for a dispatcher: one zero-price weekly plan on the package, with its lessons", async () => {
    const r = await book(dispatcher);
    expect(r.error).toBeNull();
    const plan = await admin
      .from("subscriptions")
      .select(
        "client_package_id, client_id, service_id, price_cents, billing_cadence, frequency, weekdays, dog_count, earliest_time, latest_time",
      )
      .eq("id", r.data as string)
      .single();
    expect(plan.error).toBeNull();
    expect(plan.data).toMatchObject({
      client_package_id: packageId,
      client_id: clientId,
      service_id: serviceId,
      price_cents: 0,
      billing_cadence: "postpaid",
      frequency: "weekly",
      weekdays: [3],
      dog_count: 1,
      earliest_time: "10:00:00",
      latest_time: "11:00:00",
    });
    const generated = await dispatcher.rpc("generate_visits_for_subscription", {
      _org_id: orgId,
      _subscription_id: r.data,
      _through: shift(START + 14),
    });
    expect(generated.error).toBeNull();
    expect(generated.data).toBe(3);
  });
});
