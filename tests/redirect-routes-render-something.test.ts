import { toPosix } from "./support/repo-paths";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Server-rendered redirects still need a visible fallback for client navigation.
// Client-only aliases use that component as their primary navigation path.
// The hydration race itself is covered by settings-survives-a-cold-load.spec.ts.

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
    // Same shape as one-app-origin: on Windows `indexOf("src/routes")` is -1
    // and `slice(-1)` returns the last CHARACTER of the path.
    const posix = toPosix(file);
    const short = posix.slice(posix.indexOf("src/routes"));
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
