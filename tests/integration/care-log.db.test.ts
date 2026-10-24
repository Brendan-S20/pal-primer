/** record_care_entry and delete_care_entry against a database built from the
 *  migrations (#411, 20261024080200):
 *
 *    * the assigned sitter and the office can log; another sitter and anyone
 *      signed out cannot;
 *    * a pet from another home is refused;
 *    * a med needs its name, and a missed one needs a reason;
 *    * the log is open while a pet sitting visit is under way, not before it
 *      starts and never on a walk;
 *    * a replay with the device's id is the same row;
 *    * an undo works for the same people within 12 hours, and not after.
 *
 *  The office notification for a missed dose is sent by the app, not SQL;
 *  tests/a-missed-dose-tells-the-office.test.ts covers it.
 *
 *  Local stack only; skipped without TEST_SUPABASE_* env. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, insertRow, makeWalkOrg, makeWalkVisit, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
/** The same org, with its pet sitting service in place of the walk. */
let sitOrg: WalkOrg;
let visitId: string;
let lunaId: string;
let strangerPetId: string;

type Entry = Partial<{
  _visit_id: string;
  _pet_id: string | null;
  _kind: string;
  _med_name: string | null;
  _status: string;
  _missed_reason: string | null;
  _note: string | null;
  _at: string;
  _id: string;
}>;

const log = (client: WalkOrg["walker"]["client"], over: Entry = {}) =>
  client.rpc("record_care_entry", {
    _visit_id: visitId,
    _pet_id: lunaId,
    _kind: "feed",
    _med_name: null,
    _status: "done",
    _missed_reason: null,
    _note: null,
    ...over,
  });

const rowsFor = async (id = visitId) => {
  const { data, error } = await org.admin
    .from("care_log")
    .select("id, pet_id, kind, med_name, status, missed_reason, given_by, created_at")
    .eq("visit_id", id);
  if (error) throw new Error(error.message);
  return data as Array<Record<string, any>>;
};

