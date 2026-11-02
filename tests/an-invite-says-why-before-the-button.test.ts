// An invite says why before the button, and Resend does not shorten it
// (gaps-r2-03, gaps-r2-10, gaps-r2-14).
//
//   03. An account that already belonged to another business opened a team
//       invitation, read "ready to accept", and pressed a button the database
//       was always going to refuse. #699 made the refusal a toast; this makes
//       the page ask first and say why.
//   10. Resend set expires_at to now + 7 days, so a 14-day invitation lost a
//       week, and the toast repeated "Invite created". Revoke had no confirm.
//   14. A revoked, used or expired TEAM link was titled "Platform invite",
//       because the title keyed on a lookup that had failed.

/* eslint-disable @typescript-eslint/no-explicit-any -- chainable fakes of the Supabase and TanStack builders */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  INVITE_LIFETIME_DAYS,
  inviteProblem,
  inviteSendToast,
  inviteTitle,
  otherOrgReason,
  resentInviteExpiry,
} from "@/lib/invite-copy";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const DAY = 24 * 60 * 60 * 1000;

// ── A database as small as these functions need ──────────────────────────────

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  updates: [] as Array<{ table: string; values: Row; filters: Row }>,
  userId: "user-1",
}));

function fakeDb() {
  return {
    from(table: string) {
      const filters: Row = {};
      let values: Row | null = null;
      const rows = () =>
        (state.tables[table] ?? []).filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k] === v),
        );
      const q: any = {
        select: () => q,
        update: (v: Row) => {
          values = v;
          return q;
        },
        eq: (k: string, v: unknown) => {
          filters[k] = v;
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown) => {
          if (values) {
            state.updates.push({ table, values, filters: { ...filters } });
            return Promise.resolve({ data: null, error: null }).then(resolve);
          }
          return Promise.resolve({ data: rows(), error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

vi.mock("@tanstack/react-start", () => {
  const createServerFn = () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return b;
      },
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (a?: { data: unknown }) =>
          fn({ data: validate(a?.data), context: { supabase: fakeDb(), userId: state.userId } }),
    };
    return b;
  };
  return { createServerFn, createServerOnlyFn: (fn: unknown) => fn };
});
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return fakeDb();
  },
}));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-a" }),
  requirePermission: async () => ({ orgId: "org-a" }),
}));
vi.mock("@/lib/invite-email.server", () => ({ sendInviteEmail: async () => true }));
vi.mock("@/lib/app-origin", () => ({ appUrl: (p: string) => `https://app.test${p}` }));

type Call = (a: { data: unknown }) => Promise<any>;
const TOKEN = "t".repeat(48);

beforeEach(() => {
  state.updates = [];
  state.userId = "user-1";
  state.tables = {
    platform_invites: [],
    organizations: [
      { id: "org-a", name: "Acme Scoops", slug: "acme" },
      { id: "org-b", name: "Owner2 Trial" },
    ],
    staff: [{ organization_id: "org-a", user_id: "owner-a", display_name: "Olivia Owner" }],
    org_invites: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        token: TOKEN,
        email: "owner2@example.com",
        role: "tech",
        status: "pending",
        organization_id: "org-a",
        invited_by: "owner-a",
        expires_at: new Date(Date.now() + 13 * DAY).toISOString(),
        organizations: { name: "Acme Scoops" },
      },
    ],
    user_roles: [],
  };
});

// ── gaps-r2-03 ───────────────────────────────────────────────────────────────

