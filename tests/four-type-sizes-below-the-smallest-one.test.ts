// "A lot of inconsistencies with small things."
//
// Measured rather than eyeballed, and it was two specific things.
//
// ── 157 UNDECLARED TYPE SIZES ─────────────────────────────────────────────
//
// 93 uses of `text-[11px]`, 64 of `text-[10px]`, 4 of `text-[9px]`, one
// `text-[15px]`. Four sizes below Tailwind's smallest declared step is not a
// scale, it is a habit: every dense table cell, badge and helper line took
// whichever number its author had in mind, so adjacent components sat a pixel
// apart for no reason anybody could state. Arbitrary sizes also inherit
// whatever line-height is in scope, which is why two 11px labels in different
// cards did not sit on the same baseline.
//
// Two named steps now carry the same pixel values, so nothing moved on
// screen — this was a rename, and the point of it is that the next person has
// something to reach for instead of a number.
//
// ── FOUR HEADING TREATMENTS INSIDE ONE SECTION ────────────────────────────
//
// The Settings shell renders <h1>Settings</h1> at text-2xl. Beneath it, its
// sub-pages rendered: h1 text-2xl (11 pages, a second 24px heading directly
// under the first), h1 text-xl (3), h2 text-lg (3), and nothing at all (2,
// which opened straight into a card). Clicking down the Settings sidebar made
// the title change size and the page start in a different place.
//
// All eighteen are h2 at text-lg now — subordinate to the shell's h1, which
// is what they always were semantically.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const styles = readFileSync(join(root, "src/styles.css"), "utf8");

/** Every .tsx under src, recursively. */
function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const ALL = tsxFiles(join(root, "src"));

describe("the type scale is declared, not improvised", () => {
  it("has the two steps below text-xs", () => {
    expect(styles).toMatch(/--text-2xs: 0\.6875rem;/);
    expect(styles).toMatch(/--text-3xs: 0\.625rem;/);
  });

  it("pins their line heights instead of inheriting", () => {
    expect(styles).toMatch(/--text-2xs--line-height: 0\.9375rem;/);
    expect(styles).toMatch(/--text-3xs--line-height: 0\.875rem;/);
  });

  it("stops at 10px", () => {
    // Below that is not a size, it is an accessibility problem. The four
    // `text-[9px]` uses were rounded up to the 10px step.
    expect(styles).not.toMatch(/--text-4xs:/);
  });

  it("no component sets a micro size by hand any more", () => {
    // 15px survives in LegalShell — it is body copy for terms pages, a
    // reading measure rather than a UI density decision, and it is the one
    // arbitrary size that is a deliberate typographic choice.
    const offenders: string[] = [];
    for (const f of ALL) {
      const src = readFileSync(f, "utf8");
      for (const m of src.match(/text-\[\d+px\]/g) ?? []) {
        if (m === "text-[15px]") continue;
        offenders.push(`${f.slice(root.length + 1)}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the named steps are actually in use", () => {
    // Guards against the scale being declared and then ignored, which would
    // leave the codebase exactly as it was plus two dead custom properties.
    const used = ALL.filter((f) => /\btext-[23]xs\b/.test(readFileSync(f, "utf8")));
    expect(used.length).toBeGreaterThan(30);
  });
});

describe("Settings sub-pages agree on what a heading is", () => {
  const settings = ALL.filter((f) => /settings\.[a-z-]+\.tsx$/.test(f));

  it("none of them renders a second h1 under the shell's", () => {
    const withH1 = settings.filter((f) => readFileSync(f, "utf8").includes("<h1"));
    expect(withH1).toEqual([]);
  });

  it("the shell still owns the h1", () => {
    const shell = readFileSync(join(root, "src/routes/_authenticated/settings.tsx"), "utf8");
    expect(shell).toMatch(/<h1 className="text-2xl font-semibold">Settings<\/h1>/);
  });

  it("every sub-page with a heading uses the same one", () => {
    const sizes = new Set<string>();
    for (const f of settings) {
      const m = readFileSync(f, "utf8").match(/<h2 className="([^"]*)"/);
      if (!m) continue;
      const size = (m[1].match(/text-(xs|sm|base|lg|xl|2xl|3xl)/) ?? [])[0];
      if (size) sizes.add(size);
    }
    expect([...sizes]).toEqual(["text-lg"]);
  });

  it("the two that opened straight into a card now say what they are for", () => {
    for (const name of ["settings.deep-clean.tsx", "settings.preferences.tsx"]) {
      const src = readFileSync(join(root, "src/routes/_authenticated", name), "utf8");
      expect(src).toMatch(/<h2 className="text-lg font-semibold">/);
    }
  });
});