async function petAt(propertyId: string): Promise<string> {
  const { data, error } = await org.admin
    .from("dogs")
    .select("id")
    .eq("property_id", propertyId)
    .limit(1)
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

/** A pet sitting visit at a new home, assigned to the sitter, under way. */
async function sitVisit(status: "in_progress" | "scheduled" = "in_progress") {
  const v = await makeWalkVisit(sitOrg, { assignedStaffId: org.walker.staffId });
  if (status === "in_progress") {
    const { error } = await org.admin
      .from("visits")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", v.visitId);
    if (error) throw new Error(error.message);
  }
  return { ...v, petId: await petAt(v.propertyId) };
}

describe.skipIf(!dbEnabled)("the care log", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Care log");
    await org.admin
      .from("organizations")
      .update({ service_lines: ["pet_sitting", "dog_walking"] })
      .eq("id", org.orgId);
    const sitServiceId = await insertRow(org.admin, "services", {
      organization_id: org.orgId,
      name: "Drop-in visit",
      service_line: "pet_sitting",
      price_unit: "visit",
      base_price_cents: 2500,
      default_duration_min: 30,
    });
    sitOrg = { ...org, serviceId: sitServiceId };
    const home = await sitVisit();
    visitId = home.visitId;
    lunaId = home.petId;
    const elsewhere = await makeWalkVisit(sitOrg, { assignedStaffId: org.walker.staffId });
    strangerPetId = await petAt(elsewhere.propertyId);
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  it("the assigned sitter can log, and the entry names them", async () => {
    const { data, error } = await log(org.walker.client);
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
    const rows = await rowsFor();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: data,
      kind: "feed",
      status: "done",
      given_by: org.walker.staffId,
    });
  });

  it("another sitter cannot, and nobody signed out can", async () => {
    expect((await log(org.otherWalker.client, { _kind: "water" })).error).not.toBeNull();
    expect((await log(org.anon, { _kind: "water" })).error).not.toBeNull();
    expect((await rowsFor()).filter((r) => r.kind === "water")).toHaveLength(0);
  });

  it("the office can", async () => {
    const { error } = await log(org.owner.client, { _kind: "litter", _pet_id: null });
    expect(error).toBeNull();
    expect((await rowsFor()).some((r) => r.kind === "litter" && r.pet_id === null)).toBe(true);
  });

  it("refuses a pet from another home", async () => {
    const { error } = await log(org.walker.client, { _pet_id: strangerPetId, _kind: "water" });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/does not live at this home/);
  });

  it("a med needs its name", async () => {
    const { error } = await log(org.walker.client, { _kind: "meds", _med_name: "  " });
    expect(error).not.toBeNull();
  });

  it("a missed dose needs a reason, and is stored with it", async () => {
    const without = await log(org.walker.client, {
      _kind: "meds",
      _med_name: "Insulin",
      _status: "missed",
      _missed_reason: "   ",
    });
    expect(without.error).not.toBeNull();
    expect(without.error!.message).toMatch(/Say why it was missed/);

    const tooLong = await log(org.walker.client, {
      _kind: "meds",
      _med_name: "Insulin",
      _status: "missed",
      _missed_reason: "x".repeat(301),
    });
    expect(tooLong.error).not.toBeNull();

    const withReason = await log(org.walker.client, {
      _kind: "meds",
      _med_name: " Insulin ",
      _status: "missed",
      _missed_reason: "  She hid under the bed  ",
    });
    expect(withReason.error).toBeNull();
    const row = (await rowsFor()).find((r) => r.id === withReason.data);
    expect(row).toMatchObject({
      kind: "meds",
      med_name: "Insulin",
      status: "missed",
      missed_reason: "She hid under the bed",
    });
  });

  it("drops a reason sent with a dose that was given", async () => {
    const { data, error } = await log(org.walker.client, {
      _kind: "meds",
      _med_name: "Apoquel",
      _missed_reason: "not missed",
    });
    expect(error).toBeNull();
    expect((await rowsFor()).find((r) => r.id === data)?.missed_reason).toBeNull();
  });

  it("a replay with the device's id is the same row", async () => {
    const id = randomUUID();
    const first = await log(org.walker.client, { _kind: "water", _id: id });
    const again = await log(org.walker.client, { _kind: "water", _id: id });
    expect(first.error).toBeNull();
    expect(again.error).toBeNull();
    expect(first.data).toBe(id);
    expect(again.data).toBe(id);
    expect((await rowsFor()).filter((r) => r.id === id)).toHaveLength(1);
  });

  it("is closed before the visit starts, and never open on a walk", async () => {
    const notYet = await sitVisit("scheduled");
    expect(
      (await log(org.walker.client, { _visit_id: notYet.visitId, _pet_id: notYet.petId })).error,
    ).not.toBeNull();

    const walk = await makeWalkVisit(org, { assignedStaffId: org.walker.staffId });
    await org.admin
      .from("visits")
      .update({ status: "in_progress", started_at: new Date().toISOString() })
      .eq("id", walk.visitId);
    const { error } = await log(org.walker.client, {
      _visit_id: walk.visitId,
      _pet_id: await petAt(walk.propertyId),
    });
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/Only a pet sitting visit/);
  });

  it("the sitter can read what was logged, and nobody signed out can", async () => {
    const mine = await org.walker.client.from("care_log").select("id").eq("visit_id", visitId);
    expect(mine.error).toBeNull();
    expect((mine.data ?? []).length).toBeGreaterThan(0);
    const anon = await org.anon.from("care_log").select("id").eq("visit_id", visitId);
    expect(anon.data ?? []).toHaveLength(0);
  });

  it("a signed-in user cannot write the table directly", async () => {
    const { error } = await org.walker.client.from("care_log").insert({
      organization_id: org.orgId,
      visit_id: visitId,
      pet_id: lunaId,
      kind: "feed",
    });
    expect(error).not.toBeNull();
  });

  it("an undo works for the sitter, not another sitter, and only within 12 hours", async () => {
    const { data: id } = await log(org.walker.client, { _kind: "walk" });
    expect(typeof id).toBe("string");

    expect(
      (await org.otherWalker.client.rpc("delete_care_entry", { _id: id })).error,
    ).not.toBeNull();
    expect((await rowsFor()).some((r) => r.id === id)).toBe(true);

    expect((await org.walker.client.rpc("delete_care_entry", { _id: id })).error).toBeNull();
    expect((await rowsFor()).some((r) => r.id === id)).toBe(false);
    // Already gone: the same undo again is harmless.
    expect((await org.walker.client.rpc("delete_care_entry", { _id: id })).error).toBeNull();

    const { data: old } = await log(org.walker.client, { _kind: "water" });
    const aged = await org.admin
      .from("care_log")
      .update({ created_at: new Date(Date.now() - 13 * 3_600_000).toISOString() })
      .eq("id", old);
    expect(aged.error).toBeNull();
    const late = await org.walker.client.rpc("delete_care_entry", { _id: old });
    expect(late.error).not.toBeNull();
    expect(late.error!.message).toMatch(/within 12 hours/);
    expect((await rowsFor()).some((r) => r.id === old)).toBe(true);
  });
});
