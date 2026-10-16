/** A stay's codes go to the stay's sitter during the stay, and to the office
 *  (#411 review, blocker 2). Every read is logged.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, setStaffActive, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let dropInService: string;
const today = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A home with every kind of code, and a confirmed drop-in stay there with
 *  `sitter` on it, `days` days starting `startIn` days from today. Drop-ins,
 *  so one sitter can hold several of these on the same days. */
async function stayAt(startIn: number, days: number, sitter: string | null) {
  const n = Math.random().toString(36).slice(2, 8);
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: `Stay access ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: `${n} Sitting St`,
    city: "Austin",
    postal_code: "78701",
    gate_code: "GATE-1",
    lock_box_code: "BOX-2",
    key_location: "Blue pot",
    key_tag: "K-7",
    alarm_notes: "Panel by the garage, 2580",
  });
  const petId = await insertRow(org.admin, "dogs", {
    organization_id: org.orgId,
    property_id: propertyId,
    name: `Cat ${n}`,
    species: "cat",
    active: true,
  });
  const req = await org.admin.rpc("portal_request_stay", {
    _org_id: org.orgId,
    _client_id: clientId,
    _request_key: randomUUID(),
    _input: {
      propertyId,
      serviceId: dropInService,
      startsOn: shift(startIn),
      endsOn: shift(startIn + days - 1),
      petIds: [petId],
      windows: [{ earliest: "08:00", latest: "10:00" }],
    },
  });
  expect(req.error).toBeNull();
  const stayId = req.data as string;
  if (sitter) {
    const set = await org.admin.from("stays").update({ assigned_staff_id: sitter }).eq("id", stayId);
    expect(set.error).toBeNull();
  }
  const ok = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
  expect(ok.error).toBeNull();
  return { stayId, propertyId, clientId };
}

const codes = (who: WalkOrg["walker"], stayIds: string[]) =>
  who.client.rpc("stay_access_codes", { _stay_ids: stayIds });

async function views(stayId: string, userId: string) {
  const r = await org.admin
    .from("activity_log")
    .select("id, meta")
    .eq("kind", "stay.access_viewed")
    .eq("actor_user_id", userId)
    .contains("meta", { stay_id: stayId });
  if (r.error) throw new Error(r.error.message);
  return r.data ?? [];
}

describe.skipIf(!dbEnabled)("who can read a stay's codes", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Stay access");
    const lines = await org.admin
      .from("organizations")
      .update({ service_lines: ["pet_sitting"] })
      .eq("id", org.orgId);
    expect(lines.error).toBeNull();
    dropInService = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Drop-in care",
      service_line: "pet_sitting",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 30,
    });
  });
  afterAll(async () => {
    await org?.cleanup();
  });

  it("the stay's sitter gets every code on a stay night, and the read is logged", async () => {
    const s = await stayAt(0, 3, org.walker.staffId);
    const { data, error } = await codes(org.walker, [s.stayId]);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        stay_id: s.stayId,
        property_id: s.propertyId,
        gate_code: "GATE-1",
        lock_box_code: "BOX-2",
        key_location: "Blue pot",
        key_tag: "K-7",
        alarm_notes: "Panel by the garage, 2580",
      },
    ]);
    const logged = await views(s.stayId, org.walker.userId);
    expect(logged).toHaveLength(1);
    expect(logged[0].meta).toMatchObject({ as: "sitter" });
  });

  it("the sitter gets them the day before the first visit, not two days before", async () => {
    const tomorrow = await stayAt(1, 2, org.walker.staffId);
    expect((await codes(org.walker, [tomorrow.stayId])).data).toHaveLength(1);
    const later = await stayAt(2, 2, org.walker.staffId);
    const { data, error } = await codes(org.walker, [later.stayId]);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
    expect(await views(later.stayId, org.walker.userId)).toEqual([]);
  });

  it("another sitter, a sitter turned off, and anyone signed out get nothing", async () => {
    const s = await stayAt(0, 2, org.walker.staffId);
    expect((await codes(org.otherWalker, [s.stayId])).data ?? []).toEqual([]);
    const anon = await org.anon.rpc("stay_access_codes", { _stay_ids: [s.stayId] });
    expect(anon.data ?? []).toEqual([]);
    try {
      await setStaffActive(org, org.walker.staffId!, false);
      expect((await codes(org.walker, [s.stayId])).data ?? []).toEqual([]);
    } finally {
      await setStaffActive(org, org.walker.staffId!, true);
    }
  });

  it("taking the sitter off the stay takes the codes away", async () => {
    const s = await stayAt(0, 3, org.walker.staffId);
    expect((await codes(org.walker, [s.stayId])).data).toHaveLength(1);
    const moved = await org.owner.client
      .from("stays")
      .update({ assigned_staff_id: org.otherWalker.staffId })
      .eq("id", s.stayId);
    expect(moved.error).toBeNull();
    expect((await codes(org.walker, [s.stayId])).data ?? []).toEqual([]);
    expect((await codes(org.otherWalker, [s.stayId])).data).toHaveLength(1);
  });

  it("a canceled stay gives nobody a code; the office sees every stay and is logged too", async () => {
    const s = await stayAt(10, 2, org.walker.staffId);
    const office = await codes(org.owner, [s.stayId]);
    expect(office.data).toEqual([expect.objectContaining({ lock_box_code: "BOX-2" })]);
    expect((await views(s.stayId, org.owner.userId))[0]?.meta).toMatchObject({ as: "office" });
    const canceled = await org.owner.client.from("stays").update({ status: "canceled" }).eq("id", s.stayId);
    expect(canceled.error).toBeNull();
    expect((await codes(org.owner, [s.stayId])).data ?? []).toEqual([]);
  });

  it("a stay visit today does not open property_access_codes for the sitter", async () => {
    const s = await stayAt(0, 2, org.walker.staffId);
    const { data, error } = await org.walker.client.rpc("property_access_codes", {
      _property_ids: [s.propertyId],
    });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
    const plain = await org.walker.client
      .from("properties")
      .select("alarm_notes")
      .eq("id", s.propertyId);
    expect(plain.error).not.toBeNull();
  });
});
