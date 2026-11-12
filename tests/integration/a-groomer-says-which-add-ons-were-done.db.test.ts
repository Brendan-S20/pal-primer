// A groomer says which booked add-ons were done (#412), in a real database.
// set_groom_addon_done (20261109130000) writes visits.groom_addons_not_done,
// and visits_groom_plan_addons charges only the rest at completion. Skipped
// unless TEST_SUPABASE_* point at a local stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
let admin: SupabaseClient;
let groomer: SupabaseClient;
let otherTech: SupabaseClient;
let orgId: string;
let groomerStaffId: string;
let propertyId: string;
let clientId: string;
let serviceId: string;
let teethId: string;
let deshedId: string;
let flyId: string;
const users: string[] = [];

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

async function signedInTech(label: string) {
  const email = `groom-addons-${label}-${runId}@test.local`;
  const password = "groom-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(error.message);
  users.push(data.user!.id);
  await insert("user_roles", { organization_id: orgId, user_id: data.user!.id, role: "tech" });
  const staffId = await insert("staff", {
    organization_id: orgId,
    user_id: data.user!.id,
    role: "tech",
    display_name: `Groomer ${label}`,
  });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(signed.error.message);
  return { client, staffId };
}

let slot = 0;

/** A one-groom plan with teeth brushing and a de-shed, and its visit. Each
 *  one starts two hours after the last: the database refuses two grooms at
 *  once for one groomer (zz_visits_groom_no_overlap). */
async function groom() {
  const start = `${String(6 + 2 * slot++).padStart(2, "0")}:00`;
  const day = new Date().toISOString().slice(0, 10);
  const subId = await insert("subscriptions", {
    organization_id: orgId,
    client_id: clientId,
    property_id: propertyId,
    account_type: "residential",
    frequency: "one_time",
    price_cents: 8000,
    service_id: serviceId,
    dog_count: 1,
    started_on: day,
    ends_on: day,
    groom_start_time: start,
    groom_duration_min: 120,
    groom_summary: "Full groom + Teeth brushing, De-shed",
    groom_addons: [
      { addon_service_id: teethId, quantity: 1, unit_price_cents: 1500, name: "Teeth brushing" },
      { addon_service_id: deshedId, quantity: 1, unit_price_cents: 2000, name: "De-shed" },
    ],
  });
  return insert("visits", {
    organization_id: orgId,
    subscription_id: subId,
    client_id: clientId,
    property_id: propertyId,
    scheduled_on: day,
    assigned_staff_id: groomerStaffId,
  });
}

async function complete(visitId: string) {
  const { error } = await admin
    .from("visits")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", visitId);
  if (error) throw new Error(error.message);
}

async function charged(visitId: string) {
  const { data, error } = await admin
    .from("addon_charges")
    .select("description, amount_cents, status")
    .eq("visit_id", visitId)
    .neq("status", "voided")
    .order("description");
  if (error) throw new Error(error.message);
  return data ?? [];
}

describe.skipIf(!enabled)("a groomer says which add-ons were done", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Groom add-ons ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    const g = await signedInTech("assigned");
    groomer = g.client;
    groomerStaffId = g.staffId;
    otherTech = (await signedInTech("other")).client;
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Groom client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Groom St",
      city: "Austin",
      postal_code: "78701",
    });
    serviceId = await insert("services", {
      organization_id: orgId,
      name: `Groom ${runId}`,
      service_line: "mobile_grooming",
      price_unit: "visit",
      default_duration_min: 90,
      base_price_cents: 8000,
    });
    const addon = (code: string, name: string, cents: number) =>
      insert("addon_services", {
        organization_id: orgId,
        code,
        name,
        unit_price_cents: cents,
        duration_min: 10,
        service_line: "mobile_grooming",
      });
    teethId = await addon("TEETH", "Teeth brushing", 1500);
    deshedId = await addon("DESHED", "De-shed", 2000);
    flyId = await addon("FLEA", "Flea bath", 2500);
  });

  it("the groomer marks one not done, and completion bills only the other", async () => {
    const visitId = await groom();
    const r = await groomer.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: teethId,
      _done: false,
    });
    expect(r.error).toBeNull();
    expect(r.data).toEqual([teethId]);
    await complete(visitId);
    expect(await charged(visitId)).toEqual([
      { description: "De-shed", amount_cents: 2000, status: "pending" },
    ]);
  });

  it("marking it done again puts it back on the bill", async () => {
    const visitId = await groom();
    await groomer.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: deshedId,
      _done: false,
    });
    const back = await groomer.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: deshedId,
      _done: true,
    });
    expect(back.error).toBeNull();
    expect(back.data).toEqual([]);
    await complete(visitId);
    expect((await charged(visitId)).map((c) => c.description)).toEqual([
      "De-shed",
      "Teeth brushing",
    ]);
  });

  it("another tech cannot mark this groom", async () => {
    const visitId = await groom();
    const r = await otherTech.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: teethId,
      _done: false,
    });
    expect(r.error?.message).toMatch(/Not authorized for this visit/);
    const v = await admin.from("visits").select("groom_addons_not_done").eq("id", visitId).single();
    expect(v.data?.groom_addons_not_done).toEqual([]);
  });

  it("an add-on that is not on this groom is refused", async () => {
    const visitId = await groom();
    const r = await groomer.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: flyId,
      _done: false,
    });
    expect(r.error?.message).toMatch(/not on this groom/);
  });

  it("a finished groom is the office's to correct, not the groomer's", async () => {
    const visitId = await groom();
    await complete(visitId);
    const r = await groomer.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: teethId,
      _done: false,
    });
    expect(r.error?.message).toMatch(/This groom is finished/);
    expect((await charged(visitId)).length).toBe(2);
  });

  it("is not callable signed out", async () => {
    const visitId = await groom();
    const anon = createClient(URL!, ANON!, { auth: { persistSession: false } });
    const r = await anon.rpc("set_groom_addon_done", {
      _visit_id: visitId,
      _addon_service_id: teethId,
      _done: false,
    });
    expect(r.error).not.toBeNull();
  });

  afterAll(async () => {
    if (!admin || !orgId) return;
    await admin.from("addon_charges").delete().eq("organization_id", orgId);
    await admin.from("credit_ledger").delete().eq("organization_id", orgId);
    await admin.from("visits").delete().eq("organization_id", orgId);
    await admin.from("subscriptions").delete().eq("organization_id", orgId);
    await admin.from("organizations").delete().eq("id", orgId);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });
});
