import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

// A client-only route (`ssr: false`) sets `pendingMinMs: 0`.
//
// On hydration TanStack Router gives the first `ssr: false` match a timer of
// its `pendingMinMs` (router-core ssr-client.js, setMatchForcePending). When
// that timer fires it calls router.updateMatch -> router.startTransition, and
// startTransition is assigned DURING the render of <Transitioner>, closing
// over that render's setState. If React has not committed the first render by
// then (the route chunks for a signed-in page are still arriving, which on a
// loaded machine takes longer than the 400ms default), the setState lands on a
// fiber that never mounted and React logs "Can't perform a React state update
// on a component that hasn't mounted yet".
//
// That warning failed the QA list's "renders and throws nothing" check on
// /invoices and /tax-reports, intermittently, on every PR. It was caught on
// 2026-10-09 with a console.error wrapper that captured the stack: dispatchSetState
// <- Transitioner.router.startTransition <- RouterCore.updateMatch <- ssr_client.
// With no minimum, hydration starts no timer. Client-side navigations keep
// defaultPendingMinMs, because the route's own match is the shell, not the page.

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

/** The options object of `createFileRoute(...)({ ... })`, up to its first
 *  top-level property that is a function (enough to see ssr and pendingMinMs,
 *  which sit at the top of every route that sets them). */
function clientOnly(source: string) {
  const ssrFalse = /createFileRoute\([^)]*\)\(\{[\s\S]*?\n\s{2}ssr:\s*false\b/.test(source);
  const noMinimum = /\n\s{2}pendingMinMs:\s*0\s*,/.test(source);
  return { ssrFalse, noMinimum };
}

describe("a client-only route starts no hydration timer", () => {
  const files = routeFiles(ROUTES);
  const clientOnlyRoutes = files.filter((f) => clientOnly(readFileSync(f, "utf8")).ssrFalse);

  it("finds the client-only routes, so the rule below is not vacuous", () => {
    const names = clientOnlyRoutes.map((f) => repoRelative(f, ROOT));
    expect(names).toContain("src/routes/_authenticated/route.tsx");
    expect(names.length).toBeGreaterThanOrEqual(5);
  });

  it("every `ssr: false` route sets `pendingMinMs: 0`", () => {
    const missing = clientOnlyRoutes
      .filter((f) => !clientOnly(readFileSync(f, "utf8")).noMinimum)
      .map((f) => repoRelative(f, ROOT));
    expect(
      missing,
      "These routes are `ssr: false` without `pendingMinMs: 0`. On hydration the router\n" +
        "starts a timer of the route's minimum pending time and, if React has not committed\n" +
        "its first render when it fires, React logs a state update on an unmounted component.\n" +
        "See the comment at the end of src/routes/_authenticated/route.tsx.",
    ).toEqual([]);
  });
});
