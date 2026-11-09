// A teammate taken off a business got a new business of their own (#765).
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// Detroit Doo Disposal, 2026-11-09. An address that had been attached to the
// business and then removed could not sign in, reset its password, or sign up
// again. The account was fine: confirmed, with a password, not banned, not
// deleted. What it had was no user_roles row and a user_metadata.org_name of
// "Detroit Doo Disposal", written at signup in July and never cleared.
//
// ensureBootstrapped read "no membership + org_name" as "a signup whose
// business was never created" and created it. So the person's next sign-in
// would have built a SECOND "Detroit Doo Disposal" and made them its owner,
// and a reset link, which is a sign-in, went the same way instead of to the
// page that sets a password.
//
// ── WHAT IS PINNED HERE ──────────────────────────────────────────────────
//
//   1. no membership and no server-written signup marker: nothing is built,
//      the person is sent to the create-or-join screen;
//   2. a fresh signup (marker set by registerAccount) still builds exactly as
//      before, from the name it typed;
//   3. a pending invitation is still accepted first, for both;
//   4. a recovery session is handed to /reset-password before the membership
//      sequence runs, and nothing on that path needs a membership.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

// ── The behaviour, executed against the real ensureBootstrapped ────────────
const bootstrapOrganization = vi.fn(async () => ({ ok: true }));
const state = vi.hoisted(() => ({ invitedOrg: null as string | null, rpcCalls: [] as string[] }));

vi.mock("@/lib/org.functions", () => ({
  bootstrapOrganization: (...a: any[]) => bootstrapOrganization(...(a as [])),
}));
vi.mock("@/lib/mfa", () => ({ needsSecondStep: async () => false }));
vi.mock("@/lib/users.functions", () => ({ resyncMySeats: async () => ({ ok: true }) }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    // No membership anywhere: the removed teammate's state, as read in prod.
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
    rpc: async (name: string) => {
      state.rpcCalls.push(name);
      if (name === "accept_org_invite_for_current_user") return { data: state.invitedOrg };
      return { data: null };
    },
    auth: { getUser: async () => ({ data: { user: null } }) },
  },
}));
vi.mock("@/lib/signup-attribution", () => ({
  readSignupAttribution: () => ({ ref: null, utm: null, promo: null }),
  clearSignupAttribution: () => {},
}));

const { ensureBootstrapped, NEEDS_ORG_NAME } = await import("@/lib/ensure-workspace");

/** The account as production showed it: created by /get-started in July,
 *  metadata naming the business it was later removed from. */
const removedTeammate = {
  id: "0d0d0d0d-0000-4000-8000-000000000765",
  email: "owner@example.com",
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { org_name: "Detroit Doo Disposal", display_name: "Owner" },
};

describe("an account with no business and no signup marker", () => {
  beforeEach(() => {
    bootstrapOrganization.mockClear();
    state.invitedOrg = null;
    state.rpcCalls = [];
  });

  it("is sent to create-or-join, and no business is built from stale metadata", async () => {
    const r = await ensureBootstrapped(removedTeammate, { requireOrgName: true });
    expect(r).toBe(NEEDS_ORG_NAME);
    expect(
      bootstrapOrganization,
      "a removed teammate got a business named after the one they were removed from",
    ).not.toHaveBeenCalled();
  });

  it("is not built one even by a caller that cannot ask for a name", async () => {
    // Without requireOrgName the old code fell back to md.org_name too.
    await ensureBootstrapped(removedTeammate);
    const named = bootstrapOrganization.mock.calls.map((c: any) => c[0]?.data?.orgName);
    expect(named).not.toContain("Detroit Doo Disposal");
  });

  it("still joins a business that re-invited it, before anything else", async () => {
    state.invitedOrg = "0a000000-0000-4000-8000-000000000765";
    const r = await ensureBootstrapped(removedTeammate, { requireOrgName: true });
    expect(r).toBe(false);
    expect(state.rpcCalls).toContain("accept_org_invite_for_current_user");
    expect(bootstrapOrganization).not.toHaveBeenCalled();
  });

  it("creates the business the person names on /no-workspace", async () => {
    const r = await ensureBootstrapped(removedTeammate, {
      orgName: "Northside Scoopers",
      displayName: "Owner",
    });
    expect(r).toBe(true);
    expect((bootstrapOrganization.mock.calls[0] as any)[0].data.orgName).toBe("Northside Scoopers");
  });
});

