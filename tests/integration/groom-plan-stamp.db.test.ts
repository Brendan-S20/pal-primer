// The groom plan trigger in a real database: a visit inserted for a groom
// plan at any date carries the plan's length, price, summary and start, and
// the plan's add-ons are charged once when the groom is completed.
// Skipped unless TEST_SUPABASE_* point at a local stack.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);
let admin: SupabaseClient;
let orgId: string;
let clientId: string;
let propertyId: string;
let subId: string;
let addonId: string;

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

// The plan's pet; the column holds ids without a foreign key.
const BISCUIT = "7d1f3c2a-5b6e-4c8d-9a0b-1c2d3e4f5a6b";

describe.skipIf(!enabled)("a groom plan stamps every visit in the database", () => {
  const first = addDays(new Date().toISOString().slice(0, 10), 7);

  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await insert("organizations", {
      name: `Groom plan ${runId}`,
      service_lines: ["mobile_grooming"],
    });
    clientId = await insert("clients", {
      organization_id: orgId,
      display_name: "Plan client",
      account_type: "residential",
      active: true,
    });
    propertyId = await insert("properties", {
      organization_id: orgId,
      client_id: clientId,
      street: "1 Plan St",
      city: "Austin",
      postal_code: "78701",
    });
    const serviceId = await insert("services", {
      organization_id: orgId,
      name: `Groom ${runId}`,
      service_line: "mobile_grooming",
      price_unit: "visit",
      default_duration_min: 60,
      base_price_cents: 6000,
    });
    addonId = await insert("addon_services", {
      organization_id: orgId,
      code: "TEETH",
      name: "Teeth brushing",
      unit_price_cents: 1500,
      duration_min: 10,
      service_line: "mobile_grooming",
    });
    subId = await insert("subscriptions", {
      organization_id: orgId,
      client_id: clientId,
      property_id: propertyId,
      account_type: "residential",
      frequency: "every_n_days",
      interval_days: 42,
      price_cents: 11000,
      service_id: serviceId,
      dog_count: 1,
      started_on: first,
      groom_start_time: "09:00",
      groom_duration_min: 145,
      groom_summary: "Full groom: Biscuit (large) + Teeth brushing",
      groom_dog_ids: [BISCUIT],
      groom_addons: [
        { addon_service_id: addonId, quantity: 1, unit_price_cents: 1500, name: "Teeth brushing" },
      ],
    });
  });

  it("stamps a visit inserted at day 0, day 126 and day 336 alike", async () => {
    for (const offset of [0, 126, 336]) {
      const { data, error } = await admin
        .from("visits")
        .insert({
          organization_id: orgId,
          subscription_id: subId,
          client_id: clientId,
          property_id: propertyId,
          scheduled_on: addDays(first, offset),
        })
        .select("duration_min, price_cents, groom_summary, start_time, groom_dog_ids")
        .single();
      expect(error).toBeNull();
      expect(data).toEqual({
        duration_min: 145,
        price_cents: 11000,
        groom_summary: "Full groom: Biscuit (large) + Teeth brushing",
        start_time: "09:00:00",
        groom_dog_ids: [BISCUIT],
      });
    }
  });

  it("charges the plan's add-ons once per completion that stands", async () => {
    const { data: visit } = await admin
      .from("visits")
      .select("id")
      .eq("subscription_id", subId)
      .eq("scheduled_on", addDays(first, 336))
      .single();
    const complete = () =>
      admin
        .from("visits")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", visit!.id);
    expect((await complete()).error).toBeNull();
    await admin
      .from("visits")
      .update({ status: "scheduled", completed_at: null })
      .eq("id", visit!.id);
    expect((await complete()).error).toBeNull();
    // Reopening voided the first charge (20261024100500); the second
    // completion charged once more. One live charge.
    const { data: charges } = await admin
      .from("addon_charges")
      .select("addon_service_id, amount_cents, note, status")
      .eq("visit_id", visit!.id)
      .order("created_at");
    expect(charges).toEqual([
      { addon_service_id: addonId, amount_cents: 1500, note: "Booked with the groom", status: "voided" },
      { addon_service_id: addonId, amount_cents: 1500, note: "Booked with the groom", status: "pending" },
    ]);
  });

  afterAll(async () => {
    if (!admin || !orgId) return;
    await admin.from("addon_charges").delete().eq("organization_id", orgId);
    await admin.from("visits").delete().eq("organization_id", orgId);
    await admin.from("subscriptions").delete().eq("organization_id", orgId);
    await admin.from("organizations").delete().eq("id", orgId);
  });
});
