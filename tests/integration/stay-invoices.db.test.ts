// Real Postgres proof for stay requests, confirmation and billing (#411 S3).
// CI builds the local stack from migrations. No production credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let other: WalkOrg;
let nightService: string;
let dropInService: string;
const startDate = new Date();
startDate.setUTCDate(startDate.getUTCDate() + 14);
const day = (n: number) => new Date(startDate.getTime() + n * 86400000).toISOString().slice(0, 10);

async function home() {
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: "Stay invoice client",
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: "10 Sitting St",
    city: "Austin",
    postal_code: "78701",
    gate_code: "SECRET-DOOR",
    lock_box_code: "SECRET-BOX",
  });
  const pets: string[] = [];
  for (const species of ["dog", "cat"])
    pets.push(
      await insertRow(org.admin, "dogs", {
        organization_id: org.orgId,
        property_id: propertyId,
        name: species,
        species,
        active: true,
      }),
    );
  return { clientId, propertyId, pets };
}

async function request(
  h: Awaited<ReturnType<typeof home>>,
  serviceId = nightService,
  requestKey = randomUUID(),
) {
  const args = {
    _org_id: org.orgId,
    _client_id: h.clientId,
    _request_key: requestKey,
    _input: {
      propertyId: h.propertyId,
      serviceId,
      startsOn: day(0),
      endsOn: day(serviceId === nightService ? 5 : 4),
      petIds: h.pets,
      windows: [
        { earliest: "08:00", latest: "10:00" },
        { earliest: "17:00", latest: "19:00" },
      ],
      notes: "Please bring in the mail.",
      care: h.pets.map((petId) => ({
        petId,
        feeding: "Half a cup at 8",
        otherCare: "Water the plant",
        meds: [{ name: "Tablet", dose: "Half", times: ["08:00"], notes: "With food" }],
      })),
    },
  };
  const { data, error } = await org.admin.rpc("portal_request_stay", args);
  expect(error).toBeNull();
  return { stayId: data as string, args };
}

async function confirm(stayId: string, deposit = 10000) {
  const r = await org.owner.client.rpc("confirm_stay", {
    _stay_id: stayId,
    _deposit_cents: deposit,
  });
  expect(r.error).toBeNull();
  return r.data as string;
}

async function stay(stayId: string) {
  const r = await org.admin.from("stays").select("*").eq("id", stayId).single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}
async function visits(stayId: string) {
  const r = await org.admin
    .from("visits")
    .select("id, status, scheduled_on, subscription_id, subscriptions!inner(stay_id)")
    .eq("subscriptions.stay_id", stayId)
    .order("scheduled_on");
  if (r.error) throw new Error(r.error.message);
  return r.data ?? [];
}

