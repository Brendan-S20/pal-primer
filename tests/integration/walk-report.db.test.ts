/** record_walk_report against a database built from the migrations (#410):
 *  the assigned walker and the office can write a walk's report; another
 *  walker and anyone signed out cannot.
 *
 *  Local stack only; skipped without TEST_SUPABASE_* env. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, makeWalkOrg, makeWalkVisit, type WalkOrg } from "../support/walk-db";

let org: WalkOrg;
let visitId: string;

const report = (
  client: WalkOrg["walker"]["client"],
  over: Partial<{ _pee: boolean | null; _poo: boolean | null; _report_note: string | null }> = {},
  id = visitId,
) =>
  client.rpc("record_walk_report", {
    _visit_id: id,
    _pee: true,
    _poo: false,
    _report_note: "  Good walk.  ",
    ...over,
  });

const stored = async () => {
  const { data, error } = await org.admin
    .from("visits")
    .select("pee, poo, report_note")
    .eq("id", visitId)
    .single();
  if (error) throw new Error(error.message);
  return data;
};

describe.skipIf(!dbEnabled)("record_walk_report", () => {
  beforeAll(async () => {
    org = await makeWalkOrg("Walk report");
    ({ visitId } = await makeWalkVisit(org, { assignedStaffId: org.walker.staffId }));
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  it("starts unset: not recorded is not no", async () => {
    expect(await stored()).toEqual({ pee: null, poo: null, report_note: null });
  });

  it("the assigned walker can record it, with the note trimmed", async () => {
    const { error } = await report(org.walker.client);
    expect(error).toBeNull();
    expect(await stored()).toEqual({ pee: true, poo: false, report_note: "Good walk." });
  });

  it("another walker cannot", async () => {
    const { error } = await report(org.otherWalker.client, { _pee: false, _report_note: "no" });
    expect(error).not.toBeNull();
    expect((await stored()).report_note).toBe("Good walk.");
  });

  it("nobody signed out can", async () => {
    const { error } = await report(org.anon, { _report_note: "anon" });
    expect(error).not.toBeNull();
    expect((await stored()).report_note).toBe("Good walk.");
  });

  it("the office can, and an empty note is stored as none", async () => {
    const { error } = await report(org.owner.client, { _poo: null, _report_note: "   " });
    expect(error).toBeNull();
    expect(await stored()).toEqual({ pee: true, poo: null, report_note: null });
  });

  it("refuses a note over 500 characters", async () => {
    const { error } = await report(org.walker.client, { _report_note: "x".repeat(501) });
    expect(error).not.toBeNull();
  });

  it("works once the walk is completed, and refuses one that was cancelled", async () => {
    const done = await org.admin
      .from("visits")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", visitId);
    expect(done.error).toBeNull();
    expect((await report(org.walker.client, { _report_note: "Late note." })).error).toBeNull();
    expect((await stored()).report_note).toBe("Late note.");

    const cancelled = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      status: "canceled",
    });
    const { error } = await report(org.walker.client, {}, cancelled.visitId);
    expect(error).not.toBeNull();
  });
});
