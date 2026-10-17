// A groom marked missed after it was done stops billing its add-ons, in a
// real database. The add-on is charged when the groom is completed
// (visits_groom_plan_addons); office_mark_visit_missed, run by the owner,
// voids that charge (visits_groom_plan_addons_void, 20261017110000), hands a
// prepaid client's credit back, and refuses while the add-on is on an
// invoice. Skipped unless TEST_SUPABASE_* point at a local stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && ANON && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
let admin: SupabaseClient;
let owner: SupabaseClient;
let orgId: string;
let propertyId: string;
let serviceId: string;
let addonId: string;
const users: string[] = [];

async function insert(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`${table}: ${error.message}`);
  return data.id;
}

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function signedInOwner() {
  const email = `groom-missed-${runId}@test.local`;
  const password = "groom-test-password-123!";
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) throw new Error(error.message);
  users.push(data.user!.id);
  await insert("user_roles", { organization_id: orgId, user_id: data.user!.id, role: "owner" });
  await insert("staff", {
    organization_id: orgId,
    user_id: data.user!.id,
    role: "owner",
    display_name: "Owner",
  });
  const client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  if (signed.error) throw new Error(signed.error.message);
  return client;
}

/** A client on a one-groom plan with teeth brushing, and its visit. */
async function groomFor(label: string) {
  const clientId = await insert("clients", {
    organization_id: orgId,
    display_name: `Groom client ${label}`,
    account_type: "residential",
    active: true,
  });
  const day = addDays(new Date().toISOString().slice(0, 10), -1);
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
    groom_start_time: "09:00",
    groom_duration_min: 120,
    groom_summary: "Full groom + Teeth brushing",
    groom_addons: [
      { addon_service_id: addonId, quantity: 1, unit_price_cents: 1500, name: "Teeth brushing" },
    ],
  });
  const visitId = await insert("visits", {
    organization_id: orgId,
    subscription_id: subId,
    client_id: clientId,
    property_id: propertyId,
    scheduled_on: day,
  });
  return { clientId, visitId };
}

async function complete(visitId: string) {
  const { error } = await admin
    .from("visits")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", visitId);
  if (error) throw new Error(error.message);
}

async function charges(visitId: string) {
  const { data, error } = await admin
    .from("addon_charges")
    .select("id, status, amount_cents, note")
    .eq("visit_id", visitId)
    .order("created_at");
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** What the client would be billed for this add-on: every charge not voided. */
async function owedForAddons(clientId: string) {
  const { data } = await admin
    .from("addon_charges")
    .select("amount_cents")
    .eq("client_id", clientId)
    .neq("status", "voided");
  return (data ?? []).reduce((s, r) => s + (r.amount_cents as number), 0);
}

describe.skipIf(!enabled)("a groom marked missed after it was done", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Groom missed ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    owner = await signedInOwner();
    const holder = await insert("clients", {
      organization_id: orgId,
      display_name: "Address holder",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: holder,
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
    addonId = await insert("addon_services", {
      organization_id: orgId,
      code: "TEETH",
      name: "Teeth brushing",
      unit_price_cents: 1500,
      duration_min: 10,
      service_line: "mobile_grooming",
    });
  });

  it("voids the add-on its completion charged, and the client owes nothing for it", async () => {
    const { clientId, visitId } = await groomFor("postpaid");
    await complete(visitId);
    expect(await charges(visitId)).toEqual([
      expect.objectContaining({ status: "pending", amount_cents: 1500, note: "Booked with the groom" }),
    ]);
    expect(await owedForAddons(clientId)).toBe(1500);

    const missed = await owner.rpc("office_mark_visit_missed", { _visit_id: visitId });
    expect(missed.error).toBeNull();

    const { data: v } = await admin.from("visits").select("status").eq("id", visitId).single();
    expect(v!.status).toBe("missed");
    expect(await charges(visitId)).toEqual([expect.objectContaining({ status: "voided" })]);
    expect(await owedForAddons(clientId)).toBe(0);
  });

  it("hands a prepaid client's credit back", async () => {
    const { clientId, visitId } = await groomFor("prepaid");
    // A prepaid plan is what makes client_default_billing_cadence prepaid.
    await admin
      .from("subscriptions")
      .update({ billing_cadence: "prepaid" })
      .eq("client_id", clientId);
    const balance = async () =>
      (await admin.from("clients").select("credit_balance_cents").eq("id", clientId).single()).data!
        .credit_balance_cents as number;
    const before = await balance();
    await complete(visitId);
    expect((await charges(visitId))[0]).toMatchObject({ status: "paid_from_credit" });
    expect(await balance()).toBe(before - 1500);

    expect((await owner.rpc("office_mark_visit_missed", { _visit_id: visitId })).error).toBeNull();
    expect((await charges(visitId))[0]).toMatchObject({ status: "voided" });
    expect(await balance()).toBe(before);
    expect(await owedForAddons(clientId)).toBe(0);
  });

  it("charges again if the groom is completed again, once", async () => {
    const { visitId } = await groomFor("again");
    await complete(visitId);
    await admin.from("visits").update({ status: "scheduled", completed_at: null }).eq("id", visitId);
    expect((await charges(visitId)).map((c) => c.status)).toEqual(["voided"]);
    await complete(visitId);
    expect((await charges(visitId)).map((c) => c.status)).toEqual(["voided", "pending"]);
  });

  it("refuses while the add-on is on an invoice, and leaves the charge alone", async () => {
    const { clientId, visitId } = await groomFor("invoiced");
    await complete(visitId);
    const [charge] = await charges(visitId);
    const invoiceId = await insert("invoices", {
      organization_id: orgId,
      client_id: clientId,
      period_start: addDays(new Date().toISOString().slice(0, 10), -30),
      period_end: new Date().toISOString().slice(0, 10),
      status: "open",
      total_cents: 1500,
    });
    const lineId = await insert("invoice_line_items", {
      invoice_id: invoiceId,
      description: "Teeth brushing",
      amount_cents: 1500,
    });
    await admin
      .from("addon_charges")
      .update({ status: "invoiced", invoice_line_item_id: lineId })
      .eq("id", charge.id);

    const missed = await owner.rpc("office_mark_visit_missed", { _visit_id: visitId });
    expect(missed.error?.message).toMatch(
      /An add-on on this visit is already on invoice .+\. Void or remove that invoice line/,
    );
    const { data: v } = await admin.from("visits").select("status").eq("id", visitId).single();
    expect(v!.status).toBe("completed");
    expect((await charges(visitId))[0]).toMatchObject({ status: "invoiced" });
  });

  afterAll(async () => {
    if (!admin || !orgId) return;
    await admin.from("addon_charges").delete().eq("organization_id", orgId);
    await admin.from("invoices").delete().eq("organization_id", orgId);
    await admin.from("credit_ledger").delete().eq("organization_id", orgId);
    await admin.from("visits").delete().eq("organization_id", orgId);
    await admin.from("subscriptions").delete().eq("organization_id", orgId);
    await admin.from("organizations").delete().eq("id", orgId);
    for (const id of users) await admin.auth.admin.deleteUser(id);
  });
});
