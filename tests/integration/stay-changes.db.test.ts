// Real Postgres proof for changing and canceling a confirmed stay (#411
// review, blocker 1). CI builds the local stack from migrations. Skipped
// without TEST_SUPABASE_* env. No production credentials.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let nightService: string;
const today = new Date().toISOString().slice(0, 10);
const shift = (from: string, n: number) => {
  const d = new Date(`${from}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const ahead = shift(today, 14);

async function home() {
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: "Stay change client",
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: "12 Sitting St",
    city: "Austin",
    postal_code: "78701",
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

/** A confirmed overnight stay: `nights` nights from `startsOn`, one pet unless
 *  told otherwise, $60 a night for one pet and $75 for two. */
async function booked(startsOn: string, nights: number, petCount = 1) {
  const h = await home();
  const { data: stayId, error } = await org.admin.rpc("portal_request_stay", {
    _org_id: org.orgId,
    _client_id: h.clientId,
    _request_key: randomUUID(),
    _input: {
      propertyId: h.propertyId,
      serviceId: nightService,
      startsOn,
      endsOn: shift(startsOn, nights),
      petIds: h.pets.slice(0, petCount),
    },
  });
  expect(error).toBeNull();
  const confirmed = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
  expect(confirmed.error).toBeNull();
  return { ...h, stayId: stayId as string, invoiceId: confirmed.data as string };
}

async function change(stayId: string, args: { endsOn: string; startsOn?: string; petIds?: string[] }) {
  return org.owner.client.rpc("change_stay", {
    _stay_id: stayId,
    _ends_on: args.endsOn,
    ...(args.startsOn ? { _starts_on: args.startsOn } : {}),
    ...(args.petIds ? { _pet_ids: args.petIds } : {}),
  });
}

async function visits(stayId: string) {
  const r = await org.admin
    .from("visits")
    .select("id, status, scheduled_on, subscriptions!inner(stay_id)")
    .eq("subscriptions.stay_id", stayId)
    .order("scheduled_on");
  if (r.error) throw new Error(r.error.message);
  return r.data ?? [];
}
const live = async (stayId: string) => (await visits(stayId)).filter((v) => v.status !== "canceled");

async function invoice(id: string) {
  const r = await org.admin
    .from("invoices")
    .select("status, total_cents, invoice_line_items(amount_cents, visit_id, description)")
    .eq("id", id)
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data as {
    status: string;
    total_cents: number;
    invoice_line_items: Array<{ amount_cents: number; visit_id: string | null; description: string }>;
  };
}

async function markPaid(id: string) {
  const r = await org.admin
    .from("invoices")
    .update({ status: "paid", paid_at: new Date().toISOString() })
    .eq("id", id);
  expect(r.error).toBeNull();
}

async function balance(clientId: string) {
  const r = await org.admin.from("clients").select("credit_balance_cents").eq("id", clientId).single();
  return r.data?.credit_balance_cents ?? 0;
}

describe.skipIf(!dbEnabled)("changing a confirmed stay in the database", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay changes");
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
  });
  afterAll(async () => {
    await org?.cleanup();
  });

  it("extends an unpaid stay by two nights: two visits and two lines on the stay invoice", async () => {
    const s = await booked(ahead, 5);
    const r = await change(s.stayId, { endsOn: shift(ahead, 7) });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ visits_added: 2, visits_canceled: 0, invoice_id: null });
    expect(await live(s.stayId)).toHaveLength(7);
    const inv = await invoice(s.invoiceId);
    expect(inv.invoice_line_items).toHaveLength(7);
    expect(inv.total_cents).toBe(7 * 6000);
    const st = await org.admin.from("stays").select("ends_on").eq("id", s.stayId).single();
    expect(st.data?.ends_on).toBe(shift(ahead, 7));
  });

  it("shortens an unpaid stay: the lost nights are canceled and come off the invoice", async () => {
    const s = await booked(ahead, 5);
    const r = await change(s.stayId, { endsOn: shift(ahead, 3) });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ visits_canceled: 2 });
    expect(await live(s.stayId)).toHaveLength(3);
    const inv = await invoice(s.invoiceId);
    expect(inv.invoice_line_items).toHaveLength(3);
    expect(inv.total_cents).toBe(3 * 6000);
    // Lengthened again, the canceled nights come back rather than doubling.
    expect((await change(s.stayId, { endsOn: shift(ahead, 5) })).error).toBeNull();
    expect(await live(s.stayId)).toHaveLength(5);
    expect((await invoice(s.invoiceId)).total_cents).toBe(5 * 6000);
  });

  it("the unpaid stay invoice's period follows the new dates; a paid one keeps its own (gaps-r2-07)", async () => {
    const period = async (id: string) => {
      const r = await org.admin
        .from("invoices")
        .select("period_start, period_end")
        .eq("id", id)
        .single();
      if (r.error) throw new Error(r.error.message);
      return r.data;
    };
    const s = await booked(ahead, 5);
    expect(await period(s.invoiceId)).toEqual({ period_start: ahead, period_end: shift(ahead, 5) });
    // Early return: two nights fewer.
    expect((await change(s.stayId, { endsOn: shift(ahead, 3) })).error).toBeNull();
    expect(await period(s.invoiceId)).toEqual({ period_start: ahead, period_end: shift(ahead, 3) });
    // A start moved later, and the end extended.
    expect(
      (await change(s.stayId, { startsOn: shift(ahead, 1), endsOn: shift(ahead, 6) })).error,
    ).toBeNull();
    expect(await period(s.invoiceId)).toEqual({
      period_start: shift(ahead, 1),
      period_end: shift(ahead, 6),
    });

    const paid = await booked(ahead, 5);
    await markPaid(paid.invoiceId);
    expect((await change(paid.stayId, { endsOn: shift(ahead, 3) })).error).toBeNull();
    expect(await period(paid.invoiceId)).toEqual({
      period_start: ahead,
      period_end: shift(ahead, 5),
    });
  });

  it("adds a pet: the nights to come take the two-pet price", async () => {
    const s = await booked(ahead, 3);
    const r = await change(s.stayId, { endsOn: shift(ahead, 3), petIds: s.pets });
    expect(r.error).toBeNull();
    const inv = await invoice(s.invoiceId);
    expect(inv.total_cents).toBe(3 * 7500);
    const st = await org.admin.from("stays").select("pet_ids, care_snapshot").eq("id", s.stayId).single();
    expect(new Set(st.data?.pet_ids)).toEqual(new Set(s.pets));
    expect(st.data?.care_snapshot).toHaveLength(2);
  });

  it("on a paid stay, added nights go on a new invoice and the paid one is left alone", async () => {
    const s = await booked(ahead, 5);
    await markPaid(s.invoiceId);
    const r = await change(s.stayId, { endsOn: shift(ahead, 7) });
    expect(r.error).toBeNull();
    const added = (r.data as { invoice_id: string }).invoice_id;
    expect(added).toBeTruthy();
    const extra = await invoice(added);
    expect(extra).toMatchObject({ status: "open", total_cents: 2 * 6000 });
    expect(extra.invoice_line_items.every((l) => l.visit_id)).toBe(true);
    const paid = await invoice(s.invoiceId);
    expect(paid).toMatchObject({ status: "paid", total_cents: 5 * 6000 });
  });

  it("on a paid stay, removed nights and a removed pet are credited to the account", async () => {
    const s = await booked(ahead, 5, 2);
    await markPaid(s.invoiceId);
    expect(await balance(s.clientId)).toBe(0);
    // Two nights off: 2 x $75.
    expect((await change(s.stayId, { endsOn: shift(ahead, 3) })).error).toBeNull();
    expect(await balance(s.clientId)).toBe(15000);
    // One pet off the three nights left: 3 x $15.
    expect((await change(s.stayId, { endsOn: shift(ahead, 3), petIds: [s.pets[0]] })).error).toBeNull();
    expect(await balance(s.clientId)).toBe(15000 + 4500);
    const st = await org.admin.from("stays").select("credited_cents").eq("id", s.stayId).single();
    expect(st.data?.credited_cents).toBe(19500);
    // The same change again is no change and credits nothing more.
    expect((await change(s.stayId, { endsOn: shift(ahead, 3), petIds: [s.pets[0]] })).error).toBeNull();
    expect(await balance(s.clientId)).toBe(19500);
    expect((await invoice(s.invoiceId)).status).toBe("paid");
  });

  it("moves the start of a stay that has not started, and only that", async () => {
    const s = await booked(ahead, 3);
    const r = await change(s.stayId, { startsOn: shift(ahead, 1), endsOn: shift(ahead, 4) });
    expect(r.error).toBeNull();
    const days = (await live(s.stayId)).map((v) => v.scheduled_on);
    expect(days).toEqual([shift(ahead, 1), shift(ahead, 2), shift(ahead, 3)]);
    expect((await invoice(s.invoiceId)).total_cents).toBe(3 * 6000);
  });

  it("canceling an unpaid stay under way keeps the nights worked on the invoice", async () => {
    const s = await booked(today, 3);
    const [first] = await visits(s.stayId);
    expect(first.scheduled_on).toBe(today);
    const done = await org.admin
      .from("visits")
      .update({ status: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString() })
      .eq("id", first.id);
    expect(done.error).toBeNull();
    const canceled = await org.owner.client.from("stays").update({ status: "canceled" }).eq("id", s.stayId);
    expect(canceled.error).toBeNull();
    const vs = await visits(s.stayId);
    expect(vs.map((v) => v.status)).toEqual(["completed", "canceled", "canceled"]);
    const inv = await invoice(s.invoiceId);
    expect(inv.status).toBe("open");
    expect(inv.invoice_line_items).toEqual([expect.objectContaining({ visit_id: first.id, amount_cents: 6000 })]);
    expect(inv.total_cents).toBe(6000);
  });

  it("canceling a paid stay under way credits only the canceled nights", async () => {
    const s = await booked(today, 3);
    const [first] = await visits(s.stayId);
    const done = await org.admin
      .from("visits")
      .update({ status: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString() })
      .eq("id", first.id);
    expect(done.error).toBeNull();
    await markPaid(s.invoiceId);
    const canceled = await org.owner.client.from("stays").update({ status: "canceled" }).eq("id", s.stayId);
    expect(canceled.error).toBeNull();
    expect(await balance(s.clientId)).toBe(2 * 6000);
    expect((await invoice(s.invoiceId)).status).toBe("paid");
  });

  it("refuses to end a stay before a night already worked, or to move the start once it has begun", async () => {
    const s = await booked(today, 3);
    const vs = await visits(s.stayId);
    const done = await org.admin
      .from("visits")
      .update({ status: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString() })
      .in("id", [vs[0].id, vs[1].id]);
    expect(done.error).toBeNull();
    const early = await change(s.stayId, { endsOn: shift(today, 1) });
    expect(early.error?.message).toMatch(/already been there/);
    const moved = await change(s.stayId, { startsOn: shift(today, 1), endsOn: shift(today, 4) });
    expect(moved.error?.message).toMatch(/has started/);
    // Ending after the last worked night is fine, and the completed ones are untouched.
    expect((await change(s.stayId, { endsOn: shift(today, 2) })).error).toBeNull();
    const after = await visits(s.stayId);
    expect(after.map((v) => v.status)).toEqual(["completed", "completed", "canceled"]);
    expect((await invoice(s.invoiceId)).total_cents).toBe(2 * 6000);
  });

  it("direct writes of a stay's dates or pets are still refused, and a sitter cannot change a stay", async () => {
    const s = await booked(ahead, 3);
    const dates = await org.owner.client.from("stays").update({ ends_on: shift(ahead, 6) }).eq("id", s.stayId);
    expect(dates.error?.message).toMatch(/Change dates or pets/);
    const pets = await org.owner.client.from("stays").update({ pet_ids: s.pets }).eq("id", s.stayId);
    expect(pets.error?.message).toMatch(/Change the pets with Change dates or pets/);
    const credited = await org.owner.client.from("stays").update({ credited_cents: 100 }).eq("id", s.stayId);
    expect(credited.error).not.toBeNull();
    const tech = await org.walker.client.rpc("change_stay", { _stay_id: s.stayId, _ends_on: shift(ahead, 6) });
    expect(tech.error).not.toBeNull();
    const anon = await org.anon.rpc("change_stay", { _stay_id: s.stayId, _ends_on: shift(ahead, 6) });
    expect(anon.error).not.toBeNull();
    expect(await live(s.stayId)).toHaveLength(3);
  });
});
