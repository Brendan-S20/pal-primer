// #621, the three links from the Nov 2 device check (Pixel 10a, Android 17,
// main 48c1011f), each sent to a KILLED app, each landing on My Day:
//
//   https://app.houndstack.com/my-schedule
//   https://app.houndstack.com/profile
//   https://app.houndstack.com/invite/<token>
//
// Every case here starts the same way a cold start does: Capacitor already
// holds the launch URL (retainUntilConsumed) before any JS listens, the router
// is on `/` on its way to /auth, and /auth has not yet worked out who is
// signed in. Then the pieces arrive in each order a real launch can produce
// them, through the real lib/app-url-open.ts classifier and the real
// lib/pending-deep-link.ts hold, and the test reads where the app ends up.
//
// The fake keeps Capacitor's one rule that matters here: a retained event goes
// to the FIRST listener only (Plugin.addEventListener on Android, CAPPlugin on
// iOS). tests/the-first-listener-took-the-link.test.ts pins that cause; this
// file pins the outcome per link, plus the launch-time sign-out that used to
// throw the held link away before the sign-in form was even drawn.

import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (e: { url: string }) => void;
const cap = vi.hoisted(() => ({
  handlers: [] as Array<(e: { url: string }) => void>,
  retained: [] as Array<{ url: string }>,
  platform: "android",
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => cap.platform },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (name: string, fn: Handler) => {
      if (name !== "appUrlOpen") return { remove: async () => {} };
      cap.handlers.push(fn);
      if (cap.handlers.length === 1) for (const e of cap.retained.splice(0)) fn(e);
      return {
        remove: async () => {
          cap.handlers = cap.handlers.filter((h) => h !== fn);
        },
      };
    }),
  },
}));

/** The intent (Android) or URL context (iOS) that started the killed app. */
function launchedWith(url: string) {
  if (cap.handlers.length === 0) cap.retained.push({ url });
  else for (const h of [...cap.handlers]) h({ url });
}

let appUrl: typeof import("@/lib/app-url-open");
let pending: typeof import("@/lib/pending-deep-link");

beforeEach(async () => {
  cap.handlers = [];
  cap.retained = [];
  cap.platform = "android";
  vi.resetModules();
  appUrl = await import("@/lib/app-url-open");
  pending = await import("@/lib/pending-deep-link");
});

/**
 * The router, as far as the root's routeDeepLink and /auth's land() can see
 * it. Starts on `/`, as a cold start does, with the `/` -> /auth redirect in
 * flight until `settleOnAuth()`.
 */
function coldStartRouter() {
  let pathname = "/";
  let finishRedirect!: () => void;
  let inFlight: Promise<void> | null = new Promise<void>((r) => (finishRedirect = r));
  const visited: string[] = [];
  const router = {
    visited,
    get pathname() {
      return pathname;
    },
    /** routes/index.tsx's redirect to /auth resolves. */
    settleOnAuth() {
      pathname = "/auth";
      inFlight = null;
      finishRedirect();
    },
    go(to: string) {
      pathname = to;
      visited.push(to);
    },
    env(): import("@/lib/pending-deep-link").DeepLinkEnv {
      return {
        pathname: () => pathname,
        idle: () => inFlight ?? Promise.resolve(),
        push: (to) => router.go(to),
      };
    },
  };
  return router;
}
type Router = ReturnType<typeof coldStartRouter>;

/** __root.tsx: initAppLinks -> routeDeepLink. Returns the routing promises. */
async function rootSubscribes(router: Router) {
  const { initAppLinks } = await import("@/lib/native");
  const routed: Promise<void>[] = [];
  await initAppLinks((path) => routed.push(pending.routeDeepLink(path, router.env())));
  return routed;
}

/** /auth's OAuth hand-back listener (one import away, so usually first). */
async function authListens() {
  return appUrl.onAppUrl("other", () => {});
}

/** /auth's land(): the held link, else the role landing (a tech: My Day). */
function authResolvesAndLands(router: Router, roleLanding = "/my-day") {
  const link = pending.takeLinkForLanding();
  router.go(link ?? roleLanding);
}

/** The root's SIGNED_OUT handler (__root.tsx). */
function supabaseAnnouncesSignedOut() {
  pending.signedOut();
}

const LINKS = [
  { url: "https://app.houndstack.com/my-schedule", path: "/my-schedule", session: true },
  { url: "https://app.houndstack.com/profile", path: "/profile", session: true },
  {
    url: "https://app.houndstack.com/invite/3f9c2a7e-token",
    path: "/invite/3f9c2a7e-token",
    session: false,
  },
] as const;

