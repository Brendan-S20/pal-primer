/** A lock box code is read by the walker on a visit there and the office,
 *  nobody else (#410). RLS (may_read_property_row) is unchanged; this proves
 *  it holds for the new access columns too.
 *
 *  Local stack only. CI builds the database from migrations before running
 *  this suite; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, makeWalkOrg, makeWalkVisit, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let propertyId: string;

describe.skipIf(!dbEnabled)("who can read a lock box code", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Walk access");
    ({ propertyId } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "4471",
    }));
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  const read = (who: WalkOrg["walker"]) =>
    who.client
      .from("properties")
      .select("lock_box_code, gate_code, key_tag, access_method, key_held")
      .eq("id", propertyId);

  it("the walker with a visit there can", async () => {
    const { data, error } = await read(org.walker);
    expect(error).toBeNull();
    expect(data).toEqual([
      expect.objectContaining({
        lock_box_code: "4471",
        key_tag: "K-12",
        access_method: "lockbox",
        key_held: true,
      }),
    ]);
  });

  it("the office can", async () => {
    const { data, error } = await read(org.owner);
    expect(error).toBeNull();
    expect(data?.[0]?.lock_box_code).toBe("4471");
  });

  it("a walker with no visit there cannot", async () => {
    const { data, error } = await read(org.otherWalker);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("nobody signed out can", async () => {
    const { data } = await org.anon.from("properties").select("lock_box_code").eq("id", propertyId);
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
