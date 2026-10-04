import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userRoles: [] as any[],
  prefs: [] as any[],
  inserted: [] as any[],
  pushed: [] as Array<{ userId: string; payload: any }>,
}));

vi.mock("@/lib/push.server", () => ({
  sendPushToUser: async (userId: string, payload: any) => {
    h.pushed.push({ userId, payload });
    return { sent: 1, failed: 0 };
  },
}));

vi.mock("@/integrations/supabase/client.server", () => {
  function from(table: string) {
    if (table === "user_roles" || table === "app_notification_prefs") {
      const rows = () => (table === "user_roles" ? h.userRoles : h.prefs);
      const p: any = {
        select: () => p,
        eq: () => p,
        in: () => p,
        then: (res: any) => Promise.resolve({ data: rows() }).then(res),
      };
      return p;
    }
    return {
      insert: (rows: any[]) => {
        h.inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
    };
  }
  return { supabaseAdmin: { from } };
});

import { notifyUsers, notifyRoles } from "@/lib/notify-center.server";

const BASE = {
  orgId: "org-1",
  type: "concern",
  title: "New concern",
  body: "b",
  link: "/concerns",
};

beforeEach(() => {
  h.userRoles = [];
  h.prefs = [];
  h.inserted = [];
  h.pushed = [];
});
afterEach(() => vi.clearAllMocks());

describe("notifyUsers", () => {
  it("inserts one row per distinct user and drops falsy ids", async () => {
    await notifyUsers(["u1", "u2", "u1", "", null as any], BASE);
    expect(h.inserted.map((r) => r.recipient_user_id).sort()).toEqual(["u1", "u2"]);
    expect(h.inserted[0]).toMatchObject({
      organization_id: "org-1",
      type: "concern",
      title: "New concern",
      link: "/concerns",
    });
  });

  it("no-ops on an empty recipient list", async () => {
    await notifyUsers([], BASE);
    expect(h.inserted).toHaveLength(0);
  });

  it("drops recipients who muted this notification type", async () => {
    h.prefs = [{ user_id: "u2", muted_types: ["concern"] }];
    await notifyUsers(["u1", "u2"], BASE); // BASE.type === "concern"
    expect(h.inserted.map((r) => r.recipient_user_id)).toEqual(["u1"]);
  });
});

describe("notifyUsers → push", () => {
  // sendPushToUser had no caller before this: the iOS app registered a token
  // on every launch and nothing was ever sent to it.
  it("pushes the same notification to each recipient, deep-linked to its row's link", async () => {
    await notifyUsers(["u1", "u2"], BASE);
    expect(h.pushed.map((p) => p.userId).sort()).toEqual(["u1", "u2"]);
    expect(h.pushed[0].payload).toEqual({
      title: "New concern",
      body: "b",
      url: "/concerns",
      data: { type: "concern" },
    });
  });

  it("does not push to someone who muted the type", async () => {
    h.prefs = [{ user_id: "u2", muted_types: ["concern"] }];
    await notifyUsers(["u1", "u2"], BASE);
    expect(h.pushed.map((p) => p.userId)).toEqual(["u1"]);
  });

  it("keeps informational types in the notification centre only", async () => {
    await notifyUsers(["u1"], { ...BASE, type: "schedule.horizon" });
    await notifyUsers(["u1"], { ...BASE, type: "payout_paid" });
    expect(h.inserted).toHaveLength(2);
    expect(h.pushed).toHaveLength(0);
  });

  it("falls back to the notification centre when a row has no link", async () => {
    await notifyUsers(["u1"], { ...BASE, link: null });
    expect(h.pushed[0].payload.url).toBe("/notifications");
  });
});

describe("notifyRoles", () => {
  it("fans out to every user holding one of the roles", async () => {
    h.userRoles = [
      { user_id: "owner-1", role: "owner" },
      { user_id: "mgr-1", role: "office_manager" },
    ];
    await notifyRoles(["owner", "office_manager"], BASE);
    expect(h.inserted.map((r) => r.recipient_user_id).sort()).toEqual(["mgr-1", "owner-1"]);
  });

  it("no-ops when no users hold the roles", async () => {
    h.userRoles = [];
    await notifyRoles(["owner"], BASE);
    expect(h.inserted).toHaveLength(0);
  });
});
