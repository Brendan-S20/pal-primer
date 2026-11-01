// A client-only route's beforeLoad answers only after React has committed.
//
// ── WHAT FAILED ──────────────────────────────────────────────────────────
//
// The QA-list E2E spec ("renders and throws nothing") failed intermittently
// from 2026-10-10 on /routes, /my-schedule and /neighbors with React's
//
//   Can't perform a React state update on a component that hasn't mounted
//   yet. This indicates that you have a side-effect in your render function
//   that asynchronously tries to update the component.
//
// Reproduced by running those three routes against a local Supabase at 6x
// CPU throttling (3 of 6 loads), with a console.error wrapper that captured
// the stack:
//
//   dispatchSetState <- Transitioner.router.startTransition
//   <- RouterCore.updateMatch <- updateContext <- loadMatches <- router.load
//
// On a hard load of an `ssr: false` route, TanStack Start's hydration starts
// router.load() before React renders anything, so the `_authenticated`
// beforeLoad (identity, second step, my-org, account lock) runs BESIDE
// React's first render. <Transitioner> assigns router.startTransition during
// its render, closing over its own setState; an answer that lands after that
// render and before the commit is a setState on a fiber that never mounted.
// It moved from page to page because it is not about any page. It is the
// same race tests/a-timer-that-beat-the-first-render.test.ts closed for the
// hydration TIMER; this is the beforeLoad itself reaching the same setState.
//
// ── WHAT THIS PINS ───────────────────────────────────────────────────────
//
// The fix is lib/app-mounted.ts: the root component marks the first commit in
// a layout effect, and every client-only route's beforeLoad settles -- a
// context or a redirect -- only after that mark. The work itself still starts
// at once, so the network round trips overlap the render as before.
//
// The first block runs the REAL `_authenticated` beforeLoad with its
// dependencies faked to answer instantly (the case that loses the race) and
// asserts it does not settle before the mark. Before the fix it settled at
// once, so both of those tests fail on the code that shipped.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const getMyOrg = vi.fn();
vi.mock("@/lib/org.functions", () => ({ getMyOrg: () => getMyOrg() }));
vi.mock("@/lib/platform.functions", () => ({
  getPlatformContext: async () => ({ isPlatformAdmin: false }),
}));
vi.mock("@/lib/account-lock.functions", () => ({
  getAccountLock: async () => ({ locked: false }),
}));
vi.mock("@/lib/offline/identity", () => ({
  resolveIdentity: async () => ({ ok: true, userId: "u-1", user: { id: "u-1" }, verified: true }),
}));
vi.mock("@/lib/mfa", () => ({ needsSecondStep: async () => false }));
vi.mock("@/lib/offline/read-cache", () => ({
  ensureReadCachePersistence: () => {},
  clearPersistedReadCaches: () => {},
  signOutAndClearDevice: async () => {},
}));
vi.mock("@/lib/monitoring/client", () => ({
  setMonitoringIdentity: () => {},
  reportClientError: () => {},
}));

import { isRedirect } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { Route } from "@/routes/_authenticated/route";
import { markAppMounted, resetAppMountedForTests, settleAfterFirstCommit } from "@/lib/app-mounted";

/** Let every queued microtask and timer run, so "has not settled" means it
 *  is waiting on something, not that it has not had its turn yet. */
