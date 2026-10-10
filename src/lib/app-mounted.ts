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

/** Test seam: back to "nothing has committed". */
export function resetAppMountedForTests(): void {
  mounted = false;
  gate = new Promise<void>((resolve) => {
    open = resolve;
  });
}
