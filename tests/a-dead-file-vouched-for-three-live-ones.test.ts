// The dead-machinery check certified three dead functions as wired, because
// the file importing them was itself dead.
//
// `WeatherStrip.tsx` — 220 lines, finished, a working bulk weather-reschedule
// flow — was rendered by nothing. It was the only importer of
// `analyzeDayWeather`, `rescheduleVisits` and `undoReschedule`, and rule 5
// asked one question: "does any other file mention this name?" One did. All
// three passed, and the whole branch was unreachable.
//
// The rule said so itself, in a comment: "That will miss a function whose only
// caller is itself dead, and that is the right trade: false positives here
// would train people to ignore the check." The predicted cost never
// materialised. Reachability is not a guess in a file-based-routing app — every
// screen is a file under src/routes, so the reachable set is whatever the
// import graph reaches from there. Measured on the first run: 23 of 487 files
// unreachable, 20 of them unused shadcn/ui primitives from the scaffold (now
// exempt as vendored), and the three that remained were all real:
//
//   WeatherStrip.tsx          finished, never rendered      -> mounted on /routes
//   LanguageToggle.tsx        Settings → Preferences had
//                             reimplemented the picker
//                             inline; a comment in my-day
//                             said it "moved" there, which
//                             was true of the feature and
//                             false of the component        -> deleted
//   lib/route-plausibility.ts findRouteWarnings, 7 tests,
//                             built for QA finding #10 and
//                             surfaced on no screen         -> baselined as a
//                                                              KNOWN GAP
//
// Mutation-tested, per the check's own standing rule that no rule ships without
// having been seen to fail:
//
//   unmount WeatherStrip        -> all three server fns flagged, naming the
//                                  unreachable importer as the cause
//   add an orphan under lib/    -> flagged
//   add the same under ui/      -> not flagged (vendored exemption holds)
//   reach a module only via a
//   dynamic import()            -> not flagged (the graph follows those)

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const script = readFileSync(join(root, "scripts/check-dead-machinery.mjs"), "utf8");
const baseline = JSON.parse(readFileSync(join(root, "scripts/dead-machinery-baseline.json"), "utf8"));

/** Comment lines stripped, so a `not.toMatch` cannot be satisfied or defeated
 *  by the prose that documents the fix. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("the check knows which files the app can actually run", () => {
  it("builds an import graph rather than grepping for names", () => {
    expect(script).toMatch(/function reachableAppFiles\(\)/);
    expect(script).toMatch(/function resolveImport\(/);
  });

  it("roots it at the route files, which are the entry points", () => {
    expect(script).toMatch(/f\.startsWith\(join\(SRC, "routes"\)\)/);
    expect(script).toMatch(/router\|server\|start\|routeTree\\\.gen/);
  });

  it("follows dynamic imports, not just static ones", () => {
    // This codebase lazy-imports server-only modules freely; a graph that only
    // saw `from "..."` would call half of them unreachable.
    expect(script).toMatch(/from\\s\*\|import\\s\*\\\(\\s\*/);
  });

  it("reads comment-stripped source when walking the graph", () => {
    // `// LanguageToggle moved to Settings → Preferences` is how that component
    // looked alive: a sentence about the feature, read as an import.
    expect(script).toMatch(/for \(const \[path, code\] of codeFiles\(\)\)/);
  });
});

describe("rule 5 no longer accepts a dead file as a witness", () => {
  it("separates 'mentioned nowhere' from 'mentioned only by dead files'", () => {
    expect(script).toMatch(/only mentioned by unreachable file\(s\)/);
    expect(script).toMatch(/no other file mentions — no UI can reach it/);
  });

  it("names the unreachable importer, since that is where the fix goes", () => {
    expect(script).toMatch(/const via = mentions\.map/);
  });

  it("still lets one reachable mention vouch", () => {
    // Deliberately not proving the mention is a call. The check's failure mode
    // is false positives, and it says so in its own header.
    expect(script).toMatch(/if \(!mentions\.some\(\(\[other\]\) => reachable\.has\(other\)\)\)/);
  });
});

