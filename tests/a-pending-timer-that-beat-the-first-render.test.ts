// The pending timer that beat the first render (#733).
//
// The QA-list E2E spec failed /my-schedule and /review on "Can't perform a
// React state update on a component that hasn't mounted yet". The stack,
// captured with a console.error wrapper on a hard load:
//
//   dispatchSetState <- Transitioner.router.startTransition <- onReady
//   <- triggerOnReady <- (setTimeout: router-core setupPendingTimeout)
//
// Reproduced on main at 6 of 16 hard loads, and on this branch at 4 of 16.
// The guard runs such a call's update directly instead of through the render
// that has not committed. An earlier version WAITED for the first commit,
// which can never come if that commit needs the update (see app-mounted.ts). It is the third path into the race lib/app-mounted.ts
// describes, after the hydration pendingMinMs timer
// (a-timer-that-beat-the-first-render.test.ts) and the beforeLoad's own answer
// (a-shell-that-answered-before-the-first-render.test.ts).
// guardRouterStartTransition closes all of them at the one function they reach.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  guardRouterStartTransition,
  markAppMounted,
  resetAppMountedForTests,
} from "@/lib/app-mounted";

const ROOT = join(import.meta.dirname, "..");
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A router as router-core constructs it: startTransition runs its function now. */
function fakeRouter() {
  return { startTransition: (fn: () => void) => fn() } as {
    startTransition: (fn: () => void) => void;
  };
}

/** What <Transitioner> assigns during its render: a function closing over its
 *  own setState, which records when it is called. */
function transitionerAssigns(
  router: { startTransition: (fn: () => void) => void },
  log: string[],
  tag: string,
) {
  router.startTransition = (fn) => {
    log.push(`setState:${tag}`);
    fn();
  };
}

describe("router.startTransition before and after the first commit", () => {
  const g = globalThis as { window?: unknown };
  let hadWindow: boolean;
  beforeEach(() => {
    // Outside a browser the gate is open by design (no <Transitioner> to
    // race), so stand in a window for the browser case.
    hadWindow = "window" in g;
    if (!hadWindow) g.window = {};
    resetAppMountedForTests();
  });
  afterEach(() => {
    if (!hadWindow) delete g.window;
    resetAppMountedForTests();
  });

  it("runs the router's own default at once: hydration depends on it", () => {
    const router = guardRouterStartTransition(fakeRouter());
    const ran: string[] = [];
    router.startTransition(() => ran.push("hydrate"));
    expect(ran).toEqual(["hydrate"]);
  });

  it("before the first commit, does the router's work at once without Transitioner's setState", () => {
    const router = guardRouterStartTransition(fakeRouter());
    const log: string[] = [];
    transitionerAssigns(router, log, "render-1");
    // The pending timer fires before the commit, twice.
    router.startTransition(() => log.push("show-pending"));
    router.startTransition(() => log.push("settle"));
    // Applied immediately, in order, and no setState reached the render that
    // has not committed. Nothing waits, so nothing can wait forever.
    expect(log).toEqual(["show-pending", "settle"]);
  });

  it("never waits for a commit: the update runs even if the app never mounts", async () => {
    const router = guardRouterStartTransition(fakeRouter());
    const log: string[] = [];
    transitionerAssigns(router, log, "render-1");
    router.startTransition(() => log.push("leave-pending"));
    await flush();
    // markAppMounted() is never called here, as when the first commit draws a
    // pending root: the update the root was waiting for has still happened.
    expect(log).toEqual(["leave-pending"]);
  });

  it("goes straight through after the first commit", () => {
    const router = guardRouterStartTransition(fakeRouter());
    const log: string[] = [];
    transitionerAssigns(router, log, "committed");
    markAppMounted();
    router.startTransition(() => log.push("navigate"));
    expect(log).toEqual(["setState:committed", "navigate"]);
  });

  it("mutation: without the guard the call reaches Transitioner's setState before the commit", () => {
    const router = fakeRouter();
    const log: string[] = [];
    transitionerAssigns(router, log, "render-1");
    router.startTransition(() => log.push("show-pending"));
    expect(log).toEqual(["setState:render-1", "show-pending"]);
  });

  it("is installed once per router", () => {
    const router = fakeRouter();
    expect(guardRouterStartTransition(guardRouterStartTransition(router))).toBe(router);
  });

  it("is installed on the app's router, in the browser only", () => {
    const src = readFileSync(join(ROOT, "src/router.tsx"), "utf8");
    expect(src).toMatch(
      /if \(typeof window !== "undefined"\) \{[\s\S]*?guardRouterStartTransition\(router\);[\s\S]*?\}/,
    );
  });
});