async function drain() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function track<T>(p: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  p.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

const g = globalThis as { window?: unknown };
let hadWindow = false;

beforeEach(() => {
  // A browser, as far as the gate is concerned: outside one there is no
  // <Transitioner> to race and the gate stands open.
  hadWindow = "window" in g;
  if (!hadWindow) g.window = globalThis;
  resetAppMountedForTests();
  getMyOrg.mockReset();
});

afterEach(() => {
  if (!hadWindow) delete g.window;
  resetAppMountedForTests();
});

function runShellBeforeLoad(pathname = "/routes") {
  const beforeLoad = Route.options.beforeLoad as (ctx: unknown) => Promise<unknown>;
  return beforeLoad({
    context: { queryClient: new QueryClient() },
    location: { href: pathname, pathname },
  });
}

describe("the _authenticated shell does not answer before the first commit", () => {
  it("holds its context until the app has mounted, then hands it over", async () => {
    getMyOrg.mockResolvedValue({
      organization: { id: "org-1", name: "Acme Scoop", role: "owner" },
      accessTurnedOff: null,
    });
    const s = track(runShellBeforeLoad());
    await drain();
    expect(
      s.settled,
      "beforeLoad settled before React committed. On a hard load that answer reaches " +
        "<Transitioner>'s setState before it has mounted. See src/lib/app-mounted.ts.",
    ).toBe(false);
    expect(getMyOrg, "the work itself must not wait: it overlaps the render").toHaveBeenCalled();

    markAppMounted();
    await drain();
    expect(s.settled).toBe(true);
    expect(s.error).toBeUndefined();
    expect(s.value).toMatchObject({ userId: "u-1", organization: { id: "org-1" } });
  });

  it("holds a redirect the same way: it reaches the same setState", async () => {
    getMyOrg.mockResolvedValue({ organization: null, accessTurnedOff: null });
    const s = track(runShellBeforeLoad());
    await drain();
    expect(s.settled).toBe(false);

    markAppMounted();
    await drain();
    expect(s.settled).toBe(true);
    expect(isRedirect(s.error)).toBe(true);
  });

  it("costs nothing once the app is up: a navigation is not held", async () => {
    getMyOrg.mockResolvedValue({
      organization: { id: "org-1", name: "Acme Scoop", role: "owner" },
      accessTurnedOff: null,
    });
    markAppMounted();
    const s = track(runShellBeforeLoad());
    await drain();
    expect(s.settled).toBe(true);
  });
});

describe("settleAfterFirstCommit", () => {
  it("starts the work at once and settles after the mark", async () => {
    let started = false;
    const s = track(
      settleAfterFirstCommit(async () => {
        started = true;
        return 42;
      }),
    );
    expect(started).toBe(true);
    await drain();
    expect(s.settled).toBe(false);
    markAppMounted();
    await drain();
    expect(s.value).toBe(42);
  });

  it("does not wait outside a browser, where nothing can race", async () => {
    if (!hadWindow) delete g.window;
    const s = track(settleAfterFirstCommit(async () => "server"));
    await drain();
    expect(s.value).toBe("server");
  });
});

// ── THE RULE, FOR THE NEXT CLIENT-ONLY ROUTE ──────────────────────────────

const ROOT = join(import.meta.dirname, "..");
const ROUTES = join(ROOT, "src", "routes");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? routeFiles(join(dir, e.name))
      : /\.tsx?$/.test(e.name)
        ? [join(dir, e.name)]
        : [],
  );
}

describe("every client-only route that does async work answers after the first commit", () => {
  const files = routeFiles(ROUTES).filter((f) =>
    /createFileRoute\([^)]*\)\(\{[\s\S]*?\n\s{2}ssr:\s*false\b/.test(readFileSync(f, "utf8")),
  );
  const withWork = files.filter((f) => /\n\s{2}(beforeLoad|loader):/.test(readFileSync(f, "utf8")));

  it("finds them, so the rule below is not vacuous", () => {
    const names = withWork.map((f) => repoRelative(f, ROOT));
    expect(names).toContain("src/routes/_authenticated/route.tsx");
    expect(names).toContain("src/routes/admin.tsx");
  });

  it("wraps each beforeLoad/loader in settleAfterFirstCommit", () => {
    const bare = withWork
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        const hooks = src.match(/\n\s{2}(beforeLoad|loader):[^\n]*\n[^\n]*/g) ?? [];
        return hooks.some((h) => !/settleAfterFirstCommit\(/.test(h));
      })
      .map((f) => repoRelative(f, ROOT));
    expect(
      bare,
      "These `ssr: false` routes have a beforeLoad or loader that can settle before React\n" +
        "has committed its first render, which React reports as a state update on a component\n" +
        "that hasn't mounted yet. Wrap it: `beforeLoad: (opts) => settleAfterFirstCommit(async\n" +
        "() => { ... })`. See src/lib/app-mounted.ts.",
    ).toEqual([]);
  });

  it("the root component marks the first commit, in an effect and not during render", () => {
    const root = readFileSync(join(ROUTES, "__root.tsx"), "utf8");
    expect(root).toMatch(/useLayoutEffect\(\(\) => \{\s*markAppMounted\(\);\s*\}, \[\]\)/);
  });
});
