import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ userRoles: [] as any[], prefs: [] as any[], inserted: [] as any[] }));

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
