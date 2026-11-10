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
    // person typed, so it must still be honoured without a second prompt --
    // for a signup that has not finished, which registerAccount marks in
    // app_metadata. Without the marker the name is a removed teammate's stale
    // metadata, and is not used (#765, a-removed-teammate-got-a-business-...).
    const r = await ensureBootstrapped(
      {
        ...oauthUser,
        app_metadata: { signup_org_pending: true },
        user_metadata: { ...oauthUser.user_metadata, org_name: "Bark Patrol" },
      },
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
  // Moved 2026-08-28: the branding card left Preferences for the Client
  // portal page, because a brand colour a customer sees is not a preference.
  // The assertion is unchanged -- the business name still has to be editable
  // somewhere, and this is where.
  const ui = read("src/components/settings/ClientPortalCards.tsx");

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

// ── A PROVIDER CAN REFUSE IN A 200 ───────────────────────────────────────
//
// Three providers, three different refusals, each learned the hard way:
//
//   Supabase   400 with a JSON body
//   Google     302 to an error URL, reason base64'd into a query parameter
//   Facebook   200, with the error rendered INSIDE the page
//
// The last one is why check:oauth reported Facebook OK on 2026-08-26 while its
// Client IDs field held an app ACCESS TOKEN -- "APPID|APPSECRET" -- so the app
// secret was going out in a query string on every sign-in attempt, and
// Facebook was answering "Invalid App ID" in the body of a 200.
//
// A leaked secret that the gate calls healthy is worse than an outage, so both
// halves are pinned: read the body, and refuse a client_id that carries a
// secret at all.
describe("the OAuth gate can see a refusal that arrives as a 200", () => {
  const script = read("scripts/check-oauth-providers.mjs");

  it("reads the response body for a provider's own error text", () => {
    expect(script).toMatch(/invalid app id/i);
    expect(script).toMatch(/url blocked/i);
    // AND the finding has to reach the VERDICT. The first version of this test
    // asserted only that `bodySaysNo` appeared somewhere, which a mutation
    // that computed it and then ignored it passed cleanly -- a test that
    // proves a variable exists, not that anything consults it.
    const decision = script.slice(script.indexOf("const mismatch ="), script.indexOf(";", script.indexOf("const mismatch =")));
    expect(decision, "bodySaysNo is computed but not part of the verdict").toMatch(/bodySaysNo/);
  });

  it("refuses a client_id that contains a secret", () => {
    // "APPID|APPSECRET" is Facebook's app access token format. No provider's
    // client id should ever contain a pipe, so this is checked for all of them.
    expect(script).toMatch(/clientId\.includes\("\|"\)/);
    expect(script).toMatch(/app ACCESS TOKEN/);
  });

  it("says which of the two it found, because the fixes differ", () => {
    // One is "register a redirect URI"; the other is "rotate a leaked secret".
    expect(script).toMatch(/put the refusal in the body/);
    expect(script).toMatch(/Rotate it/);
  });
});

// ── 4.8 IS NOW SATISFIED RATHER THAN DODGED ──────────────────────────────
//
// The binary used to offer no third-party sign-in at all, which sidestepped
// guideline 4.8 by never engaging it. Since 2026-08-27 it offers all three,
// so the rule applies for real: an app offering third-party sign-in must
// offer Sign in with Apple.
//
// The test therefore changed shape. "The block is hidden in native" is no
// longer the invariant worth defending -- this is: IF Google or Facebook is
// offered, Apple is offered too. That holds on web and in the binary, and it
// is the thing a reviewer actually checks.
describe("Sign in with Apple is offered wherever the others are", () => {
  const auth = read("src/routes/auth.tsx");
  const code = auth.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");

  it("offers Apple if it offers Google or Facebook", () => {
    const offers = (p: string) => new RegExp(`oauthSignIn\\(\\s*["']${p}["']`).test(code);
    if (offers("google") || offers("facebook")) {
      expect(offers("apple"), "guideline 4.8: Apple must be offered alongside the others").toBe(
        true,
      );
    }
  });

  it("and the native path does not go through the WebView", () => {
    // Google refuses OAuth in an embedded WebView regardless of anything else,
    // so a native build that called the web path would ship a button that
    // cannot work. @capacitor/browser opens SFSafariViewController, which is
    // an approved system browser.
    const native = read("src/lib/native-oauth.ts");
    expect(native).toMatch(/@capacitor\/browser/);
    expect(native).toMatch(/skipBrowserRedirect: true/);
    expect(code).toMatch(/if \(IS_NATIVE_BUNDLE\) \{/);
  });

  it("hands back through a scheme the app actually registers", () => {
    // A redirect the binary does not claim goes nowhere, and the failure looks
    // like a button that opens Safari and never returns.
    // The constant lives in its own file so modules can name it without the
    // Supabase client (lib/password-recovery.ts); native-oauth re-exports it.
    const native = read("src/lib/native-oauth-redirect.ts");
    const plist = read("ios/App/App/Info.plist");
    const scheme = /NATIVE_OAUTH_REDIRECT = "([a-z0-9.\-]+):\/\//i.exec(native)?.[1];
    expect(scheme, "no scheme in NATIVE_OAUTH_REDIRECT").toBeTruthy();
    expect(plist, `Info.plist does not register ${scheme}`).toMatch(
      new RegExp(`<string>${scheme!.replace(/\./g, "\\.")}</string>`),
    );
  });
});
