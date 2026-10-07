// NEXT UP sits on the tab bar, and the tab bar's height is one number.
//
// On 2026-10-07 the owner circled a gap on an iPhone 17 Pro: My Day's NEXT UP
// strip floated 5px above the bottom tab bar and the stop list scrolled
// through it. The cause was two halves of one fact written in two ways: the
// strip parked at `calc(3.5rem + inset)`, and the bar was as tall as its
// contents came to, 51px. The browser half of this
// (tests/viewports/my-day-gets-its-room-back.spec.ts) measures the edges.
// This half says where to look when it fails: every offset that clears the
// tab bar reads `--tab-bar-h`, the bar is drawn at exactly that, and nothing
// in src/ spells the bar's height as a literal again.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

describe("the tab bar's height", () => {
  it("is defined once, in styles.css", () => {
    expect(read("src/styles.css")).toMatch(/--tab-bar-h:\s*3\.5rem;/);
  });

  it("is the height MobileTabBar is drawn at, above the home indicator", () => {
    const bar = read("src/components/MobileTabBar.tsx");
    expect(bar).toContain("h-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))]");
    expect(bar).toContain("pb-[env(safe-area-inset-bottom)]");
    // The tabs fill the row, or the row is taller than what is in it.
    expect(bar).toMatch(/const tabClass[\s\S]*?`flex h-full /);
  });

  it("is what NEXT UP parks on, and the list's padding clears", () => {
    const myDay = read("src/routes/_authenticated/my-day.tsx");
    expect(myDay).toContain("max-md:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))]");
    expect(myDay).toContain("max-lg:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))]");
    expect(myDay).toContain("pb-[calc(7rem+var(--tab-bar-h)+env(safe-area-inset-bottom))]");
  });

  it("is never spelled as a literal beside the home-indicator inset again", () => {
    // `3.5rem + env(safe-area-inset-bottom)` was the bar's height written down
    // by each caller for itself. Any such pair, anywhere in src/.
    const offenders = walk(join(root, "src"))
      .flatMap((p) =>
        readFileSync(p, "utf8")
          .split("\n")
          .map((line, i) => ({ line, at: `${repoRelative(p, root)}:${i + 1}` })),
      )
      .filter(({ line }) => /3\.5rem\+env\(safe-area-inset-bottom\)/.test(line))
      .map(({ at }) => at);
    expect(offenders).toEqual([]);
  });
});
