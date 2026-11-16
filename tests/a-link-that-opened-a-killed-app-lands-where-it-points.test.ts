// #621, the web half of the proof plan HoundStack Product accepted on
// 2026-11-16: /my-schedule, /profile and /invite/<token>, signed in and
// signed out, from a KILLED app, ends on the linked page.
//
// On the Pixel 10a (Nov 2, main 48c1011f) all three landed on My Day. The
// first cause, Capacitor handing a cold-start link to the first appUrlOpen
// listener only, is pinned by tests/the-first-listener-took-the-link.test.ts
// (#700). This file drives the whole cold start instead, with a router that
// behaves like the real one where it matters:
//
//   - a navigation is not instant. The route's code is loaded from the
//     bundle first (autoCodeSplitting), and a later navigation supersedes
//     one still loading;
//   - router.latestLocation moves the moment something pushes, while the
//     page on screen, and so whether /auth is still mounted, changes only
//     when the new page has loaded;
//   - the _authenticated guard sends a signed-out visitor to /auth and holds
//     the page for after sign-in (returnHereAfterSignIn).
//
// Each link is run through every order its pieces can arrive in on a phone:
// the Capacitor event, the root's subscription, /auth's identity answer and
// the linked page's code. The one that still failed after #700: an
// invitation, signed in. The root pushes it straight away (it needs no
// session), /auth is still mounted while the invite page's code loads, and
// /auth's landing then navigated to My Day over it.
//
// The Android half (the intent reaching appUrlOpen intact, cold and warm) is
// android/app/src/test/.../ColdStartLinkTest.java. App.getLaunchUrl() is not
// read anywhere in src/ on purpose (lib/native.ts initAppLinks says why: it
// would navigate a cold-start link twice); that test shows it carries the
// same URL as the event, so nothing is lost by not reading it.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Handler = (e: { url: string }) => void;
const cap = vi.hoisted(() => ({
  handlers: [] as Array<(e: { url: string }) => void>,
  retained: [] as Array<{ url: string }>,
  /** Resolves addListener; held back to model a slow bridge round trip. */
  attachGate: null as Promise<void> | null,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    // Plugin.addEventListener + sendRetainedArgumentsForEvent: the first
    // listener gets the retained launch event, and nobody after it does.
    addListener: vi.fn(async (name: string, fn: Handler) => {
      if (cap.attachGate) await cap.attachGate;
      if (name !== "appUrlOpen") return { remove: async () => {} };
      cap.handlers.push(fn);
      if (cap.handlers.length === 1) for (const e of cap.retained.splice(0)) fn(e);
      return { remove: async () => {} };
    }),
  },
}));

/** Plugin.notifyListeners(..., retainUntilConsumed = true). */
function capacitorDelivers(url: string) {
  if (cap.handlers.length === 0) cap.retained.push({ url });
  else for (const h of [...cap.handlers]) h({ url });
}

let appUrl: typeof import("@/lib/app-url-open");
let pending: typeof import("@/lib/pending-deep-link");

beforeEach(async () => {
  cap.handlers = [];
  cap.retained = [];
  cap.attachGate = null;
  vi.useRealTimers();
  vi.resetModules();
  appUrl = await import("@/lib/app-url-open");
  pending = await import("@/lib/pending-deep-link");
});

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

