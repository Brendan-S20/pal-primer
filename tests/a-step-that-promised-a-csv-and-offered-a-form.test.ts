import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const STEPS = "src/lib/onboarding.functions.ts";
const CHECKLIST = "src/components/OnboardingChecklist.tsx";

/** Source with comments blanked out, same length so offsets still line up.
 *  Load-bearing here rather than decorative: the comment ADDED beside the fix
 *  names both "CSV" and "/imports", so every assertion below would pass on a
 *  file where the fix itself had been deleted and only the prose remained.
 *  The last test in this file proves the stripping is doing that work. */
function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

/** The step objects in the checklist array, as source text, one per entry.
 *  Parsed by matching braces rather than by regex because a step contains
 *  nested object literals (`alt`) and a regex for "{ ... }" stops at the
 *  first inner close. */
function stepLiterals(src: string): string[] {
  const decl = "const steps: OnboardingStep[] = [";
  const start = src.indexOf(decl);
  if (start === -1) return [];
  // The array's own bracket, NOT the one in `OnboardingStep[]` -- indexOf("[")
  // from the declaration finds the type's empty brackets first and walks the
  // rest of the file at depth 0, returning nothing.
  const open = start + decl.length - 1;
  const out: string[] = [];
  let depth = 0;
  let from = -1;
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") {
      if (depth === 0) from = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && from !== -1) {
        out.push(src.slice(from, i + 1));
        from = -1;
      }
    } else if (c === "]" && depth === 0) {
      break;
    }
  }
  return out;
}

// A checklist step is a promise with a button under it. This one promised two
// things -- "Bring in at least one client (or upload a CSV to seed many at
// once)" -- and the only button went to the one-at-a-time form. /imports was
// already built and already in the sidebar, so nothing was missing except a
// door on the screen that named it.
//
// It matters on this step in particular. Every organization in production
// that never added a client never signed in again either, and the signup most
// likely to arrive holding a spreadsheet is the one that already has a book of
// business to bring across.
describe("a setup step offers every path its own description promises", () => {
  const src = codeOnly(read(STEPS));
  const steps = stepLiterals(src);

  it("parses the steps at all", () => {
    // Guard for the rest of the file: every assertion below is of the form
    // "no step is wrong", which is vacuously true of an empty list. This is
    // the same failure mode as a viewport sweep measuring a blank page.
    expect(steps.length, `${STEPS}: no step literals parsed`).toBeGreaterThanOrEqual(7);
    expect(steps.some((s) => /id:\s*"clients"/.test(s))).toBe(true);
  });

  it("routes a step that mentions a spreadsheet to the importer", () => {
    const promisesImport = (s: string) => /csv|spreadsheet|import/i.test(s.match(/description:\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/)?.[1] ?? "");
    const candidates = steps.filter(promisesImport);
    expect(
      candidates.length,
      `${STEPS}: no step describes an import — did the description change?`,
    ).toBeGreaterThan(0);
    for (const step of candidates) {
      const id = step.match(/id:\s*"([^"]+)"/)?.[1] ?? "?";
      expect(
        step,
        `${STEPS}: the "${id}" step's description offers a spreadsheet import, so the ` +
          "step must offer a control that reaches /imports. Naming the CSV in the copy " +
          "and shipping only the one-at-a-time form is the bug this test exists for.",
      ).toMatch(/alt:\s*\{[^}]*to:\s*"\/imports"/);
    }
  });

  it("gates that control, because /imports admits fewer roles than /clients/new", () => {
    // /imports is owner+office_manager; /clients/new also admits dispatchers.
    // An ungated second button offers a dispatcher a route that bounces them
    // straight back, which is a worse answer than not offering it.
    const step = steps.find((s) => /id:\s*"clients"/.test(s)) ?? "";
    expect(step, `${STEPS}: the clients step must declare the gate`).toMatch(
      /alt:\s*\{[^}]*gate:\s*"\/imports"/,
    );

    const view = codeOnly(read(CHECKLIST));
    expect(view, `${CHECKLIST} must render the second action`).toContain("step.alt");
    expect(
      view,
      `${CHECKLIST} must gate the second action with canAccess — the step data cannot ` +
        "see the viewer's role, so an ungated render shows /imports to a dispatcher.",
    ).toMatch(/step\.alt\s*&&\s*canAccess\(role,\s*step\.alt\.gate\)/);
  });

  it("is not reading the comment that explains the fix", () => {
    // The tripwire. If codeOnly ever stops stripping, every assertion above
    // starts passing on prose, and the one that matters -- alt: { to:
    // "/imports" } -- can be deleted without a single test going red.
    const raw = read(STEPS);
    const count = (s: string, needle: string) => s.split(needle).length - 1;
    expect(
      count(raw, "/imports"),
      `${STEPS}: this test's tripwire assumes the explanatory comment mentions /imports`,
    ).toBeGreaterThan(count(src, "/imports"));
    expect(count(raw, "CSV")).toBeGreaterThan(count(src, "CSV"));
  });
});
