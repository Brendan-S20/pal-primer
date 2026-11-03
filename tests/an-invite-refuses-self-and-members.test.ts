// An invite refuses yourself and your own team, and asks before it replaces
// one (R2-32).
//
// createOrgInvite took any address. The owner could invite their own email,
// or a teammate already on the team; and inviting an address with a pending
// invite under another role silently revoked it and sent a new link as the
// new role. Now: your own address and anyone on the team are refused in plain
// words, a pending invite under the same role is resent (same link, 14 more
// days), and one under a different role is replaced only after the person
// says yes. All of it is decided on the server.

/* eslint-disable @typescript-eslint/no-explicit-any -- chainable fakes of the Supabase and TanStack builders */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  inviteDecision,
  memberInviteRefusal,
  replaceInviteQuestion,
  selfInviteRefusal,
} from "@/lib/invite-copy";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DAY = 24 * 60 * 60 * 1000;

type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  members: [] as Row[],
  writes: [] as Array<{ table: string; op: string; values: Row | null; filters: Row }>,
  callerRole: "owner",
  callerEmail: "olivia@acme.test" as string | undefined,
}));

function chain(table: string) {
  const filters: Row = {};
  let op = "select";
  let values: Row | null = null;
  const rows = () =>
    (state.tables[table] ?? []).filter((r) =>
      Object.entries(filters).every(([k, v]) => r[k] === v),
    );
  const write = () => state.writes.push({ table, op, values, filters: { ...filters } });
  const api: any = {
    select: () => api,
    eq: (k: string, v: unknown) => ((filters[k] = v), api),
    update: (v: Row) => ((op = "update"), (values = v), api),
    insert: (v: Row) => ((op = "insert"), (values = v), api),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => {
      write();
      return { data: { id: "new-invite", token: "n".repeat(48) }, error: null };
    },
    then: (res: any, rej: any) => {
      if (op !== "select") {
        write();
        return Promise.resolve({ data: null, error: null }).then(res, rej);
      }
      return Promise.resolve({ data: rows(), error: null }).then(res, rej);
    },
  };
  return api;
}
const db = {
  from: (t: string) => chain(t),
  rpc: async (fn: string) =>
    fn === "list_org_users"
      ? { data: state.members, error: null }
      : { data: null, error: { message: `unexpected rpc ${fn}` } },
};

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown; context: unknown }) => unknown) =>
        (opts: { data?: unknown } = {}) =>
          h({
            data: validate(opts.data),
            context: {
              supabase: db,
              userId: "owner-1",
              claims: { sub: "owner-1", email: state.callerEmail },
            },
          }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  requirePermission: async () => ({ orgId: "org-a", role: state.callerRole }),
  resolveCaller: async () => ({ orgId: "org-a", role: state.callerRole }),
}));
vi.mock("@/lib/team-size.server", () => ({ assertRoomForAnotherUser: async () => {} }));
const sent = vi.hoisted(() => [] as Array<{ email: string; role: string; token?: string }>);
vi.mock("@/lib/invite-email.server", () => ({
  sendInviteEmail: async (_org: string, email: string, role: string, token?: string) => {
    sent.push({ email, role, token });
    return true;
  },
}));
vi.mock("@/lib/app-origin", () => ({ appUrl: (p: string) => `https://app.test${p}` }));

const PENDING_ID = "00000000-0000-4000-8000-000000000001";
const OLD_TOKEN = "o".repeat(48);

beforeEach(() => {
  state.writes = [];
  sent.length = 0;
  state.callerRole = "owner";
  state.callerEmail = "olivia@acme.test";
  state.members = [
    { email: "olivia@acme.test", role: "owner", active: true },
    { email: "Tom.Tech@acme.test", role: "tech", active: true },
    { email: "gone@acme.test", role: "dispatcher", active: false },
  ];
  state.tables = {
    organizations: [{ id: "org-a", name: "Acme Scoops", slug: "acme" }],
    org_invites: [
      {
        id: PENDING_ID,
        organization_id: "org-a",
        email: "pat@example.com",
        role: "tech",
        status: "pending",
        token: OLD_TOKEN,
        expires_at: new Date(Date.now() + 3 * DAY).toISOString(),
        created_at: "2026-11-01T10:00:00Z",
      },
    ],
  };
});

