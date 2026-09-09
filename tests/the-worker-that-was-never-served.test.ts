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
