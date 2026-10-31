/** A client's care edit from the portal waits for the office (#611, R2-03).
 *
 *   * a portal request with a med edit leaves pet_care_instructions, the
 *     live sitter card, unchanged and stages the edit on the stay;
 *   * the office confirm applies it and marks the row as the client's;
 *   * a canceled request never touches the card;
 *   * a request with no care changes stages nothing and confirms as before;
 *   * an office edit afterwards clears the client marker.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dbEnabled, insertRow, makeWalkOrg, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let dropInService: string;
const today = new Date().toISOString().slice(0, 10);
const shift = (n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const TONIGHT = [{ name: "Insulin", dose: "2 units", times: ["08:00", "20:00"], notes: null }];
const DECEMBER = [{ name: "Insulin", dose: "4 units", times: ["08:00", "20:00"], notes: null }];

/** A home with one cat whose care card already holds tonight's dose. */
async function home() {
  const n = Math.random().toString(36).slice(2, 8);
  const clientId = await insertRow(org.admin, "clients", {
    organization_id: org.orgId,
    display_name: `Care edit ${n}`,
    account_type: "residential",
    active: true,
  });
  const propertyId = await insertRow(org.admin, "properties", {
    organization_id: org.orgId,
    client_id: clientId,
    street: `${n} Care St`,
    city: "Austin",
    postal_code: "78701",
  });
  const petId = await insertRow(org.admin, "dogs", {
    organization_id: org.orgId,
    property_id: propertyId,
    name: `Cat ${n}`,
    species: "cat",
    active: true,
  });
  const card = await org.admin.from("pet_care_instructions").insert({
    pet_id: petId,
    organization_id: org.orgId,
    feeding: "Half a cup",
    meds: TONIGHT,
    other_care: "Litter daily",
  });
  expect(card.error).toBeNull();
  return { clientId, propertyId, petId };
}

async function request(h: Awaited<ReturnType<typeof home>>, care: unknown[]) {
  const r = await org.admin.rpc("portal_request_stay", {
    _org_id: org.orgId,
    _client_id: h.clientId,
    _request_key: randomUUID(),
    _input: {
      propertyId: h.propertyId,
      serviceId: dropInService,
      startsOn: shift(30),
      endsOn: shift(33),
      petIds: [h.petId],
      windows: [{ earliest: "08:00", latest: "10:00" }],
      care,
    },
  });
  expect(r.error).toBeNull();
  return r.data as string;
}

async function card(petId: string) {
  const r = await org.admin
    .from("pet_care_instructions")
    .select("feeding, meds, other_care, client_updated_at, client_updated_stay_id, updated_by")
    .eq("pet_id", petId)
    .single();
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

async function staged(stayId: string) {
  const r = await org.admin.from("stays").select("requested_care").eq("id", stayId).single();
  if (r.error) throw new Error(r.error.message);
  return r.data.requested_care;
}

describe.skipIf(!dbEnabled)("a client's care edit waits for the office", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Care edit");
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

  it("a portal med edit leaves the live card unchanged and is staged on the request", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "Half a cup", meds: DECEMBER, otherCare: "Litter daily" },
    ]);
    const live = await card(h.petId);
    expect(live.meds).toEqual(TONIGHT);
    expect(live.client_updated_at).toBeNull();
    // Only the field that changed is staged.
    expect(await staged(stayId)).toEqual([{ pet_id: h.petId, meds: DECEMBER }]);
  });

  it("the office confirm applies it and marks it as the client's", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "Half a cup", meds: DECEMBER, otherCare: "Litter daily" },
    ]);
    const ok = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
    expect(ok.error).toBeNull();
    const live = await card(h.petId);
    expect(live.meds).toEqual(DECEMBER);
    expect(live.feeding).toBe("Half a cup");
    expect(live.other_care).toBe("Litter daily");
    expect(live.client_updated_at).not.toBeNull();
    expect(live.client_updated_stay_id).toBe(stayId);
    expect(live.updated_by).toBe(org.owner.userId);
    // The booking's snapshot is what the sitter will read.
    const st = await org.admin.from("stays").select("care_snapshot").eq("id", stayId).single();
    expect((st.data!.care_snapshot as Array<{ meds: unknown }>)[0].meds).toEqual(DECEMBER);
  });

  it("an office edit to a field the client did not change survives the confirm", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "Half a cup", meds: DECEMBER, otherCare: "Litter daily" },
    ]);
    const edit = await org.admin
      .from("pet_care_instructions")
      .update({ feeding: "Wet food at 6" })
      .eq("pet_id", h.petId);
    expect(edit.error).toBeNull();
    const ok = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
    expect(ok.error).toBeNull();
    const live = await card(h.petId);
    expect(live.feeding).toBe("Wet food at 6");
    expect(live.meds).toEqual(DECEMBER);
  });

  it("a canceled request never touches the card", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "", meds: DECEMBER, otherCare: "" },
    ]);
    const cancel = await org.admin.from("stays").update({ status: "canceled" }).eq("id", stayId);
    expect(cancel.error).toBeNull();
    const again = await org.owner.client.rpc("confirm_stay", {
      _stay_id: stayId,
      _deposit_cents: 0,
    });
    expect(again.error?.message).toMatch(/Only a requested stay can be confirmed/);
    const live = await card(h.petId);
    expect(live).toMatchObject({
      feeding: "Half a cup",
      meds: TONIGHT,
      other_care: "Litter daily",
    });
    expect(live.client_updated_at).toBeNull();
  });

  it("a request with no care changes stages nothing and confirms as before", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "Half a cup", meds: TONIGHT, otherCare: "Litter daily" },
    ]);
    expect(await staged(stayId)).toBeNull();
    const ok = await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 });
    expect(ok.error).toBeNull();
    const live = await card(h.petId);
    expect(live.meds).toEqual(TONIGHT);
    expect(live.client_updated_at).toBeNull();
  });

  it("an office edit after the confirm clears the client marker", async () => {
    const h = await home();
    const stayId = await request(h, [
      { petId: h.petId, feeding: "Half a cup", meds: DECEMBER, otherCare: "Litter daily" },
    ]);
    expect(
      (await org.owner.client.rpc("confirm_stay", { _stay_id: stayId, _deposit_cents: 0 })).error,
    ).toBeNull();
    expect((await card(h.petId)).client_updated_at).not.toBeNull();
    const edit = await org.admin
      .from("pet_care_instructions")
      .update({ other_care: "Litter twice a day" })
      .eq("pet_id", h.petId);
    expect(edit.error).toBeNull();
    const live = await card(h.petId);
    expect(live.client_updated_at).toBeNull();
    expect(live.client_updated_stay_id).toBeNull();
  });

  it("refuses an invalid medication when sent, not at the confirm", async () => {
    const h = await home();
    const r = await org.admin.rpc("portal_request_stay", {
      _org_id: org.orgId,
      _client_id: h.clientId,
      _request_key: randomUUID(),
      _input: {
        propertyId: h.propertyId,
        serviceId: dropInService,
        startsOn: shift(30),
        endsOn: shift(31),
        petIds: [h.petId],
        windows: [{ earliest: "08:00", latest: "10:00" }],
        care: [{ petId: h.petId, meds: [{ name: "Insulin", times: ["8am"] }] }],
      },
    });
    expect(r.error?.message).toMatch(/Check the care instructions/);
  });
});
