/** A walk bills as a walk (#410): the invoice line names the service and
 *  carries the right price for a flat walk with an extra dog, an hourly walk,
 *  and each member of a group walk.
 *
 *  The price is worked out the way the plan form works it out: the one rule
 *  (service_price_cents in SQL, servicePriceCents in TypeScript, held equal by
 *  tests/a-walk-is-priced-as-a-walk.test.ts) sets the plan's price, the visit
 *  generator's trigger copies the plan's service onto the visit, and
 *  admin_generate_invoice_for_client bills the completed visit.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite. Skipped without TEST_SUPABASE_* env. */
import { beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { orgDay } from "../support/org-day";

const URL = process.env.TEST_SUPABASE_URL;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_KEY;
const enabled = Boolean(URL && SERVICE);
const runId = Math.random().toString(36).slice(2, 10);

// The org's zone is set on the org below. Every date here is counted from
// today in that zone, so the walk and the billing cutoff agree at any hour.
const ORG_TZ = "UTC";
const today = orgDay(ORG_TZ);
const walkDay = orgDay(ORG_TZ, -7);

let admin: SupabaseClient;
let orgId: string;
let serial = 0;

async function ins(table: string, row: Record<string, unknown>): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`insert ${table}: ${error.message}`);
  return (data as { id: string }).id;
}

async function service(row: Record<string, unknown>): Promise<string> {
  return ins("services", {
    organization_id: orgId,
    service_line: "dog_walking",
    extra_pet_cents: 0,
    active: true,
    ...row,
  });
}

async function household(dogs: number) {
  const n = ++serial;
  const clientId = await ins("clients", {
    organization_id: orgId,
    display_name: `Invoice walk client ${n} ${runId}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await ins("properties", {
    organization_id: orgId,
    client_id: clientId,
    street: `${n} Leash Ln`,
    city: "Austin",
    postal_code: "78701",
  });
  for (let i = 0; i < dogs; i++) {
    await ins("dogs", {
      organization_id: orgId,
      property_id: propertyId,
      name: `Dog ${n}-${i + 1}`,
      active: true,
    });
  }
  return { clientId, propertyId };
}

/** The plan's price through the one rule, as the plan form sets it. */
async function rulePrice(args: {
  unit: "visit" | "hour";
  base: number;
  extraPet: number;
  duration: number;
  pets: number;
  minutes?: number;
}): Promise<number> {
  const { data, error } = await admin.rpc("service_price_cents", {
    _price_unit: args.unit,
    _base_price_cents: args.base,
    _extra_pet_cents: args.extraPet,
    _default_duration_min: args.duration,
    _pets: args.pets,
    ...(args.minutes != null ? { _minutes: args.minutes } : {}),
  });
  if (error) throw new Error(`service_price_cents: ${error.message}`);
  return data as number;
}

/** A postpaid walk plan with one completed walk last week. */
async function completedWalk(opts: {
  serviceId: string;
  priceCents: number;
  dogs: number;
  walkGroupId?: string;
}) {
  const home = await household(opts.dogs);
  const subscriptionId = await ins("subscriptions", {
    organization_id: orgId,
    client_id: home.clientId,
    property_id: home.propertyId,
    account_type: "residential",
    dog_count: opts.dogs,
    frequency: "weekly",
    price_cents: opts.priceCents,
    billing_cadence: "postpaid",
    service_id: opts.serviceId,
    status: "active",
    started_on: walkDay,
  });
  const visitId = await ins("visits", {
    organization_id: orgId,
    client_id: home.clientId,
    property_id: home.propertyId,
    subscription_id: subscriptionId,
    service_id: opts.serviceId,
    scheduled_on: walkDay,
    // Written as done, the way tests/sql/a-walk-is-priced-as-a-walk.proof.sql
    // writes its billed visits.
    status: "completed",
    completed_at: new Date().toISOString(),
    walk_group_id: opts.walkGroupId ?? null,
  });
  return { ...home, subscriptionId, visitId };
}

async function billedLine(clientId: string, visitId: string) {
  const { data: invoiceId, error } = await admin.rpc("admin_generate_invoice_for_client", {
    _client_id: clientId,
    _through: today,
  });
  if (error) throw new Error(`admin_generate_invoice_for_client: ${error.message}`);
  expect(invoiceId, "no invoice was generated").toBeTruthy();
  const { data: lines, error: lErr } = await admin
    .from("invoice_line_items")
    .select("description, amount_cents, visit_id")
    .eq("invoice_id", invoiceId as string);
  if (lErr) throw new Error(lErr.message);
  const visitLines = (lines ?? []).filter((l: any) => l.visit_id === visitId);
  expect(visitLines).toHaveLength(1);
  return visitLines[0] as { description: string; amount_cents: number };
}

describe.skipIf(!enabled)("a walk bills as a walk", () => {
  beforeAll(async () => {
    admin = createClient(URL!, SERVICE!, { auth: { persistSession: false } });
    orgId = await ins("organizations", {
      name: `Walk invoices ${runId}`,
      service_lines: ["dog_walking"],
      timezone: ORG_TZ,
    });
  });

  it("bills a flat 30-minute walk for two dogs at $25 + $5: one line, named, $30", async () => {
    const name = `30-minute walk ${runId}`;
    const serviceId = await service({
      name,
      price_unit: "visit",
      base_price_cents: 2500,
      extra_pet_cents: 500,
      default_duration_min: 30,
    });
    const price = await rulePrice({ unit: "visit", base: 2500, extraPet: 500, duration: 30, pets: 2 });
    expect(price).toBe(3000);
    const w = await completedWalk({ serviceId, priceCents: price, dogs: 2 });
    const line = await billedLine(w.clientId, w.visitId);
    expect(line.amount_cents).toBe(3000);
    expect(line.description.startsWith(`${name} on ${walkDay}`)).toBe(true);
  });

  it("bills an hourly walk at $40 an hour for 90 minutes: $60", async () => {
    const name = `Long walk ${runId}`;
    const serviceId = await service({
      name,
      price_unit: "hour",
      base_price_cents: 4000,
      default_duration_min: 90,
    });
    const price = await rulePrice({ unit: "hour", base: 4000, extraPet: 0, duration: 90, pets: 1 });
    expect(price).toBe(6000);
    const w = await completedWalk({ serviceId, priceCents: price, dogs: 1 });
    const line = await billedLine(w.clientId, w.visitId);
    expect(line.amount_cents).toBe(6000);
    expect(line.description.startsWith(`${name} on ${walkDay}`)).toBe(true);
  });

  it("bills each member of a group walk on their own invoice line", async () => {
    const name = `Pack walk ${runId}`;
    const serviceId = await service({
      name,
      price_unit: "visit",
      base_price_cents: 2000,
      default_duration_min: 60,
      max_dogs: 4,
    });
    const groupId = await ins("walk_groups", {
      organization_id: orgId,
      service_id: serviceId,
      scheduled_on: walkDay,
    });
    const price = await rulePrice({ unit: "visit", base: 2000, extraPet: 0, duration: 60, pets: 1 });
    const a = await completedWalk({ serviceId, priceCents: price, dogs: 1, walkGroupId: groupId });
    const b = await completedWalk({ serviceId, priceCents: price, dogs: 1, walkGroupId: groupId });
    for (const m of [a, b]) {
      const line = await billedLine(m.clientId, m.visitId);
      expect(line.amount_cents).toBe(2000);
      expect(line.description.startsWith(`${name} on ${walkDay}`)).toBe(true);
    }
  });
});
