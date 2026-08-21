// `env(safe-area-inset-*)` resolves to 0 on iOS unless the viewport meta says
// `viewport-fit=cover`. It did not, so every safe-area rule in this codebase —
// the tab bar's `pb-[env(safe-area-inset-bottom)]`, the sheets, my-day's header
// padding, the portal's bottom bar — was inert inside the native shell.
//
// Nothing caught it, and the reason is worth stating: the class list is
// identical either way. `tests/tablet-tier.test.ts` asserts that
// `mainBottomPadding` CONTAINS "safe-area-inset-bottom" and it passed happily
// the whole time, because the class WAS there. That test is right; it is just
// checking a different question from "does the value resolve to anything".
//
// Measured on an iPhone 17 Pro, iOS QA 2026-08-20:
//   - bottom tab bar content ended at 864.7pt of 874pt — a 9.3pt gap on a
//     device whose safe-area-inset-bottom is 34pt, i.e. the labels sat in the
//     home-indicator strip. After the fix: 830.7pt, a 43.3pt gap. The
//     difference is exactly the 34pt inset.
//   - /auth's wordmark started at 20.7pt against a 59pt top inset, so the
//     clock was drawn over the "H" and the Dynamic Island covered "ndS".
//
// ── AND WHY BOTH HALVES ARE GATED ─────────────────────────────────────────
//
// `main` deploys `src/` straight to app.houndstack.com, so an iOS fix in shared
// code is live on the web the moment it merges. Owner decision (2026-08-21):
// these must not change the hosted product. So each assertion below comes in
// pairs — the native branch does the right thing, and the web branch is still
// the thing it always was.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("the one line that makes env(safe-area-inset-*) mean anything", () => {
  const src = codeOnly(read("src/routes/__root.tsx"));

  it("serves viewport-fit=cover to the native bundle", () => {
    const at = src.indexOf('name: "viewport"');
    expect(at, "the viewport meta is gone — retarget this test").toBeGreaterThan(-1);
    const block = src.slice(at, at + 500);
    expect(
      block,
      "without viewport-fit=cover every env(safe-area-inset-*) in this repo silently resolves to 0",
    ).toMatch(/viewport-fit\s*=\s*cover/);
    expect(block, "the viewport meta is no longer gated on the build").toMatch(/IS_NATIVE_BUNDLE/);
  });

  it("serves the hosted app the viewport it already had", () => {
    // `cover` changes how an installed PWA lays out. The web product has not
    // asked for that, and this is the assertion that keeps an iOS pass from
    // deciding it on the web's behalf.
    const at = src.indexOf('name: "viewport"');
    const block = src.slice(at, at + 500);
    const web = block.slice(block.indexOf(":", block.indexOf("IS_NATIVE_BUNDLE")));
    expect(web, "the non-native viewport branch is missing").toMatch(/width=device-width/);
    expect(
      web.split("viewport-fit")[1] ?? "",
      "viewport-fit leaked into the web branch",
    ).not.toMatch(/^\s*=\s*cover/);
  });
});

describe("the shell every signed-out screen is built on", () => {
  const src = codeOnly(read("src/components/PublicShell.tsx"));

  it("keeps the hosted app's flat spacing", () => {
    expect(src, "PublicShell's web spacing changed").toMatch(/\bpx-4\b/);
    expect(src, "PublicShell's web spacing changed").toMatch(/\bpy-10\b/);
  });

  it("adds the insets on top of it, native only", () => {
    // Below `sm` this shell is items-start, so the first thing on the page sits
    // at whatever the top padding is. A flat py-10 is 40pt against a 59pt inset.
    expect(src).toMatch(/IS_NATIVE_BUNDLE/);
    for (const side of ["top", "bottom", "left", "right"]) {
      expect(src, `no native ${side} inset`).toMatch(
        new RegExp(`env\\(safe-area-inset-${side}\\)`),
      );
    }
  });

  it("applies them as an inline style, not new utilities", () => {
    // Tailwind emits a rule for every class it finds in source, branch or no
    // branch, so arbitrary safe-area utilities here would land in the SHARED
    // stylesheet — the hosted CSS would grow rules for a platform it does not
    // serve. An inline style emits none. Verified: `.output`'s
    // styles-*.css is byte-identical, filename hash included.
    expect(src, "safe-area padding is back as Tailwind classes").not.toMatch(
      /p[tblrxy]-\[calc\([^\]]*safe-area-inset/,
    );
    expect(src).toMatch(/padding(Top|Bottom|Left|Right)\s*:/);
  });
});

describe("the rules that were relying on it", () => {
  // Not an exhaustive sweep — just proof that real consumers still exist, so
  // that if someone removes viewport-fit=cover the test above is not guarding
  // an empty set.
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`;
      if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
      else if (/\.tsx?$/.test(name)) out.push(rel);
    }
    return out;
  }

  it("there are still call sites whose correctness depends on it", () => {
    const users = walk("src").filter((f) => /env\(safe-area-inset-/.test(read(f)));
    expect(
      users.length,
      "nothing uses env(safe-area-inset-*) any more — this whole file can go",
    ).toBeGreaterThan(3);
    // The bottom tab bar is the one QA measured sitting under the home
    // indicator, so name it explicitly rather than trusting a count.
    expect(users).toContain("src/components/MobileTabBar.tsx");
  });
});