describe("an account in another business is told before it presses Accept (gaps-r2-03)", () => {
  it("checkInviteReadiness names the business the account is already in", async () => {
    state.tables.user_roles = [{ user_id: "user-1", organization_id: "org-b", role: "owner" }];
    const { checkInviteReadiness } = await import("@/lib/platform-onboarding.functions");
    await expect(
      (checkInviteReadiness as unknown as Call)({ data: { token: TOKEN } }),
    ).resolves.toEqual({
      ready: false,
      reason: "other_org",
      current_organization_name: "Owner2 Trial",
    });
  });

  it("is ready for an account with no business, or already in the inviting one", async () => {
    const { checkInviteReadiness } = await import("@/lib/platform-onboarding.functions");
    const call = checkInviteReadiness as unknown as Call;
    await expect(call({ data: { token: TOKEN } })).resolves.toEqual({ ready: true });
    state.tables.user_roles = [{ user_id: "user-1", organization_id: "org-a", role: "tech" }];
    await expect(call({ data: { token: TOKEN } })).resolves.toEqual({ ready: true });
    // A platform-scoped role with no organization is not "another business".
    state.tables.user_roles = [
      { user_id: "user-1", organization_id: null, role: "platform_admin" },
    ];
    await expect(call({ data: { token: TOKEN } })).resolves.toEqual({ ready: true });
  });

  it("the reason says which business, and what to do", () => {
    const s = otherOrgReason("owner2@example.com", "Owner2 Trial", "Acme Scoops");
    expect(s).toContain("owner2@example.com already belongs to Owner2 Trial");
    expect(s).toContain("To join Acme Scoops");
    expect(s).toContain("different email address");
    expect(s).toContain("leave Owner2 Trial first");
    expect(otherOrgReason(null, null, null)).toContain("another business");
  });

  it("the page shows the reason instead of 'ready to accept', and still toasts a refusal", () => {
    const page = read("src/routes/invite.$token.tsx");
    const blocked = page.indexOf(") : blocked ? (");
    const ready = page.indexOf("ready to accept.");
    expect(blocked, "no blocked branch").toBeGreaterThan(-1);
    expect(blocked).toBeLessThan(ready);
    expect(page).toMatch(/otherOrgReason\(\s*session\.email,\s*blocked\.current_organization_name/);
    expect(page).toMatch(/readinessFn\(\{ data: \{ token \} \}\)/);
    expect(page).toMatch(/toastServerError\(e,/);
  });
});

// ── gaps-r2-10 ───────────────────────────────────────────────────────────────

describe("Resend keeps the invite alive for its full life and says Resent (gaps-r2-10)", () => {
  it("renews to 14 days from now and never shortens", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(INVITE_LIFETIME_DAYS).toBe(14);
    expect(resentInviteExpiry("2026-11-13T12:00:00Z", now)).toBe("2026-11-14T12:00:00.000Z");
    // Never earlier than it already was.
    expect(resentInviteExpiry("2026-12-31T00:00:00.000Z", now)).toBe("2026-12-31T00:00:00.000Z");
    expect(resentInviteExpiry(null, now)).toBe("2026-11-14T12:00:00.000Z");
  });

  it("resendOrgInvite writes a 14-day expiry, not 7", async () => {
    const { resendOrgInvite } = await import("@/lib/users.functions");
    const before = Date.now();
    const r = await (resendOrgInvite as unknown as Call)({
      data: { id: "00000000-0000-4000-8000-000000000001" },
    });
    expect(r.emailSent).toBe(true);
    const write = state.updates.find((u) => u.table === "org_invites");
    expect(write?.filters).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      organization_id: "org-a",
    });
    const expires = Date.parse(write!.values.expires_at as string);
    expect(expires).toBeGreaterThanOrEqual(before + 14 * DAY - 1000);
    expect(read("src/lib/users.functions.ts")).not.toMatch(/7 \* 24 \* 60 \* 60 \* 1000/);
  });

  it("the toast says Resent, not Invite created", () => {
    expect(inviteSendToast("resent", "a@b.co", true)).toEqual({
      tone: "success",
      message: "Resent to a@b.co. The link works for 14 more days.",
    });
    const failed = inviteSendToast("resent", "a@b.co", false);
    expect(failed.tone).toBe("warning");
    expect(failed.message).toMatch(/^Resent/);
    expect(failed.message).not.toMatch(/Invite created/);
    expect(failed.message).toContain("did not go out");
    expect(inviteSendToast("created", "a@b.co", false).message).toMatch(/^Invite created/);
    const page = read("src/routes/_authenticated/settings.users.tsx");
    expect(page).toMatch(/reportSend\(.*, r, "resent"\)/);
    expect(page).not.toMatch(/"emailed again"/);
  });

  it("Revoke asks first", () => {
    const page = read("src/routes/_authenticated/settings.users.tsx");
    expect(page).not.toMatch(/onClick=\{\(\) => revokeMut\.mutate/);
    expect(page).toMatch(
      /<ConfirmButton[\s\S]{0,400}onConfirm=\{\(\) => revokeMut\.mutate\(i\.id\)\}/,
    );
  });
});

// ── gaps-r2-14 ───────────────────────────────────────────────────────────────

describe("a failed team link is a Team invitation and says who to ask (gaps-r2-14)", () => {
  it("the lookup keeps the kind, business and inviter on a revoked link", async () => {
    state.tables.org_invites[0].status = "revoked";
    const { lookupInviteByToken } = await import("@/lib/platform-onboarding.functions");
    const r = await (lookupInviteByToken as unknown as Call)({ data: { token: TOKEN } });
    expect(r).toEqual({
      ok: false,
      reason: "revoked",
      kind: "staff",
      organization_name: "Acme Scoops",
      inviter_name: "Olivia Owner",
    });
    expect(inviteTitle(r.kind)).toBe("Team invitation");
    expect(inviteProblem(r)).toBe(
      "This invite was revoked. Ask Olivia Owner at Acme Scoops for a new link.",
    );
  });

  it("an expired one too, and a used one", async () => {
    const { lookupInviteByToken } = await import("@/lib/platform-onboarding.functions");
    const call = lookupInviteByToken as unknown as Call;
    state.tables.org_invites[0].expires_at = new Date(Date.now() - DAY).toISOString();
    expect(await call({ data: { token: TOKEN } })).toMatchObject({
      ok: false,
      reason: "expired",
      kind: "staff",
    });
    state.tables.org_invites[0].status = "accepted";
    const used = await call({ data: { token: TOKEN } });
    expect(used).toMatchObject({ reason: "accepted", kind: "staff" });
    expect(inviteProblem(used)).toContain("sign in to open Acme Scoops");
  });

  it("titles follow the kind; a token found nowhere is just an Invitation", () => {
    expect(inviteTitle("platform")).toBe("Platform invite");
    expect(inviteTitle(undefined)).toBe("Invitation");
    expect(inviteProblem({ reason: "not_found" })).toBe("Invite not found.");
    expect(inviteProblem({ kind: "staff", reason: "expired", organization_name: "Acme" })).toBe(
      "This invite has expired. Ask the owner of Acme for a new link.",
    );
    const page = read("src/routes/invite.$token.tsx");
    expect(page).toMatch(/<CardTitle>\{inviteTitle\(q\.data\?\.kind\)\}<\/CardTitle>/);
    expect(page).not.toMatch(/isStaff \? "Team invitation" : "Platform invite"/);
  });
});
