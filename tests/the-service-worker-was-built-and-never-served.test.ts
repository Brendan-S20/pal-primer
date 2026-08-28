// The build emits a service worker. The site does not serve it.
//
// Found by driving the deployed app as three real accounts and reading the
// console: every page, every role, the same line —
//
//     A bad HTTP response code (404) was received when fetching the script.
//
// That is the browser's wording for a failed serviceWorker.register(), and
// src/pwa/register.ts registers "/sw.js" on every production page load.
//
//     /manifest.webmanifest   200
//     /favicon.ico            200
//     /push-handlers.js       200
//     /sw.js                  404
//
// So it is the worker specifically, not the static output as a whole.
//
// ── WHY check:pwa DID NOT CATCH IT ───────────────────────────────────────
//
// check-pwa-output.mjs reads `.output/public` and asserts the worker exists
// with a populated precache. It has been green throughout, and correctly so:
// the BUILD has been right the whole time. The deployment is what is missing
// the file, and a check that reads a directory cannot see a deployment.
//
// The same shape as the OAuth gate twice over: proving the artifact rather
// than the running thing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const live = read("scripts/check-pwa-live.mjs");
const built = read("scripts/check-pwa-output.mjs");
const pkg = JSON.parse(read("package.json"));

describe("a check that asks the site, not the build directory", () => {
  it("exists and is wired to a script", () => {
    expect(pkg.scripts["check:pwa:live"]).toBe("node scripts/check-pwa-live.mjs");
  });

  it("fetches the origin rather than reading a path", () => {
    expect(live).toMatch(/fetch\(ORIGIN/);
    expect(live).not.toMatch(/readFileSync/);
  });

  it("and the build check still reads the directory, which is its job", () => {
    // These two are complementary, not redundant. Collapsing either into the
    // other loses the half it was covering.
    expect(built).toMatch(/\.output\/public/);
    expect(built).toMatch(/existsSync/);
  });

  it("separates 'the worker is missing' from 'nothing is served'", () => {
    // A deploy that serves nothing is a different problem with a different
    // fix, and saying so saves whoever reads the failure a wrong first guess.
    expect(live).toMatch(/COMPANIONS/);
    expect(live).toMatch(/companionsOk/);
  });

  it("never fails on an unreachable origin", () => {
    // It is meant to be able to gate a release, so a flaky network must not.
    expect(live).toMatch(/could not reach the origin/);
    expect(live).toMatch(/process\.exit\(0\)/);
  });

  it("names the registration that produces the 404", () => {
    // Whoever hits this needs to know the app asks for it on every page load,
    // not just that a file is absent.
    const reg = read("src/pwa/register.ts");
    expect(reg).toMatch(/APP_SW_PATH = "\/sw\.js"/);
    expect(live).toMatch(/register/);
  });
});
