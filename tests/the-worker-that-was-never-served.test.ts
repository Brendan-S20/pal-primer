import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// /sw.js answered 404 on app.houndstack.com for three weeks after the bug that
// caused it was fixed (#104, 2026-08-19), and nothing here noticed.
//
// The reason is the same shape as IMP-2 and as both OAuth gates before it:
// every check we had read the ARTEFACT rather than the RUNNING THING.
// `check:pwa` reads .output/public, proves the build emits a worker with a
// populated precache, and has been correctly green throughout. A check that
// reads a directory cannot see a deploy that drops the file.
//
// On 2026-09-08 the build was verified correct in every way a repository can
// be: sw.js and workbox-*.js on disk in .output/public AND listed in Nitro's
// embedded public-asset manifest. Production still served 404 for both, while
// manifest.webmanifest and push-handlers.js from the same directory served
// 200, and the 404 came back from the SSR worker with no x-deployment-id --
// so the asset layer had no such file. Whatever drops them is downstream of
// anything this repository controls.
//
// `check:pwa:live` was written to catch exactly this and was never wired into
// CI, which is why it caught nothing. This file is what keeps it wired.

const ROOT = process.cwd();
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const CI = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const SCRIPT = readFileSync(join(ROOT, "scripts/check-pwa-live.mjs"), "utf8");

describe("the live check exists and is actually run", () => {
  it("is a script", () => {
    expect(pkg.scripts["check:pwa:live"]).toBe("node scripts/check-pwa-live.mjs");
  });

  it("is invoked by a CI step, not merely available", () => {
    // The whole failure was a good check nobody ran.
    expect(CI).toMatch(/npm run check:pwa:live/);
  });

  it("runs off pull requests, where the state it reports can be acted on", () => {
    // Deliberately NOT a PR gate. A PR author cannot fix the deployed site --
    // their change has not deployed yet -- and a red X somebody is powerless
    // to clear is how a team learns to ignore a check.
    const job = CI.slice(CI.indexOf("  deployment:"));
    expect(job.length, "the deployment job is gone").toBeGreaterThan(0);
    expect(job).toMatch(/if: github\.event_name != 'pull_request'/);
    expect(job).toMatch(/npm run check:pwa:live/);
  });

  it("still runs the build-time check too, which answers a different question", () => {
    // Keeping both matters. The live check says the deploy is wrong; the build
    // check says whether the repo is. Losing the second would leave nothing
    // able to tell those apart.
    expect(pkg.scripts["check:pwa"]).toBe("node scripts/check-pwa-output.mjs");
    expect(pkg.scripts.build).toMatch(/check-pwa-output\.mjs/);
  });
});

describe("a 200 is not a service worker", () => {
  // The check asked for a status code and nothing else, so a host that
  // answered 200 with an HTML error page passed it completely. That is the
  // same shape as every other fault in this story: an assertion that cannot
  // fail on the real problem, reported as a green light.
  //
  // Verified by pointing the check at a server that answers 200 for /sw.js,
  // /manifest.webmanifest, /favicon.ico and every page, and serves
  // "<!doctype html>not a worker" as the worker. Before: passed. After:
  // "/sw.js answers 200, but it is only 40 bytes", exit 1.
  it("reads the body, not just the status", () => {
    expect(SCRIPT).toMatch(/swBody/);
    expect(SCRIPT).toMatch(/\.text\(\)/);
  });

  it("rejects something too small to be a built worker", () => {
    expect(SCRIPT).toMatch(/body\.length\s*<\s*\d{4}/);
  });

  it("requires a populated precache on the SERVED bytes", () => {
    // Counting `url:"` rather than `"url":`, because the output is minified.
    // That exact mistake was made by hand once and reported 324 entries as
    // zero, which is why the build check carries the same note.
    expect(SCRIPT).toMatch(/url:"/);
    expect(SCRIPT).toMatch(/precache manifest is EMPTY/);
  });

  it("requires both runtime caches and the push handlers", () => {
    expect(SCRIPT).toMatch(/app-shell/);
    expect(SCRIPT).toMatch(/static-assets/);
    // Web push is the reason this worker matters most: every notification
    // toggle in the product needs a registered worker with these in it.
    expect(SCRIPT).toMatch(/push-handlers\.js/);
  });

  it("catches a createHandlerBoundToURL that would throw at install", () => {
    // One bad call aborts every registerRoute after it, so the worker would be
    // served, registered, and dead. This build emits no HTML, so nothing
    // should be bound at all.
    expect(SCRIPT).toMatch(/createHandlerBoundToURL/);
  });

  it("reports what it measured rather than only a verdict", () => {
    // "200" and "200, 21475 bytes, 377 precached" are different amounts of
    // evidence, and only one of them survives being wrong.
    expect(SCRIPT).toMatch(/precacheCount/);
    expect(SCRIPT).toMatch(/bytes, \$\{?precacheCount\}? precached|precached/);
  });
});

describe("and it says which deployment it measured", () => {
  it("reads the deployment id from a file that is actually served", () => {
    // The host does not deploy on push to main, and this check runs as a job
    // attached to a commit. Without the id on screen, "the fix merged an hour
    // ago and is not deployed" and "the fix is deployed and does not work"
    // produce identical output. An hour went on exactly that confusion.
    expect(SCRIPT).toMatch(/x-deployment-id/);
    // NOT from /sw.js: the 404 comes back from the SSR worker with no such
    // header, so asking the failing path would always report "unknown".
    expect(SCRIPT).toMatch(/deploymentId\("\/favicon\.ico"\)/);
  });

  it("reports it rather than asserting on it", () => {
    // There is no way for this check to know which deployment SHOULD be live,
    // so turning a stale deploy into a failure would be inventing a verdict.
    // It goes in the output and in the failure text, not into `problems`.
    expect(SCRIPT).toMatch(/console\.log\(` {2}deployment/);
    expect(SCRIPT).toMatch(/does not deploy on push to main/);
    const problemPushes = SCRIPT.slice(SCRIPT.indexOf("const problems = []"));
    expect(problemPushes).not.toMatch(/problems\.push\([^)]*deployment \$\{/);
  });
});

describe("and it cannot fail the build for the wrong reason", () => {
  it("treats an unreachable origin as inconclusive, not as a failure", () => {
    // A DNS blip or a network hiccup must not turn a deploy check red: that
    // trains people to re-run rather than to look, which is how a real 404
    // would get waved through.
    expect(SCRIPT).toMatch(/could not reach the origin/);
    // Anchored on the message rather than on the condition. The condition grew
    // a second clause when the check started fetching a page as well as the
    // worker, and pinning its exact text made a correct change look like a
    // regression -- the guard was still there and still exited 0. What has to
    // hold is that the message and the early exit stay together.
    const guard = SCRIPT.slice(SCRIPT.indexOf("could not reach the origin"));
    expect(guard.slice(0, 200)).toMatch(/process\.exit\(0\)/);
    // And that it is a guard: something must still be able to fail below it.
    expect(guard).toMatch(/process\.exit\(1\)/);
  });

  it("checks siblings, so it can tell a missing worker from a dead deploy", () => {
    // If manifest.webmanifest is missing too, the problem is the deploy as a
    // whole and belongs in a different conversation. That distinction is what
    // made the 2026-09-08 diagnosis possible at all.
    expect(SCRIPT).toMatch(/COMPANIONS/);
    expect(SCRIPT).toMatch(/manifest\.webmanifest/);
  });
});
