// #621, on a Pixel 10a (Android 17, main 48c1011f): a staff link sent to a
// KILLED app always landed on My Day; the same link to the running app
// opened the right page.
//
// Capacitor keeps a cold-start link until something listens for appUrlOpen,
// then gives it to the FIRST listener only (Plugin.addEventListener ->
// sendRetainedArgumentsForEvent, then the retained list is dropped). /auth's
// OAuth listener, one import away, attached before the root's, was handed the
// staff link, ignored it as "not an auth-callback", and the root never saw
// it. /auth then landed the tech on My Day, where the close-out prompt sits.
//
// The fake below keeps Capacitor's semantics exactly, so these tests fail on
// the old two-listener wiring and pass on lib/app-url-open.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

type Handler = (e: { url: string }) => void;
const cap = vi.hoisted(() => ({
  handlers: [] as Array<(e: { url: string }) => void>,
  retained: [] as Array<{ url: string }>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    // Plugin.addEventListener: the first listener gets the retained events,
    // and they are gone after that.
    addListener: vi.fn(async (name: string, fn: Handler) => {
      if (name !== "appUrlOpen") return { remove: async () => {} };
      cap.handlers.push(fn);
      if (cap.handlers.length === 1) {
        const r = cap.retained.splice(0);
        for (const e of r) fn(e);
      }
      return {
        remove: async () => {
          cap.handlers = cap.handlers.filter((h) => h !== fn);
        },
      };
    }),
  },
}));

/** Plugin.notifyListeners(..., retainUntilConsumed = true). */
function capacitorDelivers(url: string) {
  if (cap.handlers.length === 0) cap.retained.push({ url });
  else for (const h of [...cap.handlers]) h({ url });
}

const STAFF = "https://app.houndstack.com/profile";
const OAUTH = "consulting.thenorth.houndstack://auth-callback#access_token=x";

let appUrl: typeof import("@/lib/app-url-open");
let pending: typeof import("@/lib/pending-deep-link");

beforeEach(async () => {
  cap.handlers = [];
  cap.retained = [];
  vi.resetModules();
  appUrl = await import("@/lib/app-url-open");
  pending = await import("@/lib/pending-deep-link");
});

/** The router as far as routeDeepLink can see it. */
function fakeRouter(start: string) {
  let pathname = start;
  let inFlight: Promise<void> | null = null;
  const pushes: string[] = [];
  return {
    pushes,
    get pathname() {
      return pathname;
    },
    go(to: string) {
      pathname = to;
      pushes.push(to);
    },
    /** A navigation still resolving (My Day's loader, the close-out query). */
    navigateSlowly(to: string) {
      let done!: () => void;
      inFlight = new Promise<void>((r) => (done = r));
      return () => {
        pathname = to;
        inFlight = null;
        done();
      };
    },
    env(): import("@/lib/pending-deep-link").DeepLinkEnv {
      return {
        pathname: () => pathname,
        idle: () => inFlight ?? Promise.resolve(),
        push: (to) => this.go(to),
      };
    },
  };
}

/** The root's wiring in __root.tsx: initAppLinks -> routeDeepLink. */
async function rootSubscribes(router: ReturnType<typeof fakeRouter>) {
  const { initAppLinks } = await import("@/lib/native");
  const routed: Promise<void>[] = [];
  await initAppLinks((path) => {
    routed.push(pending.routeDeepLink(path, router.env()));
  });
  await Promise.all(routed);
  return routed;
}

/** /auth's OAuth hand-back listener. */
async function authSubscribes() {
  const got: string[] = [];
  const off = await appUrl.onAppUrl("other", (u) => got.push(u));
  return { got, off };
}

/** /auth's land(): the held link, or the role landing. */
function authLands(router: ReturnType<typeof fakeRouter>, roleLanding = "/my-day") {
  const link = pending.takeLinkForLanding();
  router.go(link ?? roleLanding);
}

describe("the cause, as it shipped in 48c1011f", () => {
  it("two raw appUrlOpen listeners: the one added second never sees the cold-start link", async () => {
    capacitorDelivers(STAFF);
    const { App } = await import("@capacitor/app");
    const authSaw: string[] = [];
    const rootSaw: string[] = [];
    await App.addListener("appUrlOpen", ({ url }) => authSaw.push(url)); // /auth, one import away
    await App.addListener("appUrlOpen", ({ url }) => rootSaw.push(url)); // __root, several
    expect(authSaw).toEqual([STAFF]); // completeNativeOAuth -> null, dropped
    expect(rootSaw).toEqual([]); // so nothing held it, and /auth landed on My Day
  });
});

