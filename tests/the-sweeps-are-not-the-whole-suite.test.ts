/**
 * Four browser measurements were written, merged, and then run by nothing.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `.github/workflows/sandboxes.yml` runs two viewport steps, and both select
 * their tests by filename pattern:
 *
 *     npm run test:viewports:public   ->  playwright test every-public-page
 *     npm run test:viewports:auth     ->  playwright test every-signed-in-page
 *
 * Those are the two sweeps, and they are the two files anybody thinks of. But
 * tests/viewports also held `a-page-called-invoices-opened-on-no-invoices`,
 * `the-billing-gate-in-every-state-it-ships`, `the-store-gate-only-exists-at-
 * runtime` and `preferences-was-a-dumping-ground` — each written to pin a
 * specific fix, each passing when it was written, and none of them matched by
 * either pattern. They ran on the day they landed and never again.
 *
 * That is worse than not having them: the fix they were meant to protect can
 * be reverted and the PR is green, while the file sitting in the repo reads
 * like the fix is protected.
 *
 * ── WHY A LIST WOULD NOT HAVE BEEN ENOUGH ─────────────────────────────────
 *
 * The obvious fix is a third step naming the four files, and that is half of
 * what landed. It does not survive the fifth file. So this asserts the
 * property rather than the list: every spec under tests/viewports is named by
 * some step in the workflow, or is on EXEMPT below with a reason written down.
 * Adding a spec and forgetting to wire it fails here, by name, immediately.
 *
 * Resolution is done the way Playwright does it — a positional argument is a
 * regular expression matched against the file path — so the check cannot
 * drift from what the command actually selects.
 *
 * ── AND IT CAUGHT ITS FIRST ONE BY BEING RED ON main ──────────────────────
 *
 * Worth knowing before trusting a green run of this file on a branch: the
 * corpus it scans is the WORKING TREE, and a branch's working tree is not
 * what main will look like after the merge.
 *
 * `eleven-tabs-five-visible.spec.ts` merged in one PR while this rule was
 * being written in another, branched from before it. So the rule scanned a
 * tree that did not contain the file, passed, merged — and main was red the
 * moment the two met, for a spec that had genuinely been left running
 * nowhere. The rule was right and the merge order hid it for one commit.
 *
 * There is no assertion that can fix that from inside the file, because the
 * fault is in what it was pointed at rather than in what it does. The
 * mitigation is knowing it: any rule here that scans `src/` or
 * `tests/viewports/` can go red on merge without either branch being wrong.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitAssignments } from "../scripts/playwright-with-env.mjs";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * Specs that deliberately do not gate a merge. Each needs a reason, because
 * an exempt list with no reasons is how the hole gets reopened.
 */
const EXEMPT: Record<string, string> = {
  "app-store-screenshots.spec.ts":
    "produces the App Store Connect images on demand under APPLE_SIZES=1; " +
    "it is a deliverable generator, not an assertion about the app",
  "play-store-screenshots.spec.ts":
    "produces the Google Play listing images on demand (npm run screenshots:play); " +
    "the Android counterpart of the App Store generator above, and like it not an " +
    "assertion about the app",
};

const specNames = () =>
  readdirSync(join(root, "tests/viewports"))
    .filter((f) => f.endsWith(".spec.ts"))
    .sort();

/** The `npm run test:viewports:*` commands the workflow actually invokes. */
function stepsInCi(): string[] {
  const yml = read(".github/workflows/sandboxes.yml");
  return [...yml.matchAll(/npm run (test:viewports[:\w-]*)/g)].map((m) => m[1]);
}

/** Positional args to `playwright test`, per script the workflow runs. */
function filtersFromCi(): { script: string; filters: string[] }[] {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  return stepsInCi().map((script) => {
    const cmd = pkg.scripts[script];
    if (!cmd) throw new Error(`sandboxes.yml runs "${script}", which package.json does not define`);
    const args = cmd.trim().split(/\s+/);
    const i = args.indexOf("test");
    // Everything after `playwright test` that is not a flag is a path regex.
    return { script, filters: args.slice(i + 1).filter((a) => !a.startsWith("-")) };
  });
}

