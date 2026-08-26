// A Google signup would have created "Jane Smith's Organization", for ever.
//
// ── WHAT WAS ACTUALLY WRONG ───────────────────────────────────────────────
//
// /get-started asks for a business name and REFUSES placeholders. Every other
// route into a new organization asked for nothing and invented one:
// ensureBootstrapped fell back to `${displayName}'s Organization`, and an OAuth
// round-trip carries a provider profile and no company at all. So the careful
// path was the one that asked, and the quiet path was the one that guessed.
//
// The guessed name is not cosmetic. It is printed on invoices, on the customer
// portal and on outbound email — and no tenant-facing screen could change it.
// The only edit path was the platform admin console, which means a support
// ticket for something the owner should never have had to ask for.
//
// This was found while enabling OAuth, BEFORE any provider went live, so no
// real organization was named this way. The tests below are what stops it
// returning the moment Google is switched on.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ── The behaviour, executed ───────────────────────────────────────────────
//
// Mocked at the two seams ensureBootstrapped actually touches: the Supabase
// client, and bootstrapOrganization. Everything between them is the real code.
const bootstrapOrganization = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/org.functions", () => ({
  bootstrapOrganization: (...a: any[]) => bootstrapOrganization(...(a as [])),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
    // not a platform admin, and no pending invitation
    rpc: async () => ({ data: null }),
  },
}));

vi.mock("@/lib/signup-attribution", () => ({
  readSignupAttribution: () => ({ ref: null, utm: null, promo: null }),
  clearSignupAttribution: () => {},
}));

const { ensureBootstrapped, NEEDS_ORG_NAME } = await import("@/lib/ensure-workspace");

// What Google actually hands back: a person, never a company.
const oauthUser = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "jane@example.com",
  user_metadata: { full_name: "Jane Smith", name: "Jane Smith", avatar_url: "https://x/y.png" },
};

describe("a signup that names nobody's business", () => {
  beforeEach(() => bootstrapOrganization.mockClear());

  it("refuses to invent one, and says so", async () => {
    const r = await ensureBootstrapped(oauthUser, { requireOrgName: true });
    expect(r).toBe(NEEDS_ORG_NAME);
    expect(
      bootstrapOrganization,
      "an organization was created despite nothing naming the business",
    ).not.toHaveBeenCalled();
  });

  it("still creates one when the person has typed a name", async () => {
    const r = await ensureBootstrapped(oauthUser, {
      requireOrgName: true,
      orgName: "Acme Pet Waste Removal",
    });
    expect(r).toBe(true);
    expect(bootstrapOrganization).toHaveBeenCalledOnce();
    const arg = bootstrapOrganization.mock.calls[0][0] as any;
    expect(arg.data.orgName).toBe("Acme Pet Waste Removal");
  });

  it("uses the name captured at signup when there is one", async () => {
    // The email path stashes org_name in user metadata. That is a real name a
    // person typed, so it must still be honoured without a second prompt.
    const r = await ensureBootstrapped(
      { ...oauthUser, user_metadata: { ...oauthUser.user_metadata, org_name: "Bark Patrol" } },
      { requireOrgName: true },
    );
    expect(r).toBe(true);
    expect((bootstrapOrganization.mock.calls[0][0] as any).data.orgName).toBe("Bark Patrol");
  });

  it("the old fallback is still there for callers that cannot ask", async () => {
    // Not every caller can put a form on the screen. Those keep the derived
    // name rather than failing — the point is that /auth is no longer one.
    const r = await ensureBootstrapped(oauthUser);
    expect(r).toBe(true);
    expect((bootstrapOrganization.mock.calls[0][0] as any).data.orgName).toBe(
      "Jane Smith's Organization",
    );
  });
});

// ── The wiring, which the behaviour above cannot see ──────────────────────

describe("and /auth is a caller that can ask", () => {
  const auth = read("src/routes/auth.tsx");

  it("every bootstrap on the sign-in path requires a real name", () => {
    const calls = auth.match(/ensureBootstrapped\([^)]*\)/g) ?? [];
    expect(calls.length, "no ensureBootstrapped call found in auth.tsx").toBeGreaterThan(0);
    for (const c of calls) {
      expect(c, `${c} would let a derived business name through`).toMatch(/requireOrgName:\s*true/);
    }
  });

  it("and routes to the screen that asks", () => {
    const hits =
      auth.match(/NEEDS_ORG_NAME\)\s*return navigate\(\{ to: "\/no-workspace" \}\)/g) ?? [];
    expect(hits.length, "a call site checks the sentinel but does not route").toBe(
      (auth.match(/ensureBootstrapped\(/g) ?? []).length,
    );
  });
});

describe("and the name can be fixed afterwards", () => {
  const fns = read("src/lib/org.functions.ts");
  const ui = read("src/routes/_authenticated/settings.preferences.tsx");

  it("the server accepts a business name, through the signup validator", () => {
    expect(fns).toMatch(/name: z\.string\(\)/);
    expect(fns, "the settings path must not accept a name that /get-started would reject").toMatch(
      /patch\.name = assertValidOrgName\(data\.name\)/,
    );
  });

  it("there is a field to type it in", () => {
    expect(ui.replace(/\s+/g, " ")).toMatch(/Business name/);
    expect(ui).toMatch(/name: orgName\.trim\(\)/);
  });

  it("and saving is blocked while it is a placeholder", () => {
    expect(ui).toMatch(/disabled=\{mut\.isPending \|\| !isValidOrgName\(orgName\)\}/);
  });
});
