/**
 * #785, the regression after Product Verified (2026-11-10).
 *
 * #799 fixed the cold sign-in: a good password that the guard bounced back to
 * /auth now lands on the password step with SIGN_IN_BOUNCED_MESSAGE. Then QA
 * signed OUT of the same Incognito session and signed in again, and the first
 * attempt came back to the blank email step with no error. Three holes:
 *
 *   1. watchSignInLanding decided on the FIRST resolved navigation. Anything
 *      but /auth cleared the hand-off, so a later bounce to /auth looked like
 *      a first visit.
 *   2. The _authenticated guard held `location.href` as the return path:
 *      `/auth` pushes it with router.history.push, which takes a path. Nothing
 *      stopped /auth itself being held either.
 *   3. Nothing dropped a held return path on an intentional sign-out on the
 *      web (forgetDeepLink ran on SIGNED_OUT on native only), and a guard
 *      running during the sign-out could hold the page being left.
 *
 * The rule pinned here, from the triage: sign out, then sign in once with a
 * good password, and the person either lands in the app or stays on the
 * password step with the bounced message. Never a blank email step.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetDeepLinkForTests,
  asReturnPath,
  beginSignOut,
  holdDeepLink,
  signedInAgain,
  takeLinkForLanding,
} from "@/lib/pending-deep-link";
import { returnHereAfterSignIn } from "@/lib/signed-out";
import {
  handOffSignIn,
  SIGN_IN_BOUNCED,
  signInLanded,
  takeBouncedSignIn,
  watchSignInLanding,
} from "@/lib/sign-in-handoff";

const ORIGIN = "https://app.houndstack.com";

function read(rel: string): string {
  return readFileSync(join(import.meta.dirname, "..", rel), "utf8");
}

type Resolved = (e: { toLocation: { pathname: string } }) => void;

/** Just enough of a tab: sessionStorage, an origin, and a place for /auth's
 *  bounce listener. */
function installWindow() {
  const data = new Map<string, string>();
  const fired: string[] = [];
  vi.stubGlobal("window", {
    location: { origin: ORIGIN },
    sessionStorage: {
      getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
    },
    dispatchEvent: (e: Event) => (fired.push(e.type), true),
  });
  return { fired };
}