describe.each(LINKS)("cold start with $path, signed in", ({ url, path, session }) => {
  it("link reaches the root before auth resolves: opens the link, not My Day", async () => {
    launchedWith(url);
    const router = coldStartRouter();
    await authListens(); // first listener: handed the retained URL, sorts it as a page
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    await Promise.all(routed);
    if (session) {
      // Held on /auth: pushing it now would only lose to the landing.
      expect(router.visited).toEqual([]);
      authResolvesAndLands(router);
    }
    expect(router.visited).toEqual([path]);
    expect(router.pathname).toBe(path);
  });

  it("auth resolves before the root has subscribed: the landing takes the waiting link", async () => {
    launchedWith(url);
    const router = coldStartRouter();
    await authListens();
    router.settleOnAuth();
    authResolvesAndLands(router);
    expect(router.visited).toEqual([path]);
    // The root subscribes late and finds nothing to deliver twice.
    await Promise.all(await rootSubscribes(router));
    expect(router.visited).toEqual([path]);
  });

  it("the root listens first (no /auth listener yet): still the link", async () => {
    launchedWith(url);
    const router = coldStartRouter();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    await Promise.all(routed);
    await authListens();
    if (session) authResolvesAndLands(router);
    expect(router.visited).toEqual([path]);
  });

  it("Capacitor delivers only after auth has landed on My Day: the link follows", async () => {
    const router = coldStartRouter();
    await authListens();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    authResolvesAndLands(router); // nothing waiting yet: My Day
    launchedWith(url);
    await Promise.all(routed);
    expect(router.visited).toEqual(["/my-day", path]);
    expect(router.pathname).toBe(path);
  });
});

describe.each(LINKS)("cold start with $path, saved session expired", ({ url, path, session }) => {
  it("the launch's own SIGNED_OUT does not throw the link away", async () => {
    launchedWith(url);
    const router = coldStartRouter();
    await authListens();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    await Promise.all(routed);
    // supabase-js refreshes the stored session while it starts, the auth
    // server refuses it, and the client says SIGNED_OUT: the form goes up.
    supabaseAnnouncesSignedOut();
    if (session) {
      expect(router.visited).toEqual([]);
      authResolvesAndLands(router); // handleSignIn -> land()
    }
    expect(router.visited).toEqual([path]);
  });
});

describe("a sign-out after somebody landed still forgets", () => {
  it("the next account on this phone does not inherit the link", async () => {
    const router = coldStartRouter();
    await authListens();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    authResolvesAndLands(router); // tech A on My Day
    pending.holdDeepLink("/profile"); // a link held for tech A
    supabaseAnnouncesSignedOut(); // tech A signs out
    await Promise.all(routed);
    expect(pending.peekDeepLink()).toBeNull();
    authResolvesAndLands(router); // tech B signs in
    expect(router.pathname).toBe("/my-day");
  });
});

describe("iOS, from a killed app", () => {
  it("a Universal Link to /invite takes the same road", async () => {
    cap.platform = "ios";
    launchedWith("https://app.houndstack.com/invite/tok");
    const router = coldStartRouter();
    await authListens();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    await Promise.all(routed);
    expect(router.visited).toEqual(["/invite/tok"]);
  });

  it("the Live Activity Start link opens My Day on that stop, not the bare role landing", async () => {
    cap.platform = "ios";
    const visit = "11111111-1111-4111-8111-111111111111";
    launchedWith(
      `consulting.thenorth.houndstack://open/my-day?date=2026-11-12&visit=${visit}&action=start`,
    );
    const router = coldStartRouter();
    await authListens();
    const routed = await rootSubscribes(router);
    router.settleOnAuth();
    await Promise.all(routed);
    expect(router.visited).toEqual([]); // My Day needs a session: held for /auth
    authResolvesAndLands(router);
    expect(router.visited).toEqual([`/my-day?date=2026-11-12&visit=${visit}&action=start`]);
  });
});

describe("where each link is claimed", () => {
  it("Android App Links claim all three, and the manifest agrees", async () => {
    const { appLinkTarget } = await import("@/lib/android-app-links");
    for (const { url, path } of LINKS) expect(appLinkTarget(url)).toBe(path);
  });

  it("iOS Universal Links claim /invite only (staff pages stay on the custom scheme)", async () => {
    const { UNIVERSAL_LINK_PATHS } = await import("@/lib/ios-universal-links");
    expect(UNIVERSAL_LINK_PATHS).toEqual(["/invite/*"]);
  });
});