/** The router, as far as a cold start can tell. */
function coldRouter(session: { signedIn: boolean }) {
  const chunkGates = new Map<string, Promise<void>>();
  const s = {
    /** router.latestLocation.pathname: moves on push. */
    latest: "/",
    /** The page on screen. /auth's effects live while this is /auth. */
    shown: "/",
    shownHistory: [] as string[],
    inFlight: 0,
    idleWaiters: [] as Array<() => void>,
  };

  const settle = () => {
    if (s.inFlight === 0) for (const w of s.idleWaiters.splice(0)) w();
  };

  const go = (to: string) => {
    s.latest = to;
    s.inFlight++;
    void (async () => {
      const pathname = to.split(/[?#]/)[0];
      const chunk = [...chunkGates.entries()].find(([p]) => pathname.startsWith(p))?.[1];
      await (chunk ?? Promise.resolve());
      await Promise.resolve();
      if (s.latest === to) {
        // routes/index.tsx: `/` always redirects to /auth.
        if (pathname === "/") go("/auth");
        // _authenticated/route.tsx beforeLoad: no session, hold the page,
        // go to /auth.
        else if (pathname !== "/auth" && pending.needsSession(to) && !session.signedIn) {
          (await import("@/lib/signed-out")).returnHereAfterSignIn(to);
          go("/auth");
        } else {
          s.shown = to;
          s.shownHistory.push(to);
        }
      } // else superseded by a later navigation
      s.inFlight--;
      settle();
    })();
  };

  return {
    s,
    go,
    /** Hold a route's code back, as a slow first load from the bundle. */
    slowChunk(prefix: string) {
      const g = gate();
      chunkGates.set(prefix, g.p);
      return g.open;
    },
    idle: () =>
      new Promise<void>((resolve) => {
        if (s.inFlight === 0) resolve();
        else s.idleWaiters.push(resolve);
      }),
  };
}

type Router = ReturnType<typeof coldRouter>;

/** __root.tsx: initAppLinks -> routeDeepLink, plus the SIGNED_OUT listener. */
async function rootSubscribes(router: Router) {
  const { initAppLinks } = await import("@/lib/native");
  await initAppLinks((path) => {
    void pending.routeDeepLink(path, {
      pathname: () => router.s.latest,
      idle: router.idle,
      push: (to) => router.go(to),
    });
  });
}

/** auth.tsx's land(), line for line (pinned below). */
function land(router: Router, roleLanding: string) {
  const link = pending.takeLinkForLanding();
  if (link) router.go(link);
  else if (pending.roleLandingStillOurs(router.s.latest)) router.go(roleLanding);
}

/**
 * auth.tsx on a cold start: subscribes for the OAuth hand-back, and asks who
 * is signed in. `identity` is when that answer (and the bootstrap and landing
 * path lookups after it) comes back. The effect is cancelled when /auth
 * unmounts, i.e. when another page is on screen.
 */
async function authMounts(router: Router, session: { signedIn: boolean }, identity: Promise<void>) {
  // Fire and forget, as the effect does: on a slow bridge this is still
  // waiting for Capacitor when the identity answer comes back.
  void appUrl.onAppUrl("other", () => {});
  await flush(1);
  void (async () => {
    await identity;
    if (router.s.shown !== "/auth") return; // unmounted: cancelled
    if (!session.signedIn) return; // the form stays up
    pending.signedInAgain();
    land(router, "/my-day");
  })();
}

/** handleSignIn on the form: a password accepted, then land(). */
function signsIn(router: Router, session: { signedIn: boolean }) {
  session.signedIn = true;
  pending.signedInAgain();
  land(router, "/my-day");
}

const LINKS = [
  ["/my-schedule", "https://app.houndstack.com/my-schedule"],
  ["/profile", "https://app.houndstack.com/profile"],
  ["/invite/3f9c2a7e", "https://app.houndstack.com/invite/3f9c2a7e"],
] as const;

/** Every order the pieces of a cold start can arrive in on a phone. */
const ORDERS = [
  "root subscribes, then /auth hears who is signed in",
  "/auth hears who is signed in before the root subscribes",
  "the bridge is slow: /auth hears who is signed in before Capacitor hands the link over",
  "the linked page's code loads slowly from the bundle",
] as const;

async function coldStart(url: string, signedIn: boolean, order: (typeof ORDERS)[number]) {
  const session = { signedIn };
  const router = coldRouter(session);
  const identity = gate();
  const bridge = gate();
  const target = new URL(url).pathname;
  const releaseChunk =
    order === ORDERS[3]
      ? router.slowChunk(target.startsWith("/invite") ? "/invite" : target)
      : null;
  if (order === ORDERS[2]) cap.attachGate = bridge.p;

  capacitorDelivers(url); // the intent that started the killed app
  router.go("/"); // the web view boots at capacitor://localhost/ or https://localhost/
  await flush();
  expect(router.s.shown).toBe("/auth");

  await authMounts(router, session, identity.p);
  if (order === ORDERS[0] || order === ORDERS[3]) {
    await rootSubscribes(router);
    await flush();
    identity.open();
    await flush();
  } else if (order === ORDERS[1]) {
    identity.open();
    await flush();
    await rootSubscribes(router);
    await flush();
  } else {
    const rooted = rootSubscribes(router);
    identity.open();
    await flush();
    bridge.open();
    await rooted;
    await flush();
  }
  releaseChunk?.();
  await flush();
  return { router, session };
}

describe("a link that opened a killed app ends on the page it names", () => {
  for (const [path, url] of LINKS) {
    for (const order of ORDERS) {
      it(`signed in, ${path}: ${order}`, async () => {
        const { router } = await coldStart(url, true, order);
        expect(router.s.shown).toBe(path);
        expect(router.s.latest).toBe(path);
      });

      it(`signed out, ${path}: ${order}`, async () => {
        const { router, session } = await coldStart(url, false, order);
        if (path.startsWith("/invite/")) {
          // Needs no session: the invite page says who it is for and offers
          // sign-in itself (routes/invite.$token.tsx).
          expect(router.s.shown).toBe(path);
          return;
        }
        // A staff page: the sign-in form, with the link kept behind it...
        expect(router.s.shown).toBe("/auth");
        // ...and on to the link once the password is accepted.
        signsIn(router, session);
        await flush();
        expect(router.s.shown).toBe(path);
      });
    }
  }
});

describe("what it must not do", () => {
  it("no link: the role landing, as before", async () => {
    const session = { signedIn: true };
    const router = coldRouter(session);
    router.go("/");
    await flush();
    await authMounts(router, session, Promise.resolve());
    await rootSubscribes(router);
    await flush();
    expect(router.s.shown).toBe("/my-day");
  });

  it("a link held past the ten-minute TTL is dropped: sign-in lands on the role page", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    const session = { signedIn: false };
    const router = coldRouter(session);
    capacitorDelivers("https://app.houndstack.com/profile");
    router.go("/");
    await flush();
    await authMounts(router, session, Promise.resolve());
    await rootSubscribes(router);
    await flush();
    expect(router.s.shown).toBe("/auth");
    vi.setSystemTime(t0 + pending.DEEP_LINK_TTL_MS + 1);
    signsIn(router, session);
    await flush();
    expect(router.s.shown).toBe("/my-day");
  });

  it("a link still waiting for the root expires on the same clock", async () => {
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    await appUrl.onAppUrl("other", () => {}); // /auth attaches; nobody holds "path" yet
    capacitorDelivers("https://app.houndstack.com/profile");
    expect(appUrl.WAITING_URL_TTL_MS).toBe(pending.DEEP_LINK_TTL_MS);
    vi.setSystemTime(t0 + appUrl.WAITING_URL_TTL_MS + 1);
    expect(pending.takeLinkForLanding()).toBeNull();
  });

  it("sign-out after landing forgets a link, held or still waiting for the root", async () => {
    await appUrl.onAppUrl("other", () => {});
    pending.markLanded();
    capacitorDelivers("https://app.houndstack.com/profile"); // waiting: no root yet
    pending.holdDeepLink("/my-schedule"); // held
    pending.signedOut();
    expect(pending.takeLinkForLanding()).toBeNull();
    expect(appUrl.takeWaitingAppUrl("path")).toBeNull();
  });

  it("an intentional sign-out forgets it too", async () => {
    await appUrl.onAppUrl("other", () => {});
    capacitorDelivers("https://app.houndstack.com/profile");
    pending.beginSignOut();
    expect(pending.takeLinkForLanding()).toBeNull();
    pending.__resetDeepLinkForTests();
  });

  it("sign-in from /auth with nothing held still lands, on /auth and its sub-paths", () => {
    expect(pending.roleLandingStillOurs("/")).toBe(true);
    expect(pending.roleLandingStillOurs("/auth")).toBe(true);
    expect(pending.roleLandingStillOurs("/auth/callback")).toBe(true);
    expect(pending.roleLandingStillOurs("/invite/3f9c2a7e")).toBe(false);
    expect(pending.roleLandingStillOurs("/my-day")).toBe(false);
  });
});

describe("the wiring this file models", () => {
  const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

  it("auth.tsx's land() is the one above: held link, else the role landing only from /auth", () => {
    expect(src("src/routes/auth.tsx")).toMatch(
      /const link = takeLinkForLanding\(\);\s*if \(link\) router\.history\.push\(link\);[\s\S]{0,400}?else if \(roleLandingStillOurs\(router\.latestLocation\.pathname\)\) navigate\(\{ to \}\);/,
    );
  });

  it("the root routes a link with the router's own pathname, idle and push", () => {
    expect(src("src/routes/__root.tsx")).toMatch(
      /routeDeepLink\(path, \{\s*pathname: \(\) => router\.state\.location\.pathname,\s*idle,\s*push: \(to\) => router\.history\.push\(to\),/,
    );
  });
});