/** The router's onResolved, driven by hand. */
function fakeRouter() {
  const listeners = new Set<Resolved>();
  return {
    subscribe: (_event: "onResolved", fn: Resolved) => {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    resolve: (pathname: string) => {
      for (const fn of [...listeners]) fn({ toLocation: { pathname } });
    },
    get watching() {
      return listeners.size;
    },
  };
}

beforeEach(() => {
  __resetDeepLinkForTests();
  signInLanded();
});
afterEach(() => {
  signInLanded();
  __resetDeepLinkForTests();
  vi.unstubAllGlobals();
});

describe("sign out, then sign in once with a good password", () => {
  it("a bounce after a page on the way still puts the password step back, with the reason", () => {
    const { fired } = installWindow();
    const router = fakeRouter();

    // Signed in on Settings -> Users; a save found the session gone and held
    // the page as a FULL URL, the way the guard's location.href could.
    returnHereAfterSignIn(`${ORIGIN}/settings/users?tab=staff`);
    // The person signs out on purpose (signOutAndClearDevice does this first).
    beginSignOut();
    signInLanded();
    // The guard runs while the sign-out is still in flight: it must not hold.
    returnHereAfterSignIn(`${ORIGIN}/settings/users?tab=staff`);
    returnHereAfterSignIn("/dashboard");

    // /auth, signed out. A good password.
    signedInAgain();
    handOffSignIn("owner@example.test", "correct horse battery");
    watchSignInLanding(router.subscribe);
    // land(): nothing left over from the old session to send them to.
    expect(takeLinkForLanding()).toBeNull();

    // The first resolve is a signed-in page; then the guard bounces.
    router.resolve("/dashboard");
    expect(fired).toEqual([]);
    router.resolve("/auth");

    expect(fired).toEqual([SIGN_IN_BOUNCED]);
    // What /auth's restoreBouncedSignIn puts back: email, password, step 2.
    expect(takeBouncedSignIn()).toEqual({
      email: "owner@example.test",
      password: "correct horse battery",
    });
    expect(router.watching).toBe(0);
  });

  it("a bounce onto a freshly drawn /auth (the listener was not there) is still taken on mount", () => {
    installWindow();
    const router = fakeRouter();
    beginSignOut();
    signInLanded();
    signedInAgain();
    handOffSignIn("owner@example.test", "pw");
    watchSignInLanding(router.subscribe, null);
    router.resolve("/onboarding");
    router.resolve("/auth");
    // /auth's run() effect, identity not ok: restoreBouncedSignIn().
    expect(takeBouncedSignIn()).toMatchObject({ email: "owner@example.test" });
  });

  it("a sign-in that lands is dropped once the shell draws, so a later sign-out is not called a failure", () => {
    const { fired } = installWindow();
    const router = fakeRouter();
    signedInAgain();
    handOffSignIn("owner@example.test", "pw");
    watchSignInLanding(router.subscribe);
    router.resolve("/dashboard");
    signInLanded(); // SignedInApp mounted
    beginSignOut(); // and later signs out
    signInLanded();
    router.resolve("/auth");
    expect(fired).toEqual([]);
    expect(takeBouncedSignIn()).toBeNull();
  });

  it("a sign-out drops a hand-off still held, even before the shell drew", () => {
    const { fired } = installWindow();
    const router = fakeRouter();
    handOffSignIn("owner@example.test", "pw");
    watchSignInLanding(router.subscribe);
    // signOutAndClearDevice's first two lines.
    beginSignOut();
    signInLanded();
    router.resolve("/auth");
    expect(fired).toEqual([]);
    expect(takeBouncedSignIn()).toBeNull();
  });

  it("after the next sign-in, the guard may hold a page again (#659 still works)", () => {
    installWindow();
    beginSignOut();
    returnHereAfterSignIn("/clients/abc");
    expect(takeLinkForLanding()).toBeNull();
    signedInAgain();
    returnHereAfterSignIn("/clients/abc");
    expect(takeLinkForLanding()).toBe("/clients/abc");
  });
});

describe("a return path is a path (lib/pending-deep-link.ts)", () => {
  beforeEach(() => {
    installWindow();
  });

  it("a full URL on this origin is held as its path", () => {
    returnHereAfterSignIn(`${ORIGIN}/clients/abc?tab=visits#notes`);
    expect(takeLinkForLanding()).toBe("/clients/abc?tab=visits#notes");
  });

  it("another origin is never held", () => {
    returnHereAfterSignIn("https://example.test/clients/abc");
    returnHereAfterSignIn("//example.test/clients/abc");
    expect(takeLinkForLanding()).toBeNull();
  });

  it("/auth itself is never held as a return path, as a path or as a URL", () => {
    for (const link of ["/auth", "/auth?invite=x", `${ORIGIN}/auth`, `${ORIGIN}/auth#x`]) {
      expect(asReturnPath(link), link).toBeNull();
      returnHereAfterSignIn(link);
      expect(takeLinkForLanding(), link).toBeNull();
    }
  });

  it("an app link is still held while signed out, and as a path", () => {
    beginSignOut();
    holdDeepLink(`${ORIGIN}/my-day?visit=1`);
    expect(takeLinkForLanding()).toBe("/my-day?visit=1");
  });
});

describe("the wiring", () => {
  it("the guard holds a path, not location.href", () => {
    const guard = read("src/routes/_authenticated/route.tsx");
    expect(guard).not.toMatch(/returnHereAfterSignIn\(location\.href\)/);
    expect(guard).toMatch(
      /returnHereAfterSignIn\(`\$\{location\.pathname\}\$\{location\.searchStr\}`\);\s*throw redirect\(\{ to: "\/auth" \}\);/,
    );
  });

  it("the signed-in shell is what declares the sign-in landed", () => {
    const guard = read("src/routes/_authenticated/route.tsx");
    expect(guard).toMatch(
      /function useSignInLanded\(\) \{\s*useEffect\(\(\) => \{\s*signInLanded\(\);\s*\}, \[\]\);/,
    );
    expect(guard).toMatch(/function AppShell\(\) \{\s*useApiRecovery\(\);\s*useSignInLanded\(\);/);
  });

  it("every intentional sign-out drops the return path and the hand-off before it awaits anything", () => {
    const src = read("src/lib/offline/read-cache.ts");
    const at = src.indexOf("export async function signOutAndClearDevice()");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    const begin = body.indexOf("beginSignOut();");
    const landed = body.indexOf("signInLanded();");
    const firstAwait = body.indexOf("await ");
    expect(begin).toBeGreaterThan(0);
    expect(landed).toBeGreaterThan(0);
    expect(begin).toBeLessThan(firstAwait);
    expect(landed).toBeLessThan(firstAwait);
  });

  it("/auth lets the guard hold again only once a password was accepted", () => {
    const src = read("src/routes/auth.tsx");
    const at = src.indexOf("const handleSignIn");
    const handleSignIn = src.slice(at, src.indexOf("\n  };\n", at));
    const again = handleSignIn.indexOf("signedInAgain();");
    expect(again).toBeGreaterThan(handleSignIn.indexOf("if (error)"));
    expect(again).toBeLessThan(handleSignIn.indexOf("handOffSignIn(email, password)"));
  });
});
