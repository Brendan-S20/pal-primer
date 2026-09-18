import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// BUG-47. `npm test` was a hand-typed list of 48 filenames while the repo had
// 52 test files. The four that were never added had never run in CI, and one
// of them — stripe-connect.server.test.ts — had been failing since BUILD-6
// changed the return shape it asserts on. CI was green the entire time,
// because a test file CI does not name is a test file CI cannot fail on.
//
// The fix was to let vitest discover its own files. This is the guard that
// keeps it that way, because the original mistake was not a typo — it was a
// list, and a list decays every time someone adds a test and forgets. The
// person who reintroduces one will be trying to skip a slow or flaky file, and
// will be doing something reasonable; this is what tells them where to do it
// instead.
//
// Deliberately checks the SHIPPED script rather than re-deriving the answer:
// a test that restates the rule agrees with itself no matter what CI runs.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

describe("the test runner discovers its own files", () => {
  it("does not name individual test files in the npm script", () => {
    // The whole defect in one assertion. If this fails, the fix is not to add
    // the missing file — it is to delete the list and use vitest.config.ts's
    // `exclude` for whatever needed skipping, where the exclusion is visible
    // next to the discovery rather than being an absence nobody can see.
    const script: string = pkg.scripts.test;
    expect(script, "package.json scripts.test").not.toMatch(/tests?[/\\][\w.-]+\.tsx?/);
  });

  it("runs vitest without a file argument", () => {
    expect(pkg.scripts.test.trim()).toBe("vitest run");
  });

  it("CI invokes that script rather than its own filtered command", () => {
    // A list can also come back in the workflow instead of package.json, which
    // would pass the two assertions above while changing nothing.
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toMatch(/run:\s*npm test\b/);
    expect(ci, "no vitest invocation in CI that bypasses npm test").not.toMatch(
      /run:.*vitest.*tests?[/\\]/,
    );
  });
});

describe("every test file on disk is reachable", () => {
  it("has no test file outside the directories vitest looks in", () => {
    // vitest's default include is **/*.{test,spec}.?(c|m)[jt]s?(x), rooted at
    // the project. This asserts the flat expectation the repo actually holds:
    // tests live under tests/. A stray src/foo.test.ts would still be picked
    // up by vitest, so this is about keeping them findable by a human.
    const stray: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (name.name === "node_modules" || name.name.startsWith(".")) continue;
        const childRel = rel ? `${rel}/${name.name}` : name.name;
        if (name.isDirectory()) walk(join(dir, name.name), childRel);
        else if (/\.(test|spec)\.tsx?$/.test(name.name)) stray.push(`src/${childRel}`);
      }
    };
    walk("src", "");
    expect(stray).toEqual([]);
  });
});
