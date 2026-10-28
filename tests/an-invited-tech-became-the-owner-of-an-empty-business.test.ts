// An invited technician became the owner of a new, empty business (#568).
//
// ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────────────────
//
// The invitation email linked to /auth?invite=<token>. /auth asked for an
// email, found no account, and sent the person to /get-started with the email
// and WITHOUT the token. Get started asked for a business name and called
// bootstrapOrganization directly; it never called
// accept_org_invite_for_current_user. So the tech who followed the link was
// the owner of a same-named business on its own trial, and the invitation sat
// pending for ever. Separately, the Team page said "Invite sent" whether or
// not an email left, there was no link to copy, and /invite/<token> read only
// platform_invites, so every staff link said "Invite not found".
//
// Confirmed six times in the 2026-10 audit, once per service line.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ── The behaviour, executed ───────────────────────────────────────────────
//
// Mocked at the seams ensure-workspace touches: the Supabase client and
// bootstrapOrganization. Everything between them is the real code.
const bootstrapOrganization = vi.fn(async () => ({ ok: true }));
const rpc = vi.fn<(name: string, args?: any) => Promise<{ data: any; error?: any }>>();

vi.mock("@/lib/org.functions", () => ({
  bootstrapOrganization: (...a: any[]) => bootstrapOrganization(...(a as [])),
}));
vi.mock("@/lib/users.functions", () => ({ resyncMySeats: async () => ({}) }));
vi.mock("@/lib/mfa", () => ({ needsSecondStep: async () => false }));
vi.mock("@/lib/signup-attribution", () => ({
  readSignupAttribution: () => ({ ref: null, utm: null, promo: null }),
  clearSignupAttribution: () => {},
}));

let existingRole: { role: string } | null = null;
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingRole }) }) }),
    }),
    rpc: (name: string, args?: any) => rpc(name, args),
  },
}));

// A browser, as much of one as the token handling needs.
const store = new Map<string, string>();
let search = "";
(globalThis as any).window = {
  get location() {
    return { search };
  },
};
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { ensureBootstrapped, rememberInviteToken, acceptPendingInvite } =
  await import("@/lib/ensure-workspace");

const INVITING_ORG = "22222222-2222-2222-2222-222222222222";
const TOKEN = "a".repeat(48);
const invitee = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "tech@example.com",
  user_metadata: { full_name: "Tia Tech" },
};

/** The database: the token joins the inviting org; nothing else matches. */
function inviteDatabase() {
  rpc.mockImplementation(async (name, args) => {
    if (name === "is_platform_admin") return { data: false };
    if (name === "accept_org_invite_for_current_user") {
      return { data: args?._token === TOKEN ? INVITING_ORG : null, error: null };
    }
    return { data: null };
  });
}

describe("an invited person who arrives through the link", () => {
  beforeEach(() => {
    bootstrapOrganization.mockClear();
    rpc.mockReset();
    store.clear();
    search = "";
    existingRole = null;
    inviteDatabase();
  });

  it("joins the inviting business and builds none of their own", async () => {
    search = `?invite=${TOKEN}`;
    const r = await ensureBootstrapped(invitee, { requireOrgName: true });
    expect(r).toBe(false);
    expect(rpc).toHaveBeenCalledWith("accept_org_invite_for_current_user", { _token: TOKEN });
    expect(
      bootstrapOrganization,
      "an invitee was given a business of their own",
    ).not.toHaveBeenCalled();
  });

  it("still joins after Google sends them back to a URL with no token in it", async () => {
    // /auth keeps the token before the OAuth redirect; the provider returns
    // to the site root, which carries no query string at all.
    search = `?invite=${TOKEN}`;
    rememberInviteToken();
    search = "";
    const r = await ensureBootstrapped(invitee, { requireOrgName: true });
    expect(r).toBe(false);
    expect(rpc).toHaveBeenCalledWith("accept_org_invite_for_current_user", { _token: TOKEN });
    expect(bootstrapOrganization).not.toHaveBeenCalled();
  });

  it("uses the token once", async () => {
    rememberInviteToken(TOKEN);
    expect(await acceptPendingInvite()).toBe(INVITING_ORG);
    expect(store.size, "an accepted token was kept and would be replayed").toBe(0);
  });

  it("falls back to the email path when the token matches nothing", async () => {
    rememberInviteToken("b".repeat(48));
    await acceptPendingInvite();
    const tokens = rpc.mock.calls
      .filter(([n]) => n === "accept_org_invite_for_current_user")
      .map(([, a]) => a._token);
    expect(tokens).toEqual(["b".repeat(48), null]);
    expect(store.size).toBe(0);
  });

  it("shows the database's refusal instead of building a second business", async () => {
    rpc.mockImplementation(async (name) => {
      if (name === "is_platform_admin") return { data: false };
      return {
        data: null,
        error: {
          message:
            "This email has a pending invitation. Open the link in that invitation email to join.",
        },
      };
    });
    await expect(ensureBootstrapped(invitee, { requireOrgName: true })).rejects.toThrow(
      /pending invitation/,
    );
    expect(bootstrapOrganization).not.toHaveBeenCalled();
  });

  it("an existing teammate with a link has it recorded rather than left pending", async () => {
    existingRole = { role: "tech" };
    search = `?invite=${TOKEN}`;
    expect(await ensureBootstrapped(invitee)).toBe(false);
    expect(rpc).toHaveBeenCalledWith("accept_org_invite_for_current_user", { _token: TOKEN });
  });
});

