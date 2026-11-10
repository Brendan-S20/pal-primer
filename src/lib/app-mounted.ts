// Has React committed the app's first render yet?
//
// ── THE RACE ─────────────────────────────────────────────────────────────
//
// On a hard load of a client-only (`ssr: false`) route, TanStack Start's
// hydration (router-core ssr-client.js) starts `router.load()` BEFORE React
// renders anything, so the route's beforeLoad -- for `_authenticated`: the
// identity check, the second step, `my-org`, the account lock -- runs side by
// side with React's first render. When it settles, the router writes the
// result through `router.updateMatch`, which calls `router.startTransition`.
// <Transitioner> assigns that function DURING its render, closing over its own
// setState. So if the beforeLoad settles after Transitioner has rendered but
// before React has committed (hydration is a concurrent render: it yields, and
// on a busy machine it is long), the setState lands on a fiber that never
// mounted, and React logs
//
//   Can't perform a React state update on a component that hasn't mounted
//   yet. This indicates that you have a side-effect in your render function...
//
// The stack, captured on 2026-10-10 from the QA-list E2E spec at 6x CPU:
//
//   dispatchSetState <- Transitioner.router.startTransition
//   <- RouterCore.updateMatch <- updateContext <- loadMatches <- load
//
// That is the second half of the race tests/a-timer-that-beat-the-first-
// render.test.ts closed on 2026-10-08 (that was the hydration TIMER reaching
// the same setState; this is the beforeLoad itself). It moved between
// /routes, /my-schedule and /neighbors because it is not about any page: it
// is about whether the shell's network answers beat React's first commit.
//
// ── THE FIX ──────────────────────────────────────────────────────────────
//
// The root component marks the commit in a layout effect (effects run only
// after a commit, and <Transitioner> commits in the same commit or an earlier
// one -- it sits above every route's own Suspense boundary). A client-only
// route's beforeLoad does its work at once, in parallel with the render as
// before, and only SETTLES -- resolves or throws its redirect -- once that
// mark is there. After the first commit the gate is already open, so a
// navigation pays one microtask for it and nothing else.

let mounted = false;
let open: () => void = () => {};
let gate = new Promise<void>((resolve) => {
  open = resolve;
});

/** Called once React has committed the app (the root component's layout
 *  effect). Idempotent: StrictMode runs the effect twice. */
export function markAppMounted(): void {
  mounted = true;
  open();
}

/** Resolves once the app has committed. Already resolved outside a browser
 *  (a server render, a unit test calling a beforeLoad directly), where there
 *  is no <Transitioner> to race. */
export function untilTheAppHasMounted(): Promise<void> {
  if (mounted || typeof window === "undefined") return Promise.resolve();
  return gate;
}

/**
 * Run a client-only route's beforeLoad now, but let it settle only after the
 * first commit, whichever way it settles. A thrown redirect goes through the
 * same `updateMatch` as a returned context, so it waits too.
 */
export async function settleAfterFirstCommit<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    await untilTheAppHasMounted();
  }
}

/** Has React committed the app's first render? */
export function isAppMounted(): boolean {
  return mounted;
}

// ── THE THIRD PATH, AND ONE FIX FOR ALL OF THEM ──────────────────────────
//
// Two paths into the same race were closed one at a time: the hydration
// pendingMinMs timer (a-timer-that-beat-the-first-render.test.ts, 2026-10-08)
// and the beforeLoad's own answer (settleAfterFirstCommit above, 2026-10-10).
// A third is still open, and the second fix widens it: while a route's
// beforeLoad is still pending after `pendingMs`, router-core's
// setupPendingTimeout fires triggerOnReady -> onReady -> router.startTransition
// to show the pending component. _authenticated's beforeLoad now waits for the
// first commit, so on a slow first render that timer fires first. The stack,
// captured on 2026-11-09 in the QA-list E2E spec (#733) and reproduced on main
// at 6 of 16 hard loads of /my-schedule and /review:
//
//   dispatchSetState <- Transitioner.router.startTransition <- onReady
//   <- triggerOnReady <- (setTimeout)
//
// Rather than chase each caller, guard the one function they all reach.
// <Transitioner> assigns router.startTransition during its render, closing
// over its own setState; a call to THAT function before the app's first
// commit is exactly the setState on a fiber that never mounted.
//
// Before the first commit, guardRouterStartTransition therefore runs the
// router's update itself, the way router-core's own default does before any
// <Transitioner> exists (`(fn) => fn()`), and leaves Transitioner's setState
// out of it. Nothing is held back or queued. That matters: an earlier version
// of this guard (c1ed7ce6) waited for the first commit instead, and waiting is
// a deadlock whenever the first commit cannot happen without the very update
// being held (a root route still pending in a build with no server render,
// the native app). Running the update now cannot wait on anything.
//
// What is skipped is only Transitioner's `isTransitioning` flag for a
// transition that started before it committed: router state itself is
// updated at once, and every store subscriber reads it when it mounts. After
// the first commit every call goes to Transitioner's function, unchanged.

// router-core 1.171+ types this as (fn, expectedMatches) => Promise<boolean>.
// Extra arguments are forwarded so Transitioner still sees the matches it
// now passes in. `any` here is deliberate: the previous 1-arg form and the
// new 2-arg form both have to be assignable to this wrapper type.
type StartTransition = (
  fn: () => void,
  ...args: any[]
) => void | Promise<boolean>;

/**
 * Install the guard on a router (client only; see above). Returns the router.
 * Idempotent per router.
 */
export function guardRouterStartTransition<R extends { startTransition: StartTransition }>(
  router: R,
): R {
  const marked = router as R & { __startTransitionGuarded?: boolean };
  if (marked.__startTransitionGuarded) return router;
  marked.__startTransitionGuarded = true;
  // The router's constructor default, used until <Transitioner> replaces it.
  const routerDefault: StartTransition = router.startTransition;
  let current: StartTransition = routerDefault;
  let fromRender = false;
  Object.defineProperty(router, "startTransition", {
    configurable: true,
    enumerable: true,
    get(): StartTransition {
      return (fn, ...args) => {
        // Assigned by a render that has not committed: do the router's work
        // now, without that render's setState.
        if (fromRender && !mounted) return routerDefault(fn, ...args);
        return current(fn, ...args);
      };
    },
    set(next: StartTransition) {
      current = next;
      fromRender = true;
    },
  });
  return router;
}

/** Test seam: back to "nothing has committed". */
export function resetAppMountedForTests(): void {
  mounted = false;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
}
