/** A gate code or lock box code is read by the walker assigned there today
 *  and the office, nobody else (#410).
 *
 *  Plain SELECT of gate_code, lock_box_code, key_location and key_tag is
 *  revoked. may_read_property_row is unchanged, so the rest of the row still
 *  follows it. property_access_codes is the only read path for the four
 *  columns. For a walk client the gate code is often the door code.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbEnabled,
  makeWalkOrg,
  makeWalkVisit,
  setStaffActive,
  type WalkOrg,
} from "../support/walk-db";

let org: WalkOrg;
let propertyId: string;
let pastPropertyId: string;
let futurePropertyId: string;

function shiftDay(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe.skipIf(!dbEnabled)("who can read a lock box code", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Walk access");
    ({ propertyId } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "4471",
      gateCode: "*8080#",
    }));
    await org.admin.from("properties").update({ key_location: "Blue pot" }).eq("id", propertyId);

    const past = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "1111",
      gateCode: "*1111#",
    });
    const future = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "2222",
    });
    const movedPast = await org.admin
      .from("visits")
      .update({ scheduled_on: shiftDay(-1) })
      .eq("id", past.visitId);
    const movedFuture = await org.admin
      .from("visits")
      .update({ scheduled_on: shiftDay(1) })
      .eq("id", future.visitId);
    if (movedPast.error) throw new Error(movedPast.error.message);
    if (movedFuture.error) throw new Error(movedFuture.error.message);
    pastPropertyId = past.propertyId;
    futurePropertyId = future.propertyId;
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  const secrets = (who: WalkOrg["walker"]) =>
    who.client.from("properties").select("lock_box_code, key_location, key_tag").eq("id", propertyId);

  const codes = (who: WalkOrg["walker"], ids: string[]) =>
    who.client.rpc("property_access_codes", { _property_ids: ids });

  it("refuses a plain select of the codes, including for the office and today's walker", async () => {
    for (const who of [org.walker, org.owner, org.otherWalker]) {
      const { data, error } = await secrets(who);
      expect(error).not.toBeNull();
      expect(data ?? []).toEqual([]);
    }
  });

  it("refuses a plain select of the gate code, including for the office and today's walker", async () => {
    for (const who of [org.walker, org.owner, org.otherWalker]) {
      const { data, error } = await who.client
        .from("properties")
        .select("gate_code")
        .eq("id", propertyId);
      expect(error).not.toBeNull();
      expect(data ?? []).toEqual([]);
    }
  });

  it("refuses an embedded select of the gate code through a visit", async () => {
    const { data, error } = await org.walker.client
      .from("visits")
      .select("id, properties(street, gate_code)")
      .eq("property_id", propertyId);
    expect(error).not.toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("the service role can still read the column", async () => {
    const { data, error } = await org.admin
      .from("properties")
      .select("gate_code, lock_box_code, key_tag")
      .eq("id", propertyId);
    expect(error).toBeNull();
    expect(data?.[0]).toMatchObject({
      gate_code: "*8080#",
      lock_box_code: "4471",
      key_tag: "K-12",
    });
  });

  it("today's walker can still read the rest of the row", async () => {
    const { data, error } = await org.walker.client
      .from("properties")
      .select("street, access_method, key_held")
      .eq("id", propertyId);
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({ access_method: "lockbox", key_held: true }),
    ]);
  });

  it("the office can still write the gate code without asking for it back", async () => {
    const { propertyId: id } = await makeWalkVisit(org, { gateCode: "1234" });
    const { error } = await org.owner.client
      .from("properties")
      .update({ gate_code: "5678" })
      .eq("id", id);
    expect(error).toBeNull();
    const { data } = await org.admin.from("properties").select("gate_code").eq("id", id);
    expect(data?.[0]?.gate_code).toBe("5678");
  });

  it("a walker with no visit there still cannot see the row", async () => {
    const { data, error } = await org.otherWalker.client
      .from("properties")
      .select("street, access_method, key_held")
      .eq("id", propertyId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("nobody signed out can read a code", async () => {
    const plain = await org.anon.from("properties").select("lock_box_code").eq("id", propertyId);
    expect(plain.data ?? []).toEqual([]);
    const gate = await org.anon.from("properties").select("gate_code").eq("id", propertyId);
    expect(gate.data ?? []).toEqual([]);
    const rpc = await org.anon.rpc("property_access_codes", { _property_ids: [propertyId] });
    expect(rpc.error).not.toBeNull();
    expect(rpc.data ?? []).toEqual([]);
  });

  it("today's walker and the office get the codes from the function", async () => {
    for (const who of [org.walker, org.owner]) {
      const { data, error } = await codes(who, [propertyId]);
      expect(error).toBeNull();
      expect(data).toEqual([
        expect.objectContaining({
          property_id: propertyId,
          gate_code: "*8080#",
          lock_box_code: "4471",
          key_location: "Blue pot",
          key_tag: "K-12",
        }),
      ]);
    }
  });

  it("a walker with only a past or future visit gets no code", async () => {
    const { data, error } = await codes(org.walker, [pastPropertyId, futurePropertyId]);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("a walker with only a past visit gets no gate code from either path", async () => {
    // The row itself is still readable: may_read_property_row has no date limit.
    const row = await org.walker.client
      .from("properties")
      .select("street")
      .eq("id", pastPropertyId);
    expect(row.error).toBeNull();
    expect(row.data).toHaveLength(1);

    const plain = await org.walker.client
      .from("properties")
      .select("street, gate_code")
      .eq("id", pastPropertyId);
    expect(plain.error).not.toBeNull();
    expect(plain.data ?? []).toEqual([]);

    const rpc = await codes(org.walker, [pastPropertyId]);
    expect(rpc.error).toBeNull();
    expect(rpc.data ?? []).toEqual([]);
  });

  it("a walker with a scheduled visit today gets the gate code from the function", async () => {
    const { propertyId: id } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      gateCode: "*2468#",
    });
    const { data, error } = await codes(org.walker, [id]);
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ property_id: id, gate_code: "*2468#" })]);
  });

  it("a visit today that is canceled or skipped gives no code", async () => {
    for (const status of ["canceled", "skipped"]) {
      const { propertyId: id } = await makeWalkVisit(org, {
        assignedStaffId: org.walker.staffId,
        lockBoxCode: "3333",
        status,
      });
      const { data, error } = await codes(org.walker, [id]);
      expect(error).toBeNull();
      expect(data ?? []).toEqual([]);
    }
  });

  it("a visit today that is in progress still gives the code", async () => {
    const { propertyId: id } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "5555",
      status: "in_progress",
    });
    const { data, error } = await codes(org.walker, [id]);
    expect(error).toBeNull();
    expect(data).toEqual([expect.objectContaining({ property_id: id, lock_box_code: "5555" })]);
  });

  it("a visit today that was completed no longer gives the code", async () => {
    const { propertyId: id, visitId } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "6666",
    });
    const before = await codes(org.walker, [id]);
    expect(before.data).toEqual([expect.objectContaining({ lock_box_code: "6666" })]);
    const done = await org.admin
      .from("visits")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", visitId);
    if (done.error) throw new Error(done.error.message);
    const after = await codes(org.walker, [id]);
    expect(after.error).toBeNull();
    expect(after.data ?? []).toEqual([]);
  });

  it("a walker who was turned off gets no code for a scheduled visit today", async () => {
    const off = await makeWalkOrg("Walk access off");
    try {
      const { propertyId: id } = await makeWalkVisit(off, {
        assignedStaffId: off.walker.staffId,
        lockBoxCode: "7777",
      });
      const on = await codes(off.walker, [id]);
      expect(on.data).toEqual([expect.objectContaining({ lock_box_code: "7777" })]);
      await setStaffActive(off, off.walker.staffId!, false);
      const { data } = await codes(off.walker, [id]);
      expect(data ?? []).toEqual([]);
    } finally {
      await off.cleanup();
    }
  });

  it("another walker gets no code", async () => {
    const { data, error } = await codes(org.otherWalker, [propertyId]);
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("refuses an access method the app does not know, and a key tag over 40", async () => {
    const bad = await org.admin
      .from("properties")
      .update({ access_method: "window" })
      .eq("id", propertyId);
    expect(bad.error).not.toBeNull();
    const long = await org.admin
      .from("properties")
      .update({ key_tag: "x".repeat(41) })
      .eq("id", propertyId);
    expect(long.error).not.toBeNull();
  });
});