describe("a fresh signup from /get-started", () => {
  beforeEach(() => {
    bootstrapOrganization.mockClear();
    state.invitedOrg = null;
  });

  const fresh = {
    ...removedTeammate,
    app_metadata: { ...removedTeammate.app_metadata, signup_org_pending: true },
  };

  it("still finishes from the name it typed, with no second prompt", async () => {
    const r = await ensureBootstrapped(fresh, { requireOrgName: true });
    expect(r).toBe(true);
    expect((bootstrapOrganization.mock.calls[0] as any)[0].data.orgName).toBe(
      "Detroit Doo Disposal",
    );
  });

  it("only a server-written marker counts: user_metadata is the person's to edit", async () => {
    const forged = {
      ...removedTeammate,
      user_metadata: { ...removedTeammate.user_metadata, signup_org_pending: true },
    };
    expect(await ensureBootstrapped(forged, { requireOrgName: true })).toBe(NEEDS_ORG_NAME);
  });
});

// ── The marker's life cycle, which the behaviour above depends on ──────────
describe("the signup marker is written by registerAccount and cleared by every join", () => {
  it("registerAccount writes it in app_metadata, and only when a business was named", () => {
    const src = codeOnly(read("src/lib/auth-entry.functions.ts"));
    expect(src).toMatch(
      /app_metadata:\s*data\.orgName\s*\?\s*\{\s*\[SIGNUP_ORG_PENDING\]:\s*true\s*\}/,
    );
  });

  it("bootstrapOrganization and acceptPlatformInvite clear it", () => {
    expect(codeOnly(read("src/lib/org.functions.ts"))).toMatch(/clearSignupMarker\(/);
    expect(codeOnly(read("src/lib/platform-onboarding.functions.ts"))).toMatch(
      /clearSignupMarker\(/,
    );
  });
});

// ── The create-or-join screen ────────────────────────────────────────────
describe("/no-workspace says what a removed teammate can do", () => {
  const src = read("src/routes/no-workspace.tsx");

  it("offers both ways forward in plain words", () => {
    expect(src).toContain("You&apos;re not part of a business right now.");
    expect(src).toContain("ask your owner to re-invite you");
  });

  it("can pick up a re-invitation without signing out", () => {
    expect(codeOnly(src)).toMatch(/acceptPendingInvite\(/);
  });

  it("does not prefill the business name from stale metadata", () => {
    expect(codeOnly(src)).not.toMatch(/org_name/);
  });
});

// ── A reset is not a sign-in to be routed by membership ───────────────────
// The recovery mechanism itself is #780's (lib/password-recovery.ts, pinned by
// a-password-reset-that-goes-somewhere.test.ts). What #765 needs from it is
// that both screens a membership-less account can reach defer to it before
// anything about a business is decided.
describe("a password reset never waits on a membership", () => {
  const auth = codeOnly(read("src/routes/auth.tsx"));

  it("/auth hands a recovery to /reset-password before the membership sequence", () => {
    const run = auth.slice(auth.indexOf("const run = async"));
    const recovery = run.indexOf("recoveryRedirectTarget(");
    const bootstrap = run.indexOf("ensureBootstrapped(");
    expect(recovery, "no recovery check in /auth's landing effect").toBeGreaterThan(-1);
    expect(recovery).toBeLessThan(bootstrap);
  });

  it("/no-workspace does too, for a recovery that reached it first", () => {
    expect(codeOnly(read("src/routes/no-workspace.tsx"))).toMatch(
      /recoveryRedirectTarget\(window\.location\.href\);\s*if \(recovery\) router\.history\.replace\(recovery\);/,
    );
  });

  it("sending a reset asks nothing about the business", () => {
    const fp = auth.slice(auth.indexOf("const forgotPassword"));
    const body = fp.slice(0, fp.indexOf("\n  };"));
    expect(body).toContain("requestPasswordReset(");
    expect(body).not.toMatch(/user_roles|organization|sendEmailVerification/);
  });

  it("no sign-in or reset surface calls sendEmailVerification, which needs a business", () => {
    for (const f of [
      "src/routes/auth.tsx",
      "src/routes/reset-password.tsx",
      "src/routes/no-workspace.tsx",
      "src/lib/ensure-workspace.ts",
      "src/lib/password-recovery.ts",
    ]) {
      expect(codeOnly(read(f)), f).not.toContain("sendEmailVerification");
    }
  });
});