describe.skipIf(!dbEnabled)("stay invoices in the database", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay invoices");
    other = await makeWalkOrg("Other stay invoices");
    const changed = await org.admin
      .from("organizations")
      .update({ service_lines: ["pet_sitting"], sales_tax_rate_bps: 0 })
      .eq("id", org.orgId);
    expect(changed.error).toBeNull();
    nightService = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Overnight care",
      service_line: "pet_sitting",
      price_unit: "night",
      base_price_cents: 6000,
      extra_pet_cents: 1500,
    });
    dropInService = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Drop-in care",
      service_line: "pet_sitting",
      price_unit: "visit",
      base_price_cents: 2500,
      extra_pet_cents: 500,
      default_duration_min: 30,
    });
  });
  afterAll(async () => {
    await org?.cleanup();
    await other?.cleanup();
  });

  it("requests a stay with care, then confirms five $75 nights on one invoice plus a deposit", async () => {
    const h = await home();
    const req = await request(h);
    expect(await visits(req.stayId)).toHaveLength(0);
    expect((await stay(req.stayId)).status).toBe("requested");
    // Double submission and two simultaneous confirmations are idempotent.
    expect((await org.admin.rpc("portal_request_stay", req.args)).data).toBe(req.stayId);
    const [id, again] = await Promise.all([confirm(req.stayId), confirm(req.stayId)]);
    expect(again).toBe(id);
    const st = await stay(req.stayId);
    expect(st.status).toBe("confirmed");
    expect(st.invoice_id).toBe(id);
    expect(st.deposit_cents).toBe(10000);
    expect(st.care_snapshot).toHaveLength(2);
    expect(st.care_snapshot[0]).toMatchObject({
      feeding: "Half a cup at 8",
      meds: [{ name: "Tablet", dose: "Half", times: ["08:00"], notes: "With food" }],
    });
    const invs = await org.admin
      .from("invoices")
      .select("id, kind, subtotal_cents, total_cents, tax_cents, status")
      .eq("client_id", h.clientId);
    expect(invs.error).toBeNull();
    expect(invs.data).toHaveLength(2);
    expect(invs.data?.find((i) => i.id === id)).toMatchObject({
      subtotal_cents: 37500,
      total_cents: 37500,
      kind: "postpaid",
      status: "open",
    });
    expect(invs.data?.find((i) => i.id === st.deposit_invoice_id)).toMatchObject({
      total_cents: 10000,
      tax_cents: 0,
      kind: "prepaid_topup",
      status: "open",
    });
    const vs = await visits(req.stayId);
    expect(vs).toHaveLength(5);
    const lines = await org.admin
      .from("invoice_line_items")
      .select("amount_cents, description, visit_id, subscription_id")
      .eq("invoice_id", id);
    expect(lines.error).toBeNull();
    expect(lines.data).toHaveLength(5);
    expect(
      lines.data?.every(
        (l) => l.amount_cents === 7500 && l.description.startsWith("Overnight care on "),
      ),
    ).toBe(true);
    expect(new Set(lines.data?.map((l) => l.visit_id))).toEqual(new Set(vs.map((v) => v.id)));
    expect(lines.data?.every((l) => l.subscription_id)).toBe(true);
    const saved = await org.admin
      .from("pet_care_instructions")
      .select("feeding")
      .eq("pet_id", h.pets[0])
      .single();
    expect(saved.data?.feeding).toBe("Half a cup at 8");
    // Completion still works after advance invoicing. The regular cycle and
    // its per-client generator both leave the stay visits already billed.
    const done = await org.admin
      .from("visits")
      .update({
        status: "completed",
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      })
      .in(
        "id",
        vs.map((v) => v.id),
      );
    expect(done.error).toBeNull();
    const cycle = await org.admin.rpc("run_billing_cycles", { _org_id: org.orgId });
    expect(cycle.error).toBeNull();
    const bill = await org.admin.rpc("admin_generate_invoice_for_client", {
      _client_id: h.clientId,
      _through: day(10),
    });
    expect(bill.error).toBeNull();
    expect(bill.data).toBeNull();
    const count = await org.admin
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("client_id", h.clientId);
    expect(count.count).toBe(2);
  });

  it("drop-ins Monday to Friday with two windows make ten visits and ten billed lines", async () => {
    const h = await home();
    const { stayId } = await request(h, dropInService);
    const id = await confirm(stayId, 0);
    expect(await visits(stayId)).toHaveLength(10);
    const inv = await org.admin.from("invoices").select("total_cents").eq("id", id).single();
    expect(inv.data?.total_cents).toBe(30000);
    const lines = await org.admin.from("invoice_line_items").select("id").eq("invoice_id", id);
    expect(lines.data).toHaveLength(10);
    expect((await stay(stayId)).deposit_invoice_id).toBeNull();
  });

  it("canceling voids both unpaid invoices and cancels the invoiced future visits", async () => {
    const h = await home();
    const { stayId } = await request(h);
    const invoiceId = await confirm(stayId);
    const st = await stay(stayId);
    const canceled = await org.owner.client
      .from("stays")
      .update({ status: "canceled" })
      .eq("id", stayId);
    expect(canceled.error).toBeNull();
    const invs = await org.admin
      .from("invoices")
      .select("status")
      .in("id", [invoiceId, st.deposit_invoice_id]);
    expect(invs.data).toEqual([{ status: "void" }, { status: "void" }]);
    expect((await visits(stayId)).every((v) => v.status === "canceled")).toBe(true);
    expect((await org.owner.client.rpc("confirm_stay", { _stay_id: stayId })).error).not.toBeNull();
  });

  it("the paid deposit becomes account credit that comes off the stay invoice", async () => {
    const h = await home();
    const { stayId } = await request(h);
    const id = await confirm(stayId);
    const st = await stay(stayId);
    const paid = await org.admin
      .from("invoices")
      .update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("id", st.deposit_invoice_id);
    expect(paid.error).toBeNull();
    const applied = await org.admin.rpc("apply_credit_to_invoice", { _invoice_id: id });
    expect(applied.error).toBeNull();
    const inv = await org.admin
      .from("invoices")
      .select("credit_applied_cents, total_cents")
      .eq("id", id)
      .single();
    expect(inv.data).toMatchObject({ total_cents: 37500, credit_applied_cents: 10000 });
    // The existing void path returns partial applied credit on cancellation.
    const canceled = await org.owner.client
      .from("stays")
      .update({ status: "canceled" })
      .eq("id", stayId);
    expect(canceled.error).toBeNull();
    const balance = await org.admin
      .from("clients")
      .select("credit_balance_cents")
      .eq("id", h.clientId)
      .single();
    expect(balance.data?.credit_balance_cents).toBe(10000);
  });

  it("adds the configured holiday percentage only on holiday dates, not on a blackout", async () => {
    const h = await home();
    expect(
      (
        await org.admin
          .from("services")
          .update({ holiday_surcharge_pct: 20 })
          .eq("id", nightService)
      ).error,
    ).toBeNull();
    expect(
      (
        await org.admin
          .from("holiday_dates")
          .insert({ organization_id: org.orgId, holiday_on: day(2), name: "Holiday" })
      ).error,
    ).toBeNull();
    // A closure is not a holiday rate, and care still happens on it.
    expect(
      (
        await org.admin
          .from("blackout_dates")
          .insert({ organization_id: org.orgId, blackout_on: day(3), reason: "Closed" })
      ).error,
    ).toBeNull();
    const { stayId } = await request(h);
    const id = await confirm(stayId, 0);
    expect(await visits(stayId)).toHaveLength(5);
    const invoice = await org.admin.from("invoices").select("total_cents").eq("id", id).single();
    expect(invoice.data?.total_cents).toBe(39000);
    const lines = await org.admin
      .from("invoice_line_items")
      .select("description")
      .eq("invoice_id", id)
      .like("description", "%(holiday rate)");
    expect(lines.data?.map((l) => l.description)).toEqual([
      `Overnight care on ${day(2)} (holiday rate)`,
    ]);
    expect(
      (await org.admin.from("services").update({ holiday_surcharge_pct: 0 }).eq("id", nightService))
        .error,
    ).toBeNull();
  });

  it("holiday dates are the office's to write and the business's to read", async () => {
    const own = await org.owner.client
      .from("holiday_dates")
      .insert({ organization_id: org.orgId, holiday_on: day(40), name: "New Year" })
      .select("id")
      .single();
    expect(own.error).toBeNull();
    const tech = await org.walker.client
      .from("holiday_dates")
      .insert({ organization_id: org.orgId, holiday_on: day(41) });
    expect(tech.error).not.toBeNull();
    expect(
      (await org.walker.client.from("holiday_dates").select("id").eq("id", own.data!.id)).data,
    ).toHaveLength(1);
    expect(
      (await other.owner.client.from("holiday_dates").select("id").eq("organization_id", org.orgId))
        .data,
    ).toEqual([]);
    expect((await org.anon.from("holiday_dates").select("id")).error).not.toBeNull();
  });

  it("rolls failed confirmation back and refuses other clients, tenants, techs and API-role requests", async () => {
    const h = await home();
    const { stayId, args } = await request(h);
    const bad = await org.owner.client.rpc("confirm_stay", {
      _stay_id: stayId,
      _deposit_cents: 1000000,
    });
    expect(bad.error?.message).toMatch(/deposit cannot exceed/);
    expect((await stay(stayId)).status).toBe("requested");
    expect(await visits(stayId)).toHaveLength(0);
    expect(
      (await org.admin.from("invoices").select("id").eq("client_id", h.clientId)).data,
    ).toEqual([]);
    expect(
      (await org.walker.client.rpc("confirm_stay", { _stay_id: stayId })).error,
    ).not.toBeNull();
    expect(
      (await other.owner.client.rpc("confirm_stay", { _stay_id: stayId })).error,
    ).not.toBeNull();
    expect((await org.anon.rpc("portal_request_stay", args)).error).not.toBeNull();
    expect((await org.owner.client.rpc("portal_request_stay", args)).error).not.toBeNull();
    const another = await home();
    const crossClient = await org.admin.rpc("portal_request_stay", {
      ...args,
      _request_key: randomUUID(),
      _client_id: another.clientId,
    });
    expect(crossClient.error?.message).toMatch(/property does not belong/);
    const crossPet = await org.admin.rpc("portal_request_stay", {
      ...args,
      _request_key: randomUUID(),
      _input: { ...args._input, petIds: another.pets },
    });
    expect(crossPet.error?.message).toMatch(/Every pet/);
    expect((await other.owner.client.from("stays").select("id").eq("id", stayId)).data).toEqual([]);
  });

  it("pet-waste generation and per-client billing keep their existing price and wording", async () => {
    // Every day a work day: day(0) is two weeks out and can land on a weekend,
    // where a one-time visit would move past its end date.
    expect(
      (
        await other.admin
          .from("organizations")
          .update({ service_lines: ["pet_waste"], work_days: [0, 1, 2, 3, 4, 5, 6] })
          .eq("id", other.orgId)
      ).error,
    ).toBeNull();
    const clientId = await insertRow(other.admin, "clients", {
      organization_id: other.orgId,
      display_name: "Scooping client",
      account_type: "residential",
      active: true,
    });
    const propertyId = await insertRow(other.admin, "properties", {
      organization_id: other.orgId,
      client_id: clientId,
      street: "1 Yard Ln",
      city: "Austin",
      postal_code: "78701",
    });
    const serviceId = await insertRow(other.admin, "services", {
      organization_id: other.orgId,
      name: "Weekly scoop",
      service_line: "pet_waste",
      price_unit: "visit",
    });
    const subscriptionId = await insertRow(other.admin, "subscriptions", {
      organization_id: other.orgId,
      client_id: clientId,
      property_id: propertyId,
      service_id: serviceId,
      account_type: "residential",
      dog_count: 1,
      frequency: "one_time",
      started_on: day(0),
      ends_on: day(0),
      status: "active",
      billing_cadence: "postpaid",
      price_cents: 2200,
    });
    expect(
      (
        await other.admin.rpc("generate_visits_core", {
          _org_id: other.orgId,
          _through: day(1),
          _subscription_id: subscriptionId,
        })
      ).error,
    ).toBeNull();
    const v = await other.admin
      .from("visits")
      .select("id")
      .eq("subscription_id", subscriptionId)
      .single();
    expect(v.error).toBeNull();
    expect(
      (
        await other.admin
          .from("visits")
          .update({ status: "completed", completed_at: new Date().toISOString() })
          .eq("id", v.data!.id)
      ).error,
    ).toBeNull();
    const billed = await other.admin.rpc("admin_generate_invoice_for_client", {
      _client_id: clientId,
      _through: day(2),
    });
    expect(billed.error).toBeNull();
    const line = await other.admin
      .from("invoice_line_items")
      .select("amount_cents, description")
      .eq("invoice_id", billed.data)
      .single();
    expect(line.data?.amount_cents).toBe(2200);
    expect(line.data?.description).toMatch(/^Weekly scoop on /);
    expect((await other.admin.from("stays").select("id").eq("client_id", clientId)).data).toEqual(
      [],
    );
  });
});