const invite = async (data: Row) => {
  const { createOrgInvite } = await import("@/lib/users.functions");
  return (createOrgInvite as any)({ data });
};

describe("the rule (inviteDecision)", () => {
  const base = {
    role: "tech",
    callerEmail: "olivia@acme.test",
    callerIsOwner: true,
    members: [{ email: "tom@acme.test", role: "tech", active: true }],
    pending: [{ id: "p1", email: "Pat@Example.com", role: "tech", created_at: "2026-11-01" }],
    replace: false,
  };

  it("refuses your own address, in any case", () => {
    expect(inviteDecision({ ...base, email: "OLIVIA@acme.test" })).toEqual({
      kind: "refuse",
      message: selfInviteRefusal("OLIVIA@acme.test"),
    });
  });

  it("refuses somebody already on the team", () => {
    const d = inviteDecision({ ...base, email: "TOM@acme.test" });
    expect(d.kind).toBe("refuse");
  });

  it("resends a pending invite under the same role, ignoring case", () => {
    expect(inviteDecision({ ...base, email: "pat@example.com" })).toMatchObject({
      kind: "resend",
      invite: { id: "p1" },
    });
  });

  it("asks before replacing one under another role, and replaces only on yes", () => {
    expect(
      inviteDecision({ ...base, email: "pat@example.com", role: "office_manager" }),
    ).toMatchObject({
      kind: "ask",
      invite: { id: "p1", role: "tech" },
    });
    expect(
      inviteDecision({ ...base, email: "pat@example.com", role: "office_manager", replace: true }),
    ).toMatchObject({ kind: "create", supersede: [{ id: "p1" }] });
  });

  it("a fresh address is a new invite that supersedes nothing", () => {
    expect(inviteDecision({ ...base, email: "new@example.com" })).toEqual({
      kind: "create",
      supersede: [],
    });
  });
});

describe("the words", () => {
  it("say what is wrong and what to do instead", () => {
    expect(selfInviteRefusal("o@a.test")).toBe(
      "o@a.test is your own email address. You're already on this team, so there's no one to invite.",
    );
    expect(
      memberInviteRefusal({ email: "t@a.test", role: "tech", active: true, callerIsOwner: true }),
    ).toBe(
      "t@a.test is already on this team as Technician, so there's no one to invite. To change their role, use the role menu next to their name above.",
    );
    // Role changes are owner-only (#697), so an office manager is told to ask.
    expect(
      memberInviteRefusal({ email: "t@a.test", role: "tech", active: true, callerIsOwner: false }),
    ).toContain("To change their role, ask an owner.");
    expect(
      memberInviteRefusal({
        email: "g@a.test",
        role: "dispatcher",
        active: false,
        callerIsOwner: false,
      }),
    ).toBe(
      "g@a.test is already on this team as Dispatcher, but turned off, so an invite would not let them in. Ask an owner to turn them back on instead.",
    );
  });

  it("the replace question names both roles", () => {
    const q = replaceInviteQuestion("x@a.test", "tech", "office_manager");
    expect(q.title).toBe(
      "There's already a pending invite for x@a.test as Technician. Replace it with Office manager?",
    );
    expect(q.description).toContain("The link in the first invite stops working");
    expect(q.confirmLabel).toBe("Replace with Office manager");
    expect(q.cancelLabel).toBe("Keep the first invite");
  });
});

