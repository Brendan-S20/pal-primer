/**
 * An app that moves, and moves the right way.
 *
 * The owner, 2026-10-04: "I want to have transitions added, loading screen if
 * it's taking a while to load, I want animations, and basic app gestures to
 * work ... We need to be ahead of the curve."
 *
 * The motion itself is checked in a browser
 * (tests/viewports/an-app-that-moves.spec.ts). What is pinned here is the
 * arithmetic that decides it, because every one of these is a number or a
 * rule somebody will be tempted to nudge by feel:
 *
 *   * which way a navigation slides (src/lib/motion/direction.ts), including
 *     that "deeper" is the END edge, so Arabic gets the mirror image;
 *   * when the progress bar is allowed to appear (src/lib/motion/pending.ts);
 *   * when a pull refreshes and a swipe dismisses (src/lib/motion/gestures.ts);
 *   * that reduced motion is honoured in the stylesheet, not just in script.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { navDirection, uaAlreadyAnimated, type NavInput } from "../src/lib/motion/direction";
import {
  PENDING_MIN_VISIBLE_MS,
  PENDING_SHOW_AFTER_MS,
  remainingVisibleMs,
  shouldShowProgress,
} from "../src/lib/motion/pending";
import {
  GESTURE_SLOP_PX,
  PULL_MAX_PX,
  PULL_THRESHOLD_PX,
  gestureAxis,
  pullDistance,
  shouldDismissSheet,
} from "../src/lib/motion/gestures";

const root = join(import.meta.dirname, "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

const nav = (over: Partial<NavInput>): NavInput => ({
  fromPath: "/clients",
  toPath: "/clients/123",
  isPop: false,
  uaTransitioned: false,
  reducedMotion: false,
  ...over,
});

describe("which way a page moves", () => {
  it("goes deeper forward and shallower back", () => {
    expect(navDirection(nav({}))).toBe("forward");
    expect(navDirection(nav({ fromPath: "/clients/123", toPath: "/clients" }))).toBe("back");
    expect(navDirection(nav({ fromPath: "/settings", toPath: "/settings/users" }))).toBe(
      "forward",
    );
    expect(
      navDirection(nav({ fromPath: "/clients/123/edit", toPath: "/clients/123" })),
    ).toBe("back");
  });

  it("crossfades between top-level sections, which is what a tab is", () => {
    expect(navDirection(nav({ fromPath: "/dashboard", toPath: "/clients" }))).toBe("tab");
    expect(navDirection(nav({ fromPath: "/my-day", toPath: "/waste-log" }))).toBe("tab");
    // Even when the history went back: tabs have no back stack.
    expect(
      navDirection(
        nav({ fromPath: "/clients", toPath: "/dashboard", isPop: true, fromIndex: 4, toIndex: 3 }),
      ),
    ).toBe("tab");
  });

  it("believes the history over the URL when the history went back", () => {
    // Reached /clients from /clients/123 by a link, then pressed back: the
    // URL gets deeper, but the user went BACK.
    expect(
      navDirection(
        nav({
          fromPath: "/clients/9/billing",
          toPath: "/clients/9/billing/invoices/2",
          isPop: true,
          fromIndex: 5,
          toIndex: 4,
        }),
      ),
    ).toBe("back");
    expect(
      navDirection(
        nav({ fromPath: "/clients/123", toPath: "/clients", isPop: true, fromIndex: 2, toIndex: 3 }),
      ),
    ).toBe("forward");
  });

  it("does not let a link that happens to go up pass for a history pop", () => {
    // A push carries a higher index, but it is the URL shape that decides.
    expect(
      navDirection(nav({ fromPath: "/clients/123", toPath: "/clients", fromIndex: 2, toIndex: 3 })),
    ).toBe("back");
  });

  it("steps forward into another section's detail, and back out of one", () => {
    expect(navDirection(nav({ fromPath: "/clients/1", toPath: "/invoices/2" }))).toBe("forward");
    expect(navDirection(nav({ fromPath: "/invoices/2", toPath: "/dashboard" }))).toBe("back");
  });

  it("does not move at all when it should not", () => {
    expect(navDirection(nav({ fromPath: undefined }))).toBe("none"); // first load
    expect(navDirection(nav({ fromPath: "/my-day", toPath: "/my-day" }))).toBe("none"); // ?date=
    expect(navDirection(nav({ fromPath: "/clients/", toPath: "/clients" }))).toBe("none");
    expect(navDirection(nav({ reducedMotion: true }))).toBe("none");
    // The platform already animated an edge swipe: animating again on top of
    // it is the double animation this exists to prevent.
    expect(
      navDirection(
        nav({
          fromPath: "/clients/123",
          toPath: "/clients",
          isPop: true,
          uaTransitioned: true,
        }),
      ),
    ).toBe("none");
  });

  it("stands aside for a swipe-back the platform animated, and assumes one on iOS when it cannot ask", () => {
    expect(uaAlreadyAnimated(true, false)).toBe(true);
    expect(uaAlreadyAnimated(false, true)).toBe(false);
    expect(uaAlreadyAnimated(undefined, false)).toBe(false);
    expect(uaAlreadyAnimated(undefined, true)).toBe(true);
  });
});

describe("the slide is logical, so Arabic gets the mirror image", () => {
  it("flips one variable on a right-to-left document and nothing else", () => {
    expect(css).toMatch(/:root\s*\{[^}]*--motion-dir:\s*1;/);
    expect(css).toMatch(/:root\[dir="rtl"\]\s*\{\s*--motion-dir:\s*-1;\s*\}/);
  });

  it("drives every horizontal page keyframe through that variable", () => {
    const keyframes = [...css.matchAll(/@keyframes (hs-page-[a-z-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(keyframes.map((k) => k[1]).sort()).toEqual([
      "hs-page-in-from-end",
      "hs-page-in-from-start",
      "hs-page-out-to-end",
      "hs-page-out-to-start",
    ]);
    for (const [, name, body] of keyframes) {
      expect(body, name).toMatch(/translateX\(calc\(var\(--motion-dir\)/);
      // No physical side written into a page transition.
      expect(body, name).not.toMatch(/\bleft\b|\bright\b/);
    }
  });

  it("brings a deeper page in from the end edge and sends a page back out to it", () => {
    const rule = (sel: string) =>
      css.match(new RegExp(`${sel.replace(/[[\]().]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";
    expect(rule('html[data-nav-dir="forward"]::view-transition-new(hs-page)')).toMatch(
      /hs-page-in-from-end/,
    );
    expect(rule('html[data-nav-dir="back"]::view-transition-old(hs-page)')).toMatch(
      /hs-page-out-to-end/,
    );
    expect(rule('html[data-nav-dir="tab"]::view-transition-new(hs-page)')).toMatch(/hs-fade-in/);
  });
});

describe("the progress bar only appears for a slow navigation", () => {
  it("waits about 300ms before drawing anything", () => {
    expect(PENDING_SHOW_AFTER_MS).toBeGreaterThanOrEqual(250);
    expect(PENDING_SHOW_AFTER_MS).toBeLessThanOrEqual(400);
    expect(shouldShowProgress(0)).toBe(false);
    expect(shouldShowProgress(PENDING_SHOW_AFTER_MS - 1)).toBe(false);
    expect(shouldShowProgress(PENDING_SHOW_AFTER_MS)).toBe(true);
  });

  it("once drawn, stays long enough not to be a flash", () => {
    expect(remainingVisibleMs(0)).toBe(PENDING_MIN_VISIBLE_MS);
    expect(remainingVisibleMs(100)).toBe(PENDING_MIN_VISIBLE_MS - 100);
    expect(remainingVisibleMs(PENDING_MIN_VISIBLE_MS + 50)).toBe(0);
  });

  it("is the same threshold the router uses for its pending skeleton", () => {
    const router = readFileSync(join(root, "src/router.tsx"), "utf8");
    expect(router).toMatch(/defaultPendingMs:\s*PENDING_SHOW_AFTER_MS/);
    expect(router).toMatch(/defaultPendingMinMs:\s*PENDING_MIN_VISIBLE_MS/);
  });
});

describe("pull to refresh and swipe to dismiss", () => {
  it("pulls one-to-one at first, then against a spring that never passes the cap", () => {
    expect(pullDistance(-20)).toBe(0);
    expect(pullDistance(0)).toBe(0);
    expect(pullDistance(10)).toBeGreaterThan(9);
    expect(pullDistance(10000)).toBeLessThanOrEqual(PULL_MAX_PX);
    // Reachable with an ordinary pull, not a full-screen drag.
    let finger = 0;
    while (pullDistance(finger) < PULL_THRESHOLD_PX) finger++;
    expect(finger).toBeLessThan(160);
  });

  it("gives a sideways drag to whatever scrolls sideways", () => {
    expect(gestureAxis(2, 3)).toBe("undecided");
    expect(gestureAxis(GESTURE_SLOP_PX + 10, 4)).toBe("horizontal");
    expect(gestureAxis(4, GESTURE_SLOP_PX + 10)).toBe("vertical");
    expect(gestureAxis(30, 30)).toBe("horizontal"); // a diagonal is not a pull
  });

  it("dismisses a sheet a third of the way down, or on a flick, and not on a twitch", () => {
    expect(shouldDismissSheet(-50, 100, 600)).toBe(false);
    expect(shouldDismissSheet(199, 2000, 600)).toBe(false);
    expect(shouldDismissSheet(200, 2000, 600)).toBe(true);
    expect(shouldDismissSheet(60, 80, 600)).toBe(true); // a flick
    expect(shouldDismissSheet(12, 5, 600)).toBe(false); // fast, but a twitch
  });
});

describe("reduced motion is honoured in the stylesheet", () => {
  const reduce = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("drops every motion token to nothing", () => {
    for (const token of [
      "--motion-duration-fast",
      "--motion-duration-base",
      "--motion-duration-slow",
    ]) {
      expect(reduce, token).toMatch(new RegExp(`${token}:\\s*1ms`));
    }
    expect(reduce).toMatch(/--motion-page-in:\s*0px/);
    expect(reduce).toMatch(/--motion-rise:\s*0px/);
    expect(reduce).toMatch(/--motion-press-scale:\s*1;/);
  });

  it("stills animations the app does not own, too", () => {
    expect(reduce).toMatch(/animation-duration:\s*1ms !important/);
    expect(reduce).toMatch(/transition-duration:\s*1ms !important/);
  });

  it("presses every button on the tokens, so reduced motion presses nothing", () => {
    const button = readFileSync(join(root, "src/components/ui/button.tsx"), "utf8");
    expect(button).toMatch(/active:scale-\(--motion-press-scale\)/);
  });
});
