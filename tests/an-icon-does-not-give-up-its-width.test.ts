import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// An icon in a flex row is a flex item, and a flex item shrinks unless told
// not to. Beside wrapping text it gives up width to the text, by an amount
// that depends on how long THAT row's text is, so a column of rows starts its
// text at a different x on every row. Measured on the owner's Get started
// checklist in the iOS simulator on 2026-09-27: five rows, identical
// `h-5 w-5` icons, titles beginning anywhere from x=165 to x=177.
//
// `h-5 w-5` is a request, not a floor. `shrink-0` is the floor, and on an
// icon it is never wrong: an absolutely positioned or block icon ignores it,
// and an icon in a flex row should never be the thing that gives way. When
// this landed, 429 sized lucide icons in 124 files lacked it; all were fixed
// in the same change, so this is a ratchet from zero.
//
// Scoped to what shipped: a lucide-react component (named by that file's own
// import from "lucide-react") with a plain className string carrying a size
// utility (h-N, w-N or size-N). Silent on template-literal classNames, of
// which there were none, and on non-lucide SVGs.

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

describe("icons keep their width", () => {
  it("every sized lucide icon carries shrink-0", () => {
    const offenders: string[] = [];
    for (const file of walk("src")) {
      const src = readFileSync(file, "utf8");
      const imp = src.match(/import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']/);
      if (!imp) continue;
      const names = imp[1]
        .split(",")
        .map((x) => x.trim().split(/\s+as\s+/).pop() ?? "")
        .filter((n) => /^[A-Z]/.test(n));
      if (names.length === 0) continue;
      const re = new RegExp(`<(${names.join("|")})\\b[^>]*?className="([^"]*)"`, "g");
      for (const m of src.matchAll(re)) {
        const cls = m[2];
        if (/\b(h|w|size)-\d/.test(cls) && !/\bshrink-0\b/.test(cls)) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${file}:${line}  <${m[1]} className="${cls}">`);
        }
      }
    }
    expect(offenders, "add shrink-0 to the icon's className").toEqual([]);
  });
});
