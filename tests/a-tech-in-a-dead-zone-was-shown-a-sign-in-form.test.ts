// The native app boots at `capacitor://localhost/`. `routes/index.tsx` sends
// `/` to `/auth` unconditionally, so `/auth` is the screen EVERY cold launch
// lands on, and its "already signed in? go onward" effect is the only thing
// that moves a signed-in tech into the app.
//
// That effect asked `supabase.auth.getUser()` — a network call — and returned
// early when it failed. iOS QA 2026-08-20, with Wi-Fi off: kill the app,
// relaunch, and it renders the sign-in form. Reading the WebView's localStorage
// straight off disk immediately afterwards showed the Supabase session AND
// `hs:offline-reads:*` both still there. Nothing was signed out; the boot path
// simply refused to look at the device before asking the network.
//
// A tech in a dead zone was therefore shown a form they cannot submit, because
// submitting it needs the network they do not have.
//
// These are structural assertions on the source, in the same spirit as the
// other static tests here: the runtime behaviour needs a device with its radio
// off, which no unit test can arrange. Each one is written so that the version
// that actually shipped fails it.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLandingPath, LANDING_PATHS, LAST_LANDING_KEY } from "@/lib/offline/read-cache-policy";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Comments describe the rule; only code enforces it. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const AUTH_PAGE = "src/routes/auth.tsx";
const AUTH_ROUTE = "src/routes/_authenticated/route.tsx";
const IDENTITY = "src/lib/offline/identity.ts";

