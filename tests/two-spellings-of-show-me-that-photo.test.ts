/**
 * One photo viewer, not one per audience.
 *
 * ── WHAT THIS IS ABOUT ────────────────────────────────────────────────────
 *
 * #203 gave the field app a real photo viewer: a Radix dialog that traps
 * focus, restores it to the thumbnail, goes inert to a screen reader behind
 * the overlay, closes on Escape and pages with the arrow keys.
 *
 * The customer portal already had "a lightbox", and it was this:
 *
 *     <div onClick={() => setLightbox(null)} className="fixed inset-0 ...">
 *       <img src={lightbox} />
 *     </div>
 *
 * None of the four. Tab walked the page behind it. A screen reader read
 * straight through. Escape did nothing. And because the close handler sat on
 * the PARENT, a click on the photo itself bubbled up and dismissed it, so a
 * customer could not tap their own before-and-after without closing it. It
 * also held a single URL string, so paging between a visit's photos was
 * impossible by construction.
 *
 * Two implementations of "show me that photo", and the one with fewer eyes on
 * it was the worse one. That is the same shape as every other drift this repo
 * has been bitten by -- road_factor in three places, the timezone default in
 * four -- and it is worth a test for the same reason: nothing FAILS when they
 * diverge, the quieter surface just quietly gets worse.
 *
 * ── WHAT IT DOES NOT ASSERT ───────────────────────────────────────────────
 *
 * Not "every <img> goes through PhotoLightbox". Avatars, logos, map tiles and
 * the thumbnails themselves are images nobody expects to open full-screen.
 * The rule is narrower and is the one that matters: a surface that opens a
 * photo FULL SCREEN uses the shared viewer, and no file re-implements the
 * fixed-inset overlay it replaced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** TS with comments stripped, quote-aware so a `//` in a URL survives. */
export function codeOnly(ts: string): string {
  const noBlocks = ts.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") quote = c;
        else if (c === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** Every .ts/.tsx under src/, recursively. */
function sourceFiles(dir = join(root, "src"), out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("the stripper this file rests on", () => {
  it("removes the prose that quotes the old overlay", () => {
    // This very file's header, and the comment in portal-ui, both QUOTE the
    // markup being banned. Without stripping, the rule below fails on the
    // files that fixed the bug.
    const raw = read("src/lib/portal-ui.tsx");
    expect(raw).toContain("fixed inset-0");
    expect(codeOnly(raw)).toContain("PhotoLightbox");
  });
});

describe("one photo viewer", () => {
  it("the customer portal uses the shared component", () => {
    const ui = codeOnly(read("src/lib/portal-ui.tsx"));
    expect(ui).toMatch(/import \{ PhotoLightbox \} from "@\/components\/PhotoLightbox"/);
    expect(ui).toMatch(/<PhotoLightbox/);
  });

  it("the field app uses the same one", () => {
    const md = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(md).toMatch(/import \{ PhotoLightbox \} from "@\/components\/PhotoLightbox"/);
    expect(md).toMatch(/<PhotoLightbox/);
  });

  it("the viewer keeps the four things the hand-rolled overlay lacked", () => {
    const lb = codeOnly(read("src/components/PhotoLightbox.tsx"));
    // Focus trap + inert background + restore, all from Radix.
    expect(lb).toMatch(/DialogPrimitive\.Root/);
    expect(lb).toMatch(/DialogPrimitive\.Content/);
    // A name for a screen reader.
    expect(lb).toMatch(/DialogPrimitive\.Title/);
    // Paging, which a single URL string could not express.
    expect(lb).toMatch(/ArrowLeft/);
    expect(lb).toMatch(/ArrowRight/);
  });

  it("nobody re-implements the overlay it replaced", () => {
    // The shape being banned: a full-viewport fixed overlay whose OWN click
    // handler closes it, with an image inside. PhotoLightbox itself is exempt
    // -- it is the thing everyone is supposed to use.
    //
    // ── WHY THIS IS NOT ONE REGEX OVER THE TAG ────────────────────────────
    //
    // The first version was, and it could never have fired:
    //
    //     /<div\b[^>]*className="[^"]*fixed inset-0[^"]*"[^>]*>/
    //
    // `[^>]*` stops at the first `>`, and an inline handler contains one --
    // `onClick={() => setLightbox(null)}` has a `>` in the arrow. So the
    // pattern could not reach className past any arrow function, which is
    // every real instance of the thing it was written to catch. Proven by
    // pasting the exact overlay back in: five tests, five passes.
    //
    // So: anchor on the class, walk BACK to the opening `<div`, and look
    // forward a bounded way for an <img>. Nothing here crosses a tag
    // boundary by accident because the backward walk stops at the nearest
    // `<`.
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      if (file.endsWith("PhotoLightbox.tsx")) continue;
      const code = codeOnly(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/fixed inset-0/g)) {
        const at = m.index ?? 0;
        const open = code.lastIndexOf("<", at);
        if (open < 0 || !code.startsWith("<div", open)) continue;
        // The tag runs from `<div` to the class match and a little past it;
        // the handler may sit on either side of className.
        const close = code.indexOf(">", code.indexOf('"', code.indexOf("className", open) + 9) + 1);
        const tag = code.slice(open, close > open ? close + 1 : at + 60);
        if (!/onClick=/.test(tag)) continue;
        if (!/<img\b/.test(code.slice(at, at + 400))) continue;
        offenders.push(`${file.replace(root + "/", "")}  ${tag.replace(/\s+/g, " ").slice(0, 90)}`);
      }
    }
    expect(
      offenders,
      `a hand-rolled photo overlay is back; use PhotoLightbox:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