// ── The wiring, which the behaviour above cannot see ──────────────────────

describe("the token survives every page between the email and the join", () => {
  it("/auth passes it to Get started", () => {
    const auth = read("src/routes/auth.tsx");
    expect(auth).toMatch(/rememberInviteToken\(\)/);
    expect(auth).toMatch(/to: "\/get-started",\s*search: \{[^}]*invite: inviteToken/);
  });

  it("Get started joins with it and never asks an invitee for a business", () => {
    const gs = read("src/routes/get-started.tsx");
    expect(gs).toMatch(/invite: typeof s\.invite === "string"/);
    expect(gs).toMatch(/search\.invite \? <JoinTeamPage/);
    const join = gs.slice(gs.indexOf("function JoinTeamPage"));
    expect(join).toMatch(/acceptPendingInvite\(token\)/);
    expect(join, "the invitee path creates a business").not.toMatch(/bootstrapOrganization/);
  });

  it("the new-business path tries the invitation before it builds anything", () => {
    const gs = read("src/routes/get-started.tsx");
    const body = gs.slice(
      gs.indexOf("function NewBusinessPage"),
      gs.indexOf("function JoinTeamPage"),
    );
    const accept = body.indexOf("acceptPendingInvite(null)");
    const boot = body.indexOf("bootstrapOrganization({");
    expect(accept, "Get started never looks for an invitation").toBeGreaterThan(-1);
    expect(accept).toBeLessThan(boot);
  });

  it("bootstrapOrganization refuses an address with a pending invitation", () => {
    const org = read("src/lib/org.functions.ts");
    const fn = org.slice(org.indexOf("export const bootstrapOrganization"));
    const guard = fn.indexOf('.from("org_invites")');
    const rpcCall = fn.indexOf('rpc("bootstrap_organization"');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rpcCall);
  });

  it("/invite/<token> reads staff invitations too", () => {
    const fns = read("src/lib/platform-onboarding.functions.ts");
    expect(fns).toMatch(/return lookupStaffInvite\(supabaseAdmin, data\.token\)/);
    expect(fns).toMatch(/\.from\("org_invites"\)/);
  });
});

describe("the Team page says what actually happened", () => {
  const page = read("src/routes/_authenticated/settings.users.tsx");
  const fns = read("src/lib/users.functions.ts");

  it("never claims an email went out without the provider saying so", () => {
    expect(page).not.toMatch(/toast\.success\("Invite sent"\)/);
    expect(page).not.toMatch(/toast\.success\("Invite resent"\)/);
    expect(page).toMatch(/r\.emailSent/);
    expect(fns).toMatch(/const emailSent = await sendInviteEmail\(/);
  });

  it("offers the link to copy", () => {
    expect(page).toMatch(/Copy link/);
    expect(fns).toMatch(/appUrl\(`\/invite\/\$\{encodeURIComponent\(token\)\}`\)/);
  });
});