describe("a cold start, signed in", () => {
  it("the staff link wins even though /auth listens first and lands before the root subscribes", async () => {
    capacitorDelivers(STAFF); // the intent that started the killed app
    const router = fakeRouter("/auth");
    const auth = await authSubscribes(); // first listener: gets the retained event
    expect(auth.got).toEqual([]); // and is not handed the staff link
    authLands(router); // auth resolved before the root's imports finished
    expect(router.pathname).toBe("/profile");
    // The root subscribes late and has nothing left to push twice.
    await rootSubscribes(router);
    expect(router.pushes).toEqual(["/profile"]);
  });

  it("the link reaches the root before auth resolves: held, then taken by the landing", async () => {
    capacitorDelivers("https://app.houndstack.com/my-schedule");
    const router = fakeRouter("/auth");
    await authSubscribes();
    await rootSubscribes(router);
    expect(router.pushes).toEqual([]); // held on /auth, not pushed into the redirect
    expect(pending.peekDeepLink()).toBe("/my-schedule");
    authLands(router);
    expect(router.pushes).toEqual(["/my-schedule"]);
  });

  it("the link arrives after auth landed on My Day with its close-out prompt still loading", async () => {
    const router = fakeRouter("/auth");
    await authSubscribes();
    await rootSubscribes(router);
    // No link yet: /auth lands on the role page, and My Day is still resolving.
    expect(pending.takeLinkForLanding()).toBeNull();
    const finish = router.navigateSlowly("/my-day");
    capacitorDelivers(STAFF);
    expect(router.pushes).toEqual([]); // waits for the router, not into its middle
    finish();
    await vi.waitFor(() => expect(router.pushes).toEqual(["/profile"]));
  });

  it("an invitation link is not lost to the first listener either", async () => {
    capacitorDelivers("https://app.houndstack.com/invite/tok");
    const router = fakeRouter("/auth");
    await authSubscribes();
    await rootSubscribes(router);
    // Needs no session: pushed once the router is idle, signed in or not.
    expect(router.pushes).toEqual(["/invite/tok"]);
  });
});

describe("a cold start, signed out", () => {
  it("the link waits through the sign-in form and opens after sign-in", async () => {
    capacitorDelivers(STAFF);
    const router = fakeRouter("/auth");
    await authSubscribes();
    await rootSubscribes(router);
    expect(router.pushes).toEqual([]); // the form is up; nothing navigates
    authLands(router); // handleSignIn -> land()
    expect(router.pushes).toEqual(["/profile"]);
  });
});

describe("no link", () => {
  it("lands on the remembered role page, as before", async () => {
    const router = fakeRouter("/auth");
    await authSubscribes();
    await rootSubscribes(router);
    authLands(router, "/my-day");
    expect(router.pushes).toEqual(["/my-day"]);
  });
});

describe("the OAuth hand-back still reaches /auth", () => {
  it("warm: each kind goes to its own subscriber", async () => {
    const router = fakeRouter("/auth");
    const auth = await authSubscribes();
    await rootSubscribes(router);
    capacitorDelivers(OAUTH);
    expect(auth.got).toEqual([OAUTH]);
    expect(router.pushes).toEqual([]);
    expect(pending.peekDeepLink()).toBeNull();
  });

  it("cold: a hand-back that started the app is kept for /auth, even if the root listens first", async () => {
    capacitorDelivers(OAUTH);
    await rootSubscribes(fakeRouter("/auth"));
    const auth = await authSubscribes();
    expect(auth.got).toEqual([OAUTH]);
  });

  it("unsubscribing stops delivery", async () => {
    const auth = await authSubscribes();
    auth.off();
    capacitorDelivers(OAUTH);
    expect(auth.got).toEqual([]);
  });
});

describe("the wiring", () => {
  const root = join(import.meta.dirname, "..");
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
    });
  }

  it("exactly one place in src/ listens to Capacitor's appUrlOpen", () => {
    const hits = files(join(root, "src")).filter((f) =>
      /addListener\(\s*["']appUrlOpen["']/.test(readFileSync(f, "utf8")),
    );
    expect(hits.map((f) => repoRelative(f, root))).toEqual(["src/lib/app-url-open.ts"]);
  });

  it("the close-out prompt does not navigate", () => {
    const src = readFileSync(join(root, "src/components/CloseOutOpenVisits.tsx"), "utf8");
    expect(src).not.toMatch(/useNavigate|navigate\(|router\.history|redirect\(/);
  });
});