describe("the screen a cold native launch lands on", () => {
  const src = codeOnly(read(AUTH_PAGE));

  it("still redirects `/` here, which is why this page carries the burden", () => {
    // If this ever stops being true the assertions below are aimed at the
    // wrong file, and the sign-in wall could come back somewhere else.
    expect(codeOnly(read("src/routes/index.tsx"))).toMatch(/redirect\(\{\s*to:\s*"\/auth"/);
  });

  it("resolves who is signed in with the offline-tolerant resolver", () => {
    expect(src, "auth.tsx no longer calls resolveIdentity").toMatch(/resolveIdentity\(\)/);
  });

  it("takes the same path on the web, where a bare getUser() stopped the cold start (#661)", () => {
    // The web used to ask getUser() and return when it failed. With the API
    // unreachable that parked a signed-in user here until a reload. Both
    // builds now resolve through the shared resolver; see
    // tests/a-web-cold-start-with-the-api-down.test.tsx.
    expect(src, "the web bounce on a bare getUser() is back").not.toMatch(
      /supabase\.auth\.getUser\(\)\s*\.then/,
    );
  });
});

describe("the identity resolver", () => {
  const src = codeOnly(read(IDENTITY));

  it("asks the native-aware signal in the native bundle", () => {
    // connectivity.ts exists because a WKWebView resumed from a dead zone can
    // still report onLine === true. The hosted app keeps navigator.onLine,
    // which is what its own copy of this function always used.
    expect(src).toMatch(/isDefinitelyOffline\(\)/);
    expect(src, "the offline signal is no longer gated on the build").toMatch(
      /IS_NATIVE_BUNDLE[\s\S]{0,120}isDefinitelyOffline/,
    );
    expect(src, "the web branch lost navigator.onLine").toMatch(/navigator\.onLine/);
  });

  it("bounds both auth calls in the native bundle, because this runs on every boot", () => {
    // getSession() refreshes an expired token over the network first, and
    // offline that hangs — see lib/offline/action-owner.ts. Unbounded there
    // means a permanently blank app rather than a slow one. On the web the
    // await is plain, exactly as it was.
    expect(src).toMatch(/withDeadline\(getUser, IDENTITY_DEADLINE_MS/);
    expect(src).toMatch(/withDeadline\(getSession, SESSION_DEADLINE_MS/);
    expect(src, "the deadlines are no longer gated on the build").toMatch(
      /IS_NATIVE_BUNDLE[\s\S]{0,80}withDeadline\(getUser/,
    );
  });

  it("reads a timeout as 'could not ask', never as 'the answer was no'", () => {
    // An ActionTimeout carries no status and its message says nothing about
    // the network, so leaving it to isOfflineAuthFailure's text matching would
    // fall through to the online flag and could wipe the device.
    expect(src).toMatch(/instanceof ActionTimeout/);
    const at = src.indexOf("ActionTimeout");
    const rejected = src.indexOf("rejected: true");
    expect(at, "ActionTimeout is no longer handled").toBeGreaterThan(-1);
    expect(at, "the timeout check must come before the rejection decision it guards").toBeLessThan(
      rejected,
    );
  });
});

describe("the authenticated tree agrees with it", () => {
  const src = codeOnly(read(AUTH_ROUTE));

  it("shares the same resolver rather than keeping a second copy", () => {
    // Two copies is how the two screens drift into disagreeing about who is
    // signed in, which is the state that produced the wall.
    expect(src).toMatch(/from "@\/lib\/offline\/identity"/);
    expect(src, "a second resolveIdentity has grown back in the route file").not.toMatch(
      /(async )?function resolveIdentity/,
    );
  });

  it("uses the native-aware signal in the native bundle, and keeps the web one", () => {
    expect(src).toMatch(/isDefinitelyOffline\(\)/);
    expect(src).toMatch(/IS_NATIVE_BUNDLE/);
    expect(src, "the hosted app's offline signal was removed").toMatch(/navigator\.onLine/);
  });
});

describe("the remembered landing path", () => {
  it("is swept by sign-out, because it is a role hint on a shared tablet", () => {
    // clearPersistedReadCaches deletes by prefix. A key outside it would
    // survive a sign-out, which is the bug prefix sweeping exists to prevent.
    expect(LAST_LANDING_KEY.startsWith("hs:offline-reads:")).toBe(true);
  });

  it("validates on the way out, since it is the target of a navigate()", () => {
    for (const p of LANDING_PATHS) expect(isLandingPath(p)).toBe(true);
    expect(isLandingPath("https://evil.example.com")).toBe(false);
    expect(isLandingPath("/settings/billing")).toBe(false);
    expect(isLandingPath(null)).toBe(false);
    expect(isLandingPath(42)).toBe(false);
  });

  it("keeps a tech on /my-day when the role lookup cannot run", () => {
    // The fallback that matters. A blanket /dashboard sends the one role whose
    // job happens where the signal is worst to a page they do not use.
    const src = codeOnly(read(AUTH_PAGE));
    expect(src).toMatch(/rememberLandingPath\(/);
    expect(src).toMatch(/readLandingPath\(\)/);
    expect(src, "no fallback when the landing path cannot be computed").toMatch(
      /\?\?\s*"\/dashboard"/,
    );
  });

  it("makes no request at all when the device knows it is offline", () => {
    // The short-circuit. Without it the known-offline case still issues two
    // Supabase calls whose only possible outcome is a wait.
    const src = codeOnly(read(AUTH_PAGE));
    const fn = src.slice(src.indexOf("async function landingPathForUser"));
    expect(fn.slice(0, 400), "landingPathForUser does not check isDefinitelyOffline first").toMatch(
      /isDefinitelyOffline\(\)/,
    );
  });

  it("bounds the landing lookup, because a hang here is the same wall", () => {
    // The bug this test exists for the second time: resolveIdentity recovered
    // the user from the device correctly, and then landingPathForUser sat on an
    // unbounded supabase.rpc() against a dead network — which does not reject,
    // it hangs — so navigate() was never reached and the sign-in form stayed
    // up. A try/catch cannot catch a promise that never settles.
    const src = codeOnly(read(AUTH_PAGE));
    const fn = src.slice(src.indexOf("async function landingPathForUser"));
    expect(fn.slice(0, 1200), "the landing lookup is unbounded again").toMatch(/withDeadline\(/);
  });
});
