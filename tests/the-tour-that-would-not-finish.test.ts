// Why the guided tour "isn't allowed to continue through all the way".
//
// ── WHAT WAS MEASURED ─────────────────────────────────────────────────────
//
// The owner, 2026-10-08: "the walk through tour isn't too productive and isn't
// allowed to continue through all the way." Walked in Chromium against the
// stubbed backend (touch on), the tour as it shipped in
// src/components/OnboardingTour.tsx went like this:
//
//   360x780   8 of 8 steps, Done reached.
//   768x1024  steps 1-5 fine; step 6 "My Day": card top -214, bottom -12.
//   1280x800  steps 1-5 fine; step 6 "My Day": card top -214, bottom -12.
//
// At step 6 on every tablet and desktop width the card was ABOVE the top of
// the screen, Next and "Skip tour" with it, over a dimmed `fixed inset-0`
// layer that swallowed every other click. No way forward, no way out, and a
// reload brought the tour back because it had never been finished. The
// screenshot of that state is a dimmed My Day with nothing on it to press.
//
// ── THE CAUSE ─────────────────────────────────────────────────────────────
//
// OnboardingTour.tsx:139-141, `cardPosition()`:
//
//     const tabBar = document.querySelector('nav[aria-label="Primary"]');
//     const safeBottom = tabBar ? vh - tabBar.getBoundingClientRect().top : 0;
//
// The phone tab bar is in the DOM at every width and `display: none` from
// `md` up (`lg` for a tech on a tablet). A hidden element's rect is all
// zeros, so `top` is 0 and `safeBottom` is the WHOLE viewport height. Every
// placement that clears the bar then pushes the card off the top:
//
//   anchor low on the screen   bottom = max(vh - rect.top + 12, vh + 12)
//   anchor elsewhere           top    = min(..., vh - 240 - vh) = -240
//
// Steps 2-5 survived by luck: their sidebar anchors are high, which takes
// the sidebar branch, whose `max(..., safeTop + 12)` floor happened to rescue
// it. My Day, Invoices and Settings sit low in the sidebar.
//
// My Day measures the same bar for its map and got it right
// (my-day.tsx: "A bar hidden at this width has no height and must not pull
// the floor up to zero"). The tour never had that line.
//
// ── WHAT THIS FILE HOLDS ──────────────────────────────────────────────────
//
// The tour is gone, replaced by the guided setup at /setup, which has no
// floating card to misplace (tests/every-setup-step-has-somewhere-to-go.test.ts
// pins that; tests/viewports/the-setup-that-finishes.spec.ts walks it). So:
//
//   1. The placement AS SHIPPED, run against a hidden bar, reproducing the
//      measured numbers. An exhibit, so the cause is a test and not a story.
//   2. A guard on the live code: anything that measures the bottom chrome to
//      place something must skip a bar with no height.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { repoRelative } from "./support/repo-paths";

const ROOT = resolve(__dirname, "..");

type Rect = { top: number; bottom: number; left: number; right: number; width: number; height: number };
const rect = (top: number, left: number, width: number, height: number): Rect => ({
  top,
  left,
  width,
  height,
  bottom: top + height,
  right: left + width,
});
const ZERO = rect(0, 0, 0, 0);

/** OnboardingTour.tsx `cardPosition`, verbatim as shipped at 8675cdc3, with
 *  `window` and `document` passed in rather than read from globals. */
function cardPositionAsShipped(
  r: Rect | null,
  win: { innerWidth: number; innerHeight: number },
  doc: { querySelector: (sel: string) => { getBoundingClientRect: () => Rect } | null },
): Record<string, number | string> {
  const CARD_W = 320;
  const GAP = 12;
  const vw = win.innerWidth;
  const vh = win.innerHeight;
  const header = doc.querySelector("header");
  const tabBar = doc.querySelector('nav[aria-label="Primary"]');
  const safeTop = header ? header.getBoundingClientRect().bottom : 0;
  const safeBottom = tabBar ? vh - tabBar.getBoundingClientRect().top : 0;

  if (!r) {
    return { top: "50%", left: "50%", transform: "translate(-50%, -50%)" };
  }

  const clampLeft = (x: number) => Math.max(GAP, Math.min(x, vw - CARD_W - GAP));

  if (r.top > vh * 0.6) {
    return {
      bottom: Math.max(vh - r.top + GAP, safeBottom + GAP),
      left: clampLeft(r.left + r.width / 2 - CARD_W / 2),
    };
  }
  if (r.right < vw * 0.5) {
    return {
      top: Math.max(Math.min(r.top, vh - 240 - safeBottom), safeTop + GAP),
      left: clampLeft(r.right + GAP),
    };
  }
  return {
    top: Math.min(r.bottom + GAP, vh - 240 - safeBottom),
    left: clampLeft(r.left + r.width / 2 - CARD_W / 2),
  };
}