describe("every viewport spec is run by something", () => {
  it("finds the specs and the steps at all, so a green run means checked", () => {
    // If either side reads as empty the rule below passes vacuously. These
    // are the tripwire: a rename of the directory, a workflow rewrite, a
    // scripts block that stops using `npm run`.
    expect(specNames().length).toBeGreaterThanOrEqual(6);
    expect(stepsInCi().length).toBeGreaterThanOrEqual(3);
  });

  it("names each one in a workflow step, or exempts it with a reason", () => {
    const filters = filtersFromCi();
    const orphans = specNames()
      .filter((f) => !(f in EXEMPT))
      .filter((f) => {
        const path = `tests/viewports/${f}`;
        return !filters.some((s) => s.filters.some((r) => new RegExp(r).test(path)));
      })
      .map(
        (f) =>
          `tests/viewports/${f} — merged, and no step in sandboxes.yml selects it. ` +
          `Add it to a test:viewports:* script, or to EXEMPT with a reason.`,
      );
    expect(orphans).toEqual([]);
  });

  it("does not let a step select nothing", () => {
    // A filter that matches no file is the same hole seen from the other
    // side: the step is green because it ran nothing. Playwright exits
    // non-zero on a total miss, but not when one of several filters misses.
    const names = specNames().map((f) => `tests/viewports/${f}`);
    const dead = filtersFromCi().flatMap(({ script, filters }) =>
      filters
        .filter((r) => !names.some((p) => new RegExp(r).test(p)))
        .map((r) => `${script}: the filter "${r}" matches no spec — renamed or deleted?`),
    );
    expect(dead).toEqual([]);
  });

  it("keeps a reason attached to every exemption", () => {
    for (const [file, why] of Object.entries(EXEMPT)) {
      expect(specNames(), `${file} is exempted but no longer exists`).toContain(file);
      expect(why.length, `${file} is exempted with no reason`).toBeGreaterThan(30);
    }
  });

  // ── AND COVERAGE OF FILES IS NOT COVERAGE OF CONFIGURATIONS ─────────────
  //
  // The rules above ask whether every SPEC is named by a step. Every one of
  // them was green throughout the three weeks that
  // `every-public-page-at-every-width` and `every-signed-in-page-at-every-
  // width` ran in CI at four widths and NEVER under APPLE_SIZES=1 — the mode
  // that swaps in eleven real device sizes and, more to the point, sets
  // `hasTouch`. Both specs were named by a step. Both ran. Neither ran in the
  // configuration that finds iPad faults, and nothing here could tell.
  //
  // That is not hypothetical either. #207 spelled a touch floor `max-md:` and
  // put two 16.0px buttons on every iPad size for two days; the four-width
  // sweep agreed the page was fine, because it only asks for 44px at or below
  // 768. What caught it was a person running the Apple pass by hand.
  //
  // So: a spec that BRANCHES on an environment variable has more than one
  // behaviour, and a step that never sets the variable exercises exactly one
  // of them.
  it("runs every spec that branches on APPLE_SIZES in the mode it branches into", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const appleScripts = stepsInCi().filter((s) => /APPLE_SIZES=1/.test(pkg.scripts[s] ?? ""));

    // Tripwire, same reasoning as above: if no step sets it, the filter below
    // has nothing to match and the rule would pass by measuring nothing.
    expect(
      appleScripts.length,
      "no step in sandboxes.yml sets APPLE_SIZES=1, so the eleven-size/touch mode runs nowhere",
    ).toBeGreaterThanOrEqual(1);

    const covered = appleScripts.flatMap((script) => {
      const args = (pkg.scripts[script] ?? "").trim().split(/\s+/);
      return args.slice(args.indexOf("test") + 1).filter((a) => !a.startsWith("-"));
    });

    const unswept = specNames()
      .filter((f) => !(f in EXEMPT))
      .filter((f) => /APPLE_SIZES/.test(read(`tests/viewports/${f}`)))
      .filter((f) => !covered.some((r) => new RegExp(r).test(`tests/viewports/${f}`)))
      .map(
        (f) =>
          `tests/viewports/${f} reads APPLE_SIZES, and no step that SETS it selects the file. ` +
          `It runs in CI, but only ever in its default mode — which is how eleven iPhone and ` +
          `iPad sizes with pointer:coarse went unmeasured for three weeks while every rule ` +
          `in this file stayed green.`,
      );

    expect(unswept).toEqual([]);
  });

  // ── AND A STEP THAT CANNOT START ON THE RUNNER IT IS SENT TO ────────────
  //
  // On 2026-10-08 the viewport job moved to the Windows runner, which runs
  // npm scripts through cmd.exe and steps through PowerShell. Neither reads
  // `APPLE_SIZES=1 playwright test` as an assignment: it is a command called
  // `APPLE_SIZES=1`, and the step dies before Playwright starts -- the same
  // way `NATIVE_BUILD=1 vite build` died in ci.yml on 2026-10-02.
  //
  // The rule above still finds the mode by reading `APPLE_SIZES=1` in the
  // script, so the assignment stays visible; it is just an ARGUMENT to
  // scripts/playwright-with-env.mjs now rather than a shell prefix. These two
  // keep it that way: no CI script starts with an assignment, and the
  // wrapper really does turn the assignment into the environment.
  it("starts every script a step runs the same way under cmd, PowerShell and sh", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const shellOnly = stepsInCi()
      .filter((script) => /(^|&&|;)\s*[A-Za-z_][A-Za-z0-9_]*=/.test(pkg.scripts[script] ?? ""))
      .map(
        (script) =>
          `${script}: "${pkg.scripts[script]}" sets a variable with sh syntax, which cmd.exe and ` +
          `PowerShell run as a command named after it. Use ` +
          `\`node scripts/playwright-with-env.mjs NAME=value test ...\` instead.`,
      );
    expect(shellOnly).toEqual([]);
  });

  it("turns the leading NAME=value arguments into the environment, and passes the rest on", () => {
    expect(
      splitAssignments(["APPLE_SIZES=1", "test", "every-public-page", "every-signed-in-page"]),
    ).toEqual({
      env: { APPLE_SIZES: "1" },
      args: ["test", "every-public-page", "every-signed-in-page"],
    });
    // Only LEADING assignments: once Playwright's own arguments start, an
    // `=` inside one (a --grep, a --reporter) is Playwright's business.
    expect(splitAssignments(["A=1", "B=", "test", "--grep=a=b", "C=2"])).toEqual({
      env: { A: "1", B: "" },
      args: ["test", "--grep=a=b", "C=2"],
    });
  });
});
