/** The walk-canceled email against a database built from the migrations
 *  (#410): the switch is on for a new business and can be turned off, and a
 *  walk the office cancels reads back, through the sender's own columns, as
 *  a skipped dog walk, which is what notifyWalksCanceled sends for.
 *
 *  Local stack only; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, makeWalkOrg, makeWalkVisit, type WalkOrg } from "../support/walk-db";
import { VISIT_COLUMNS } from "@/lib/walk-notify.server";

let org: WalkOrg;

describe.skipIf(!dbEnabled)("the walk-canceled switch and what the sender reads", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Walk canceled");
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  it("is on for a new business, and can be turned off", async () => {
    const read = async () => {
      const { data, error } = await org.admin
        .from("organizations")
        .select("notify_email_walk_canceled")
        .eq("id", org.orgId)
        .single();
      if (error) throw new Error(error.message);
      return (data as { notify_email_walk_canceled: boolean }).notify_email_walk_canceled;
    };
    expect(await read()).toBe(true);
    const off = await org.admin
      .from("organizations")
      .update({ notify_email_walk_canceled: false })
      .eq("id", org.orgId);
    expect(off.error).toBeNull();
    expect(await read()).toBe(false);
    const nul = await org.admin
      .from("organizations")
      .update({ notify_email_walk_canceled: null })
      .eq("id", org.orgId);
    expect(nul.error).not.toBeNull();
    await org.admin
      .from("organizations")
      .update({ notify_email_walk_canceled: true })
      .eq("id", org.orgId);
  });

  it("an office cancel leaves a skipped dog walk the sender can read", async () => {
    const { visitId } = await makeWalkVisit(org);
    const { error } = await org.owner.client.rpc("office_skip_visit", {
      _visit_id: visitId,
      _reason: "Client away this week",
      _code: "other",
    });
    expect(error).toBeNull();
    const { data, error: readError } = await org.admin
      .from("visits")
      .select(VISIT_COLUMNS)
      .eq("id", visitId)
      .single();
    expect(readError).toBeNull();
    const v = data as any;
    expect(v.status).toBe("skipped");
    const service = Array.isArray(v.services) ? v.services[0] : v.services;
    expect(service.service_line).toBe("dog_walking");
    const prop = Array.isArray(v.properties) ? v.properties[0] : v.properties;
    expect(prop.dogs.length).toBe(1);
  });

  it("another business's owner cannot cancel it", async () => {
    const { visitId } = await makeWalkVisit(org);
    const other = await makeWalkOrg("Walk canceled other");
    try {
      const { error } = await other.owner.client.rpc("office_skip_visit", {
        _visit_id: visitId,
        _reason: "x",
        _code: "other",
      });
      expect(error).not.toBeNull();
    } finally {
      await other.cleanup();
    }
  });
});
