// Connecting and disconnecting QuickBooks, and the URLs Intuit's app settings
// point at (owner, 2026-10-09):
//
//   Redirect URI     /api/public/hooks/qbo-callback
//   Launch URL       /settings/accounting
//   Connect URL      /settings/accounting?connect=quickbooks
//   Disconnect URL   /settings/accounting?disconnected=quickbooks
//
// The callback's CSRF check is proved against fakes; the page's handling of
// each URL is pinned in its source, because a sweep cannot sign in to Intuit.

import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toPosix } from "./support/repo-paths";
import { handleQboCallback, type QboCallbackDeps } from "@/lib/qbo-callback.server";
import {
  checkOAuthState,
  newOAuthState,
  OAUTH_STATE_TTL_MS,
  QBO_CALLBACK_ERRORS,
  qboCallbackErrorMessage,
  qboRedirectUri,
} from "@/lib/qbo-redirect";
import { QboReconnectRequired } from "@/lib/qbo-oauth.server";
import { appLinkClaims, STAYS_IN_BROWSER } from "@/lib/android-app-links";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const NOW = Date.parse("2026-10-09T15:00:00Z");
const ORIGIN = "https://app.houndstack.com";

function deps(over: Partial<QboCallbackDeps> = {}) {
  const states = new Map<string, { org_id: string; provider: string; expires_at: string }>([
    ["good", { org_id: "org-1", provider: "quickbooks", expires_at: new Date(NOW + 60_000).toISOString() }],
    ["old", { org_id: "org-1", provider: "quickbooks", expires_at: new Date(NOW - 1).toISOString() }],
    ["xero", { org_id: "org-1", provider: "xero", expires_at: new Date(NOW + 60_000).toISOString() }],
  ]);
  const saved: Array<[string, string, string]> = [];
  const exchanged: Array<{ code: string; redirectUri: string }> = [];
  const d: QboCallbackDeps = {
    now: () => NOW,
    configured: true,
    // Read-and-delete, as the route does with DELETE … RETURNING.
    consumeState: async (s) => {
      const row = states.get(s) ?? null;
      states.delete(s);
      return row;
    },
    exchange: async (p) => {
      exchanged.push(p);
      return { accessToken: "a", refreshToken: "r", accessExpiresAt: "x", refreshExpiresAt: null, intuitTid: "t" };
    },
    saveGrant: async (org, realm, t) => void saved.push([org, realm, t.refreshToken]),
    ...over,
  };
  return { d, saved, exchanged };
}

const cb = (q: string) => `${ORIGIN}/api/public/hooks/qbo-callback?${q}`;
const location = (r: Response) => r.headers.get("location");

describe("the callback's CSRF check", () => {
  it("accepts a stored, unexpired QuickBooks state and stores the grant for that state's org", async () => {
    const { d, saved, exchanged } = deps();
    const r = await handleQboCallback(cb("code=c1&state=good&realmId=4620816365"), d);
    expect(r.status).toBe(302);
    expect(location(r)).toBe(`${ORIGIN}/settings/accounting?connected=quickbooks`);
    expect(saved).toEqual([["org-1", "4620816365", "r"]]);
    expect(exchanged).toEqual([{ code: "c1", redirectUri: `${ORIGIN}/api/public/hooks/qbo-callback` }]);
  });

  it("is single use: the same state a second time is refused", async () => {
    const { d, saved } = deps();
    await handleQboCallback(cb("code=c1&state=good&realmId=1"), d);
    const again = await handleQboCallback(cb("code=c2&state=good&realmId=1"), d);
    expect(location(again)).toBe(`${ORIGIN}/settings/accounting?qbo_error=state_invalid`);
    expect(saved).toHaveLength(1);
  });

  it("refuses an unknown state, an expired one, and one for another provider, without exchanging the code", async () => {
    for (const [state, code] of [
      ["forged", "state_invalid"],
      ["old", "state_expired"],
      ["xero", "state_invalid"],
    ] as const) {
      const { d, exchanged, saved } = deps();
      const r = await handleQboCallback(cb(`code=c&state=${state}&realmId=1`), d);
      expect(location(r), state).toBe(`${ORIGIN}/settings/accounting?qbo_error=${code}`);
      expect(exchanged).toEqual([]);
      expect(saved).toEqual([]);
    }
  });

  it("consumes the state even when the user cancelled at Intuit", async () => {
    const { d } = deps();
    const r = await handleQboCallback(cb("error=access_denied&state=good"), d);
    expect(location(r)).toMatch(/qbo_error=access_denied$/);
    expect(await d.consumeState("good")).toBeNull();
  });

  it("refuses a missing code or a malformed realm", async () => {
    const { d } = deps();
    expect(location(await handleQboCallback(cb("state=good&realmId=1"), d))).toMatch(/missing_params$/);
    expect(location(await handleQboCallback(cb("code=c&state=good&realmId=1%3Cscript"), deps().d))).toMatch(/missing_params$/);
  });

  it("turns a refused code (invalid_grant) into a clean error and logs no secret", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
    const { d } = deps({
      exchange: async () => {
        throw new QboReconnectRequired("invalid_grant", "tid-x");
      },
    });
    const r = await handleQboCallback(cb("code=SECRETCODE&state=good&realmId=1"), d);
    expect(location(r)).toMatch(/qbo_error=token_exchange$/);
    expect(lines.join("\n")).not.toContain("SECRETCODE");
    vi.restoreAllMocks();
  });

  it("states are 256 random bits and live ten minutes", () => {
    const s = newOAuthState();
    expect(s).toMatch(/^[0-9a-f]{64}$/);
    expect(newOAuthState()).not.toBe(s);
    expect(OAUTH_STATE_TTL_MS).toBe(10 * 60 * 1000);
    expect(checkOAuthState(null, NOW)).toBe("state_invalid");
  });

  it("every error code has words for the page, and an unknown one still says something", () => {
    for (const k of Object.keys(QBO_CALLBACK_ERRORS)) expect(qboCallbackErrorMessage(k)).toBeTruthy();
    expect(qboCallbackErrorMessage("whatever")).toBe(QBO_CALLBACK_ERRORS.token_exchange);
    expect(qboCallbackErrorMessage(null)).toBeNull();
  });
});