describe("rule 6 reports the unreachable module itself", () => {
  it("exists, so the fix lands on the importer not its imports", () => {
    expect(script).toMatch(/function checkUnreachableModules\(baseline\)/);
    expect(script).toMatch(/it is compiled, never bundled, and runs nowhere/);
  });

  it("is registered in main() and in the baseline groups", () => {
    expect(script).toMatch(/\.\.\.checkUnreachableModules\(baseline\),/);
    expect(script).toMatch(/\["unreachable_modules", "module"\]/);
  });

  it("exempts vendored code, which would otherwise be twenty findings of noise", () => {
    // The shadcn scaffold ships a whole component library; most apps use a
    // third of it. Reporting the rest is the noise the header warns about.
    expect(script).toMatch(/UNREACHABLE_EXEMPT/);
    expect(script).toMatch(/\/src\\\/components\\\/ui\\\//);
    expect(script).toMatch(/\/src\\\/integrations\\\/lovable\\\//);
  });
});

describe("it did not get slow doing it", () => {
  it("strips each file once instead of once per server function", () => {
    // Dropping the short-circuiting `.some()` for a `.filter()` that needs
    // every mention turned ~200 functions × ~490 files into ~100k runs of the
    // character-by-character comment stripper. 92 seconds, measured, before
    // this cache; 2.3 after.
    expect(script).toMatch(/function codeFiles\(\)/);
    expect(script).toMatch(/codeFilesCache \?\?=/);
    const rule5 = script.slice(script.indexOf("function checkUnwiredServerFns"));
    expect(codeOnly(rule5.slice(0, 2000))).not.toMatch(/tsCode\(/);
  });

  it("runs in a few seconds and exits green", () => {
    const started = Date.now();
    const out = execFileSync("node", ["scripts/check-dead-machinery.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(out).toMatch(/nothing newly built-and-unwired/);
  }, 40_000);
});

describe("the three files the new rule found", () => {
  it("WeatherStrip is mounted, on the single-day view only", () => {
    const routes = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");
    expect(routes).toMatch(/import \{ WeatherStrip \} from "@\/components\/WeatherStrip";/);
    expect(routes).toMatch(/<WeatherStrip day=\{day\} \/>/);
    // The strip analyses one date. Offering it while the board shows a week
    // would be a control that silently acts on a day you are not looking at.
    expect(routes).toMatch(/range === "today" &&/);
  });

  it("and is collapsed by default, like the tech-load panel beside it", () => {
    const routes = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");
    expect(routes).toMatch(/routes\.showWeather/);
    expect(routes).toMatch(/Show weather/);
    expect(routes).toMatch(/Hide weather/);
  });

  it("LanguageToggle is gone, not left orphaned", () => {
    expect(existsSync(join(root, "src/components/LanguageToggle.tsx"))).toBe(false);
  });

  it("route-plausibility is recorded as a gap, with what would clear it", () => {
    const reason = baseline.unreachable_modules?.["src/lib/route-plausibility.ts"];
    expect(reason).toBeTruthy();
    // KNOWN GAP entries are counted and named on every run, green or not, so
    // writing it down is not the same as dealing with it.
    expect(reason).toMatch(/^KNOWN GAP/);
    expect(reason).toMatch(/not by deleting tested safety work/);
  });

  it("keeps route-plausibility's own tests passing meanwhile", () => {
    // The helper is unwired, not broken. Deleting it would delete seven tests
    // covering a real repro (a stop 1,850 km from the depot).
    expect(existsSync(join(root, "tests/route-plausibility.test.ts"))).toBe(true);
    expect(existsSync(join(root, "src/lib/route-plausibility.ts"))).toBe(true);
  });
});
