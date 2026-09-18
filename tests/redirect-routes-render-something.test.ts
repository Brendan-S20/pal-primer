import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// QA-P2. `/settings/payments` blank-rendered on roughly one cold load in four:
// the URL rewrote to /payments, the main area held zero characters, and the
// console carried an unhandled `undefined` beside React's "An error occurred
// in the <MatchInnerImpl> component".
//
// That route is a pure alias — `beforeLoad` throws a redirect and there is
// nothing else to it — so it was written with NO component. Five of them were.
// A route with no component gets the router's default, which renders an
// `<Outlet />`; on a LEAF route that Outlet has nothing beneath it, so the
// page is empty by construction the moment anything renders the match instead
// of redirecting.
//
// ── WHAT THIS FILE IS FOR ─────────────────────────────────────────────────
//
// Not for proving the race. That was intermittent, seen on a dev server, and
// is a timing interaction this environment has no browser to reproduce —
// guessing at it and shipping a change that "should" help is how a plausible
// edit gets mistaken for a fix.
//
// It is for the invariant underneath it, which IS checkable and was violated
// in five places: a route that can render must have something to render. The
// next alias someone adds will be written the same way the last five were.
//
// The stakes are why it is worth a test rather than a comment: this particular
// stub exists to catch Stripe Connect onboarding return URLs, so the one in
// four lands on someone coming back from Stripe mid-onboarding — at the moment
// they are deciding whether to trust us with their payouts — as a white screen
// with no message and no way forward.

const ROUTES = fileURLToPath(new URL("../src/routes", import.meta.url));

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...routeFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const files = routeFiles(ROUTES);

describe("every route that redirects can still render", () => {
  it("finds the route files at all", () => {
    // A glob that matches nothing makes every assertion below vacuous — the
    // exact failure tests/the-wiring-is-connected.test.ts exists to catch
    // elsewhere in this suite.
    expect(files.length).toBeGreaterThan(20);
  });

  const redirecting = files.filter((f) => readFileSync(f, "utf8").includes("throw redirect("));

  it("finds the redirecting ones", () => {
    expect(redirecting.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of redirecting) {
    const short = file.slice(file.indexOf("src/routes"));
    it(`${short} declares a component`, () => {
      expect(
        readFileSync(file, "utf8"),
        `${short} throws a redirect but renders nothing if it is ever reached — that is a blank page with an unhandled error, which is what QA-P2 found on /settings/payments`,
      ).toMatch(/component:/);
    });
  }
});

describe("the fallback recovers rather than just filling space", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/components/RedirectFallback.tsx", import.meta.url)),
    "utf8",
  );

  it("retries the navigation from the client", () => {
    // `component: () => null` would silence the router error and still leave a
    // blank page. The point is to turn a dead end into a self-healing one: a
    // redirect that did not happen during load still happens.
    expect(src).toMatch(/useNavigate/);
    expect(src).toMatch(/navigate\(\{/);
  });

  it("replaces rather than pushes, so the alias is not a back-button trap", () => {
    expect(src).toMatch(/replace: true/);
  });

  it("says where it is going, and offers a way through if it stalls", () => {
    // Someone returning from Stripe onboarding needs a sentence and a link,
    // not an empty page — even a correct redirect is a bad experience if it
    // renders as nothing while it happens.
    expect(src).toMatch(/Taking you to/);
    expect(src).toMatch(/<a href=\{to\}/);
  });
});