describe("the redirect URI", () => {
  it("is the registered one in production, whatever the browser claims", () => {
    expect(qboRedirectUri(ORIGIN, ORIGIN)).toBe(`${ORIGIN}/api/public/hooks/qbo-callback`);
    expect(qboRedirectUri("https://evil.example", ORIGIN)).toBe(`${ORIGIN}/api/public/hooks/qbo-callback`);
    expect(qboRedirectUri("not a url", ORIGIN)).toBe(`${ORIGIN}/api/public/hooks/qbo-callback`);
  });

  it("is the local dev server's for a sandbox test", () => {
    expect(qboRedirectUri("http://localhost:8080", ORIGIN)).toBe("http://localhost:8080/api/public/hooks/qbo-callback");
  });

  it("stays in the browser on Android, where Intuit sends it", () => {
    expect(appLinkClaims("/api/public/hooks/qbo-callback")).toBe(false);
    expect(STAYS_IN_BROWSER["/api"]).toBeTruthy();
    expect(appLinkClaims("/settings/accounting")).toBe(true);
  });
});

describe("Settings → Accounting", () => {
  const page = read("src/routes/_authenticated/settings.accounting.tsx");

  it("is switched on: no kill switch, no coming-soon copy", () => {
    expect(page).not.toMatch(/ACCOUNTING_CONNECT_ENABLED/);
    expect(page).not.toMatch(/coming soon/i);
    expect(page).toMatch(/Connect to QuickBooks/);
  });

  it("starts the connect from ?connect=quickbooks only for someone who can manage settings", () => {
    const block = page.slice(page.indexOf('p("connect") === "quickbooks"'));
    expect(block.indexOf("if (!canManage)")).toBeGreaterThan(-1);
    expect(block.indexOf("if (!canManage)")).toBeLessThan(block.indexOf("void connect()"));
    // And the button is still drawn for everyone else.
    expect(page).toMatch(/Only an owner or office manager can connect QuickBooks/);
  });

  it("says QuickBooks is disconnected on ?disconnected=quickbooks, and has the server confirm it", () => {
    const block = page.slice(page.indexOf('p("disconnected") === "quickbooks"'));
    expect(block).toMatch(/QuickBooks is disconnected\./);
    expect(block.slice(0, 600)).toMatch(/confirmDisconnected\(\)/);
  });

  it("asks for a reconnect when the connection needs one, here and on the dashboard", () => {
    expect(page).toMatch(/conn\?\.status === "needs_reconnect"/);
    expect(page).toMatch(/Reconnect QuickBooks/);
    const dash = read("src/routes/_authenticated/dashboard.tsx");
    expect(dash).toMatch(/qbo\?\.connection\?\.status === "needs_reconnect"/);
    expect(dash).toMatch(/enabled: hasPermission\(role \?\? null, "manage_settings"\)/);
  });

  it("shows recent errors with Intuit's transaction id, and how to reach support", () => {
    expect(page).toMatch(/l\.intuit_tid/);
    expect(page).toMatch(/support@houndstack\.com/);
    expect(page).toMatch(/Questions about QuickBooks sync\? Email/);
    expect(page).not.toMatch(/Questions about QuickBooks sync\? See the/);
  });

  it("no longer takes tokens or a realm typed in by hand", () => {
    expect(page).not.toMatch(/access_token|refresh_token|Realm ID/);
  });
});

describe("Xero is gone", () => {
  const walk = (dir: string): string[] =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );

  it("has no callback route, no env read and no connect branch", () => {
    expect(existsSync(join(ROOT, "src/routes/api/public/hooks/xero-callback.ts"))).toBe(false);
    const offenders = walk("src")
      // The generated database types still describe the old enum value.
      // toPosix: on the Windows runner `join` gives backslashes (CLAUDE.md).
      .filter((f) => !toPosix(f).endsWith("integrations/supabase/types.ts"))
      .filter((f) => /XERO_|xero\.com|xero-callback|"xero"/i.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read(".env.example")).not.toMatch(/XERO_/);
  });
});
