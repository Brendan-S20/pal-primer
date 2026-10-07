import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  userRoles: [] as any[],
  prefs: [] as any[],
  inserted: [] as any[],
  pushed: [] as Array<{ userId: string; payload: any }>,
  // The database before 20261004150000: no thread_id or event_key yet.
  schemaBehind: false,
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
    const behind = { code: "PGRST204", message: "Could not find the 'thread_id' column" };
    return {
      insert: (rows: any[]) => {
        if (h.schemaBehind && rows.some((r) => "thread_id" in r || "event_key" in r)) {
          return Promise.resolve({ error: behind });
        }
        h.inserted.push(...rows);
        return Promise.resolve({ error: null });
      },
      upsert: (rows: any[]) => ({
        select: () => {
          if (h.schemaBehind) return Promise.resolve({ data: null, error: behind });
          h.inserted.push(...rows);
          return Promise.resolve({ data: rows.map((r) => ({ recipient_user_id: r.recipient_user_id })), error: null });
        },
      }),
    };
  }
  return { supabaseAdmin: { from } };
});

import { notifyUsers, notifyRoles, resetNotifyMemoForTests } from "@/lib/notify-center.server";

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
  h.schemaBehind = false;
  resetNotifyMemoForTests();
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

describe("notifyUsers on a database the migration has not reached yet", () => {
  // The app deploys on merge and 20261004150000 is applied after it. For
  // those minutes a notification must go out the old way, not not at all.
  it("an event-keyed notification falls back to a plain row, and still pushes", async () => {
    h.schemaBehind = true;
    await notifyUsers(["u1"], { ...BASE, eventKey: "skip:v1", threadId: "route:s:d" });
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).not.toHaveProperty("event_key");
    expect(h.inserted[0]).not.toHaveProperty("thread_id");
    expect(h.pushed.map((p) => p.userId)).toEqual(["u1"]);
  });

  it("a threaded notification is retried without its thread", async () => {
    h.schemaBehind = true;
    await notifyUsers(["u1"], { ...BASE, threadId: "route:s:d", collapseId: "c" });
    expect(h.inserted).toHaveLength(1);
    expect(h.pushed[0].payload).toMatchObject({ threadId: "route:s:d", collapseId: "c" });
  });
});

describe("notifyUsers, the person who acted", () => {
  it("is never a recipient", async () => {
    await notifyUsers(["u1", "u2"], { ...BASE, exceptUserId: "u2" });
    expect(h.inserted.map((r) => r.recipient_user_id)).toEqual(["u1"]);
    expect(h.pushed.map((p) => p.userId)).toEqual(["u1"]);
  });

  it("push: false keeps a row in the centre and off the phone", async () => {
    await notifyUsers(["u1"], { ...BASE, push: false });
    expect(h.inserted).toHaveLength(1);
    expect(h.pushed).toHaveLength(0);
  });
});