describe("createOrgInvite enforces it on the server", () => {
  it("refuses your own address and writes nothing", async () => {
    await expect(invite({ email: "Olivia@Acme.test", role: "tech" })).rejects.toThrow(
      "olivia@acme.test is your own email address.",
    );
    expect(state.writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses an active member, matched without case, and writes nothing", async () => {
    await expect(invite({ email: "tom.tech@acme.test", role: "office_manager" })).rejects.toThrow(
      "tom.tech@acme.test is already on this team as Technician",
    );
    expect(state.writes).toEqual([]);
  });

  it("refuses a member who is turned off, pointing at Turn on", async () => {
    await expect(invite({ email: "gone@acme.test", role: "dispatcher" })).rejects.toThrow(
      "but turned off",
    );
    expect(state.writes).toEqual([]);
  });

  it("refuses an existing member even when the token carries no email", async () => {
    state.callerEmail = undefined;
    await expect(invite({ email: "olivia@acme.test", role: "tech" })).rejects.toThrow(
      "already on this team as Owner",
    );
  });

  it("same role: resends the pending invite with its own link, revokes nothing", async () => {
    const r = await invite({ email: "PAT@example.com", role: "tech" });
    expect(r).toMatchObject({ id: PENDING_ID, resent: true, emailSent: true });
    expect(r.link).toBe(`https://app.test/invite/${OLD_TOKEN}`);
    expect(Date.parse(r.expiresAt)).toBeGreaterThan(Date.now() + 13.9 * DAY);
    expect(state.writes).toEqual([
      {
        table: "org_invites",
        op: "update",
        values: { expires_at: r.expiresAt },
        filters: { id: PENDING_ID, organization_id: "org-a" },
      },
    ]);
    expect(sent).toEqual([{ email: "pat@example.com", role: "tech", token: OLD_TOKEN }]);
  });

  it("different role: asks first and writes nothing", async () => {
    const r = await invite({ email: "pat@example.com", role: "office_manager" });
    expect(r).toEqual({
      replaceQuestion: { email: "pat@example.com", currentRole: "tech", role: "office_manager" },
    });
    expect(state.writes).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("different role, answered yes: revokes that invite and sends a new one", async () => {
    const r = await invite({ email: "pat@example.com", role: "office_manager", replace: true });
    expect(r).toMatchObject({ id: "new-invite", resent: false, emailSent: true });
    expect(
      state.writes.map((w) => [w.op, w.values?.status ?? w.values?.role, w.filters.id]),
    ).toEqual([
      ["update", "revoked", PENDING_ID],
      ["insert", "office_manager", undefined],
    ]);
  });

  it("a new address still gets a new invite", async () => {
    const r = await invite({ email: "New.Person@example.com", role: "dispatcher" });
    expect(r).toMatchObject({ id: "new-invite", resent: false });
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0]).toMatchObject({
      op: "insert",
      values: { email: "new.person@example.com", role: "dispatcher" },
    });
  });
});

describe("the Team page", () => {
  const page = read("src/routes/_authenticated/settings.users.tsx");
  const panel = page.slice(page.indexOf("function InvitePanel"));

  it("toasts the server's refusal through toastServerError", () => {
    expect(panel).toMatch(
      /onError: \(e\) => toastServerError\(e, \{ fallback: "Couldn't send the invite/,
    );
  });

  it("asks the replace question, and calls again with replace only on yes", () => {
    expect(panel).toMatch(/replaceInviteQuestion\(q\.email, q\.currentRole, q\.role\)/);
    const ask = panel.indexOf("await confirm(");
    const again = panel.indexOf("replace: true");
    expect(ask).toBeGreaterThan(-1);
    expect(again).toBeGreaterThan(ask);
    expect(panel.slice(ask, again)).toMatch(/if \(!yes\) return null;/);
    expect(panel).toMatch(/\{confirmDialog\}/);
  });

  it("says Resent when the server resent", () => {
    expect(panel).toMatch(/r\.resent \? "resent" : "created"/);
  });
});
