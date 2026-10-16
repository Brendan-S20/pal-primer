// A missed dose tells the office (#411).
//
// When a sitter logs a medication as missed, recordCareEntry calls
// notifyMissedMed after record_care_entry returns, and the office (owner,
// office manager, dispatcher) gets a notification naming the pet, the med and
// the reason. Sent from the app through notifyRoles rather than from SQL, so
// it reaches a phone; keyed by the entry, so a replayed entry tells nobody
// twice. Driven here with the service-role read and notifyRoles stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";

let row: Record<string, unknown> | null = null;
const notifyRoles = vi.fn(async (_roles: string[], _n: Record<string, unknown>) => ({
  inserted: ["u1", "u2"],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const chain: any = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: row, error: null }),
  };
  return { supabaseAdmin: chain };
});
vi.mock("@/lib/notify-center.server", () => ({ notifyRoles }));

const missed = (over: Record<string, unknown> = {}) => ({
  id: "entry-1",
  organization_id: "org-1",
  kind: "meds",
  status: "missed",
  med_name: "Insulin",
  missed_reason: "She would not come out from under the bed",
  dogs: { name: "Luna" },
  staff: [{ display_name: "Taylor" }],
  visits: {
    id: "visit-1",
    scheduled_on: "2026-10-19",
    assigned_staff_id: "staff-1",
    clients: { display_name: "Jane Doe" },
  },
  ...over,
});

describe("a missed dose", () => {
  beforeEach(() => {
    notifyRoles.mockClear();
    row = null;
  });

  it("tells the people who run the day, naming the pet, the med and the reason", async () => {
    const { notifyMissedMed } = await import("@/lib/sit-notify.server");
    row = missed();
    const r = await notifyMissedMed({ entryId: "entry-1", actorUserId: "sitter-user" });
    expect(r.told).toBe(2);
    expect(notifyRoles).toHaveBeenCalledTimes(1);
    const [roles, n] = notifyRoles.mock.calls[0];
    expect(roles).toEqual(["owner", "office_manager", "dispatcher"]);
    expect(n).toMatchObject({
      orgId: "org-1",
      type: "missed_meds",
      title: "Taylor missed Luna's Insulin",
      body: "She would not come out from under the bed. Jane Doe",
      // Once per entry, however many times it is replayed.
      eventKey: "missed_med:entry-1",
      collapseId: "missed_med:entry-1",
      // The sitter who logged it is not told of their own entry.
      exceptUserId: "sitter-user",
      threadId: "route:staff-1:2026-10-19",
    });
    expect(String(n.link)).toContain("2026-10-19");
  });

  it("tells nobody of a dose that was given, or of anything that is not a med", async () => {
    const { notifyMissedMed } = await import("@/lib/sit-notify.server");
    row = missed({ status: "done", missed_reason: null });
    expect((await notifyMissedMed({ entryId: "entry-1", actorUserId: null })).told).toBe(0);
    row = missed({ kind: "feed", med_name: null });
    expect((await notifyMissedMed({ entryId: "entry-1", actorUserId: null })).told).toBe(0);
    row = null;
    expect((await notifyMissedMed({ entryId: "gone", actorUserId: null })).told).toBe(0);
    expect(notifyRoles).not.toHaveBeenCalled();
  });

  it("never throws: the entry is already logged", async () => {
    const { notifyMissedMed } = await import("@/lib/sit-notify.server");
    row = missed();
    notifyRoles.mockRejectedValueOnce(new Error("push down"));
    await expect(notifyMissedMed({ entryId: "entry-1", actorUserId: null })).resolves.toEqual({
      told: 0,
    });
  });
});