/** The card's top edge on screen, from whichever side it was placed by. The
 *  card measured 202px tall with the tour's longest copy. */
const CARD_H = 202;
function cardTop(pos: Record<string, number | string>, vh: number): number {
  if (typeof pos.top === "number") return pos.top;
  if (typeof pos.bottom === "number") return vh - pos.bottom - CARD_H;
  return NaN;
}

function page(vw: number, vh: number, tabBar: Rect | null) {
  return {
    win: { innerWidth: vw, innerHeight: vh },
    doc: {
      querySelector: (sel: string) => {
        if (sel === "header") return { getBoundingClientRect: () => rect(0, 0, vw, 56) };
        if (sel.startsWith("nav") && tabBar) return { getBoundingClientRect: () => tabBar };
        return null;
      },
    },
  };
}

describe("the tour's card left the screen whenever the tab bar was hidden", () => {
  // The My Day entry in the desktop sidebar, where it was measured: low on
  // the screen, in the left-hand rail.
  const MY_DAY_IN_THE_SIDEBAR = rect(620, 8, 240, 36);

  it.each([
    [768, 1024, rect(870, 8, 240, 36)],
    [1280, 800, MY_DAY_IN_THE_SIDEBAR],
  ])("at %ipx with the bar display:none, the card is above the screen", (vw, vh, anchor) => {
    const { win, doc } = page(vw, vh, ZERO);
    const pos = cardPositionAsShipped(anchor, win, doc);
    // bottom = vh + 12, i.e. the card's bottom edge 12px ABOVE the top of the
    // viewport: the -12 the browser walk measured.
    expect(pos.bottom).toBe(vh + 12);
    expect(cardTop(pos, vh) + CARD_H, "the card's bottom edge is on screen").toBeLessThan(0);
  });

  it("the same anchor with no bar in the DOM at all would have been fine", () => {
    const { win, doc } = page(1280, 800, null);
    const top = cardTop(cardPositionAsShipped(MY_DAY_IN_THE_SIDEBAR, win, doc), 800);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + CARD_H).toBeLessThanOrEqual(800);
  });

  it("and so would the bar's real edge, which is why phones were fine", () => {
    const { win, doc } = page(360, 780, rect(724, 0, 360, 56));
    const tabBarAnchor = rect(724, 288, 72, 56);
    const top = cardTop(cardPositionAsShipped(tabBarAnchor, win, doc), 780);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + CARD_H).toBeLessThanOrEqual(724);
  });

  it("an anchor that is not low still lost its card below the anchor branch", () => {
    // The third branch: `vh - 240 - safeBottom` is -240 with a hidden bar.
    const { win, doc } = page(1280, 800, ZERO);
    const pos = cardPositionAsShipped(rect(200, 900, 120, 36), win, doc);
    expect(pos.top).toBe(-240);
  });
});

/** Every source file under src/, read once: two scans share it, and on a
 *  loaded runner the walk is the slow part. */
let SOURCES: Array<[string, string]> | null = null;
function sources(): Array<[string, string]> {
  if (SOURCES) return SOURCES;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return walk(p);
      return /\.(ts|tsx)$/.test(f) ? [p] : [];
    });
  SOURCES = walk(join(ROOT, "src")).map((f) => [f, readFileSync(f, "utf8")]);
  return SOURCES;
}

describe("whatever measures the bottom bar skips it when it is hidden", { timeout: 180_000 }, () => {
  it("never reads the tab bar by its translated label", () => {
    // `aria-label` comes from t("nav.primary"). In Spanish the selector
    // matched nothing; in English it matched a hidden bar. Neither is a way
    // to find the bar: `[data-bottom-chrome]` is.
    const hits = sources().filter(([, src]) =>
      /querySelector(All)?\(\s*['"`]nav\[aria-label=/.test(src),
    );
    expect(hits.map(([f]) => repoRelative(f, ROOT))).toEqual([]);
  });

  it("checks for a height before trusting a bottom bar's edge", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const [f, src] of sources()) {
      for (const m of src.matchAll(/querySelectorAll<?[^(]*>?\(\s*["'`]\[data-bottom-chrome\]["'`]\s*\)/g)) {
        const after = src.slice(m.index!, m.index! + 600);
        if (!/getBoundingClientRect/.test(after)) continue;
        sites += 1;
        if (!/\.height\s*>\s*0/.test(after)) {
          const line = src.slice(0, m.index!).split("\n").length;
          offenders.push(`${repoRelative(f, ROOT)}:${line}`);
        }
      }
    }
    // My Day's map measures the bar today; if the scan finds no site at all
    // the regex has drifted and the assertion below proves nothing.
    expect(sites, "found no measurement of [data-bottom-chrome] at all").toBeGreaterThan(0);
    expect(
      offenders,
      "a hidden bar measures 0 at the top, which reads as a bar the height of the screen",
    ).toEqual([]);
  });
});
