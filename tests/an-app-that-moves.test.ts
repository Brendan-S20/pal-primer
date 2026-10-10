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
 *
 * And, since the owner found it "disrupting the smoothness" on a real iPhone
 * (2026-10-08), the rules that keep motion from costing a thumb anything:
 *
 *   * nothing moves between tabs;
 *   * a page moves in 200ms or less, a sheet in 250ms or less;
 *   * every keyframe and every transition in the stylesheet moves only
 *     transform and opacity, and no page transitions a layout property;
 *   * a skeleton waits before it is drawn, and the router holds one for
 *     200ms at most;
 *   * a list does not animate the rows it first paints with;
 *   * pull-to-refresh only blocks scrolling while the page is at its top;
 *   * coming back to the app does not refetch data that is seconds old.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { navDirection, uaAlreadyAnimated, type NavInput } from "../src/lib/motion/direction";
import {
  PENDING_MIN_VISIBLE_MS,
  PENDING_SHOW_AFTER_MS,
  remainingVisibleMs,
  shouldShowProgress,
} from "../src/lib/motion/pending";
import { REFETCH_ON_RETURN_AFTER_MS, refetchOnReturn } from "../src/lib/query-refocus";
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
    expect(navDirection(nav({ fromPath: "/settings", toPath: "/settings/users" }))).toBe("forward");
    expect(navDirection(nav({ fromPath: "/clients/123/edit", toPath: "/clients/123" }))).toBe(
      "back",
    );
  });

  it("does not move at all between top-level sections, which is what a tab is", () => {
    // A native app changes tab in place. This was a 160ms crossfade until
    // 2026-10-08, and a view transition swallows taps while it runs.
    expect(navDirection(nav({ fromPath: "/dashboard", toPath: "/clients" }))).toBe("none");
    expect(navDirection(nav({ fromPath: "/my-day", toPath: "/waste-log" }))).toBe("none");
    // Even when the history went back: tabs have no back stack.
    expect(
      navDirection(
        nav({ fromPath: "/clients", toPath: "/dashboard", isPop: true, fromIndex: 4, toIndex: 3 }),
      ),
    ).toBe("none");
  });

  it("takes a tap on the tab bar or the sidebar as a tab switch, wherever it starts", () => {
    // On a client's page, tapping Clients in the tab bar is changing tab,
    // not going back, though the URL gets shallower.
    expect(
      navDirection(nav({ fromPath: "/clients/123", toPath: "/clients", fromNavChrome: true })),
    ).toBe("none");
    expect(
      navDirection(nav({ fromPath: "/clients/123", toPath: "/invoices", fromNavChrome: true })),
    ).toBe("none");
    // The page's own "← Clients" link is not chrome: that still slides back.
    expect(navDirection(nav({ fromPath: "/clients/123", toPath: "/clients" }))).toBe("back");
    // And the back key is a pop, whatever was tapped last.
    expect(
      navDirection(
        nav({
          fromPath: "/clients/123",
          toPath: "/clients",
          isPop: true,
          fromIndex: 3,
          toIndex: 2,
          fromNavChrome: true,
        }),
      ),
    ).toBe("back");
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
        nav({
          fromPath: "/clients/123",
          toPath: "/clients",
          isPop: true,
          fromIndex: 2,
          toIndex: 3,
        }),
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

  it("stands aside for a swipe-back the platform animated, and on iOS for every traversal", () => {
    expect(uaAlreadyAnimated(true, false)).toBe(true);
    expect(uaAlreadyAnimated(false, false)).toBe(false);
    expect(uaAlreadyAnimated(undefined, false)).toBe(false);
    // iOS: WKWebView's edge swipe (HSBridgeViewController) and Safari's
    // animate the traversal themselves, whatever the event reports.
    expect(uaAlreadyAnimated(true, true)).toBe(true);
    expect(uaAlreadyAnimated(false, true)).toBe(true);
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
  });

  it("has no tab transition left to run", () => {
    expect(css).not.toMatch(/data-nav-dir="tab"/);
  });
});

/** The value of a duration token on :root, in ms. */
const token = (name: string) => {
  const m = css.match(new RegExp(`:root\\s*\\{[^}]*${name}:\\s*(\\d+)ms`));
  if (!m) throw new Error(`${name} not found on :root`);
  return Number(m[1]);
};

describe("motion never makes a thumb wait", () => {
  it("moves a page in 200ms or less and a sheet in 250ms or less", () => {
    expect(token("--motion-duration-base")).toBeLessThanOrEqual(200);
    expect(token("--motion-duration-fast")).toBeLessThanOrEqual(200);
    expect(token("--motion-duration-slow")).toBeLessThanOrEqual(250);
    // The page slide reads the base token and nothing longer.
    const pageRule =
      css.match(
        /::view-transition-old\(hs-page\),\s*::view-transition-new\(hs-page\)\s*\{([^}]*)\}/,
      )?.[1] ?? "";
    expect(pageRule).toMatch(/animation-duration:\s*var\(--motion-duration-base\)/);
    // A sheet opens on the slow token: the longest thing in the app.
    const sheet = readFileSync(join(root, "src/components/ui/sheet.tsx"), "utf8");
    expect(sheet).toMatch(/data-\[state=open\]:duration-\(--motion-duration-slow\)/);
    // And moves by its keyframes only: no CSS transition stacked under them.
    const variants = sheet.match(/const sheetVariants = cva\(\s*"([^"]*)"/)?.[1] ?? "";
    expect(variants.split(/\s+/)).not.toContain("transition");
  });

  it("animates transform and opacity, and nothing that has to be laid out or painted", () => {
    // stroke-dashoffset is the completion check drawing its own 52px tick:
    // the one keyframe that is not transform or opacity, and it is an SVG
    // stroke on a badge with pointer-events off, not a box anything sits in.
    const allowed = new Set(["transform", "opacity", "stroke-dashoffset"]);
    const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const keyframes = [...code.matchAll(/@keyframes ([\w-]+)\s*\{([\s\S]*?)\n\}/g)];
    expect(keyframes.length).toBeGreaterThan(5);
    for (const [, name, body] of keyframes) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      for (const prop of props)
        expect(allowed.has(prop), `@keyframes ${name} animates ${prop}`).toBe(true);
    }
    // Every CSS transition the stylesheet declares names transform or
    // opacity only.
    for (const m of code.matchAll(/(?<![\w-])transition:\s*([^;]+);/g)) {
      const props = m[1]
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter((p) => p !== "none");
      for (const prop of props) {
        expect(["transform", "opacity"], `transition: ${m[1]}`).toContain(prop);
      }
    }
  });

  it("never transitions a layout property on a page", () => {
    // width, height, a side or a margin is a layout every frame; box-shadow
    // is a repaint every frame; `transition-all` is all of them at once.
    // The ui/ primitives keep theirs (the desktop sidebar's collapse, the
    // switch's 16px thumb), but a page is where a list or a meter lives.
    const pages = readdirSync(join(root, "src/routes"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".tsx"));
    const offenders: string[] = [];
    for (const f of pages) {
      const src = readFileSync(join(root, "src/routes", f), "utf8");
      src.split("\n").forEach((line, i) => {
        if (
          /\btransition-(all|shadow)\b|\btransition-\[[^\]]*\b(width|height|top|left|right|bottom|margin|padding|inset)\b/.test(
            line,
          )
        )
          offenders.push(`src/routes/${f}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("draws a skeleton only once the wait is real", () => {
    const delay = token("--skeleton-delay");
    expect(delay).toBeGreaterThanOrEqual(150);
    expect(delay).toBeLessThanOrEqual(200);
    expect(css).toMatch(
      /\.hs-skeleton\s*\{\s*animation:\s*hs-skeleton-wait 1ms linear var\(--skeleton-delay\) backwards,/,
    );
    const skeleton = readFileSync(join(root, "src/components/ui/skeleton.tsx"), "utf8");
    expect(skeleton).toMatch(/"hs-skeleton /);
    expect(skeleton).not.toMatch(/animate-pulse/);
    // The router's own pending page has waited 300ms already.
    const pages = readFileSync(join(root, "src/components/PageSkeletons.tsx"), "utf8");
    expect(pages).toMatch(/<Region immediate className="space-y-6">/);
    expect(css).toMatch(/\[data-skeleton-now\] \.hs-skeleton\s*\{\s*animation-delay:\s*0ms, 0ms;/);
    // And the router holds a pending page no longer than it has to.
    expect(PENDING_MIN_VISIBLE_MS).toBeLessThanOrEqual(200);
  });

  it("does not animate the rows a list first paints with", () => {
    expect(css).toMatch(
      /@utility motion-list \{\s*&\[data-motion-armed\] > :not\(\[data-motion-seen\]\):nth-child\(-n \+ 12\)/,
    );
    expect(css).not.toMatch(/--motion-stagger/);
    // Every list that carries the class carries the hook's ref, or the class
    // does nothing (the safe way round, but then it is dead code).
    const files = readdirSync(join(root, "src"), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith(".tsx"));
    let lists = 0;
    for (const f of files) {
      const src = readFileSync(join(root, "src", f), "utf8");
      for (const m of src.matchAll(/<\w+([^>]*)className="motion-list[^"]*"/g)) {
        lists++;
        expect(m[1], `${f}: a motion-list without useMotionList's ref`).toMatch(/ref=\{/);
        expect(src, f).toMatch(/useMotionList/);
      }
    }
    expect(lists).toBeGreaterThanOrEqual(5);
  });

  it("only blocks scrolling for a pull while the page is at its top", () => {
    const ptr = readFileSync(join(root, "src/components/motion/PullToRefresh.tsx"), "utf8");
    const adds = [...ptr.matchAll(/addEventListener\("touchmove"/g)];
    expect(adds).toHaveLength(1);
    const setBlocking = ptr.slice(ptr.indexOf("const setBlocking"), ptr.indexOf("const onScroll"));
    expect(setBlocking).toMatch(/addEventListener\("touchmove", onMove, \{ passive: false \}\)/);
  });
});

describe("coming back to the app", () => {
  it("refetches what is older than 30 seconds, and nothing younger", () => {
    expect(REFETCH_ON_RETURN_AFTER_MS).toBe(30_000);
    const now = 1_000_000;
    expect(refetchOnReturn({ state: { dataUpdatedAt: now - 5_000 } }, now)).toBe(false);
    expect(refetchOnReturn({ state: { dataUpdatedAt: now - 29_999 } }, now)).toBe(false);
    expect(refetchOnReturn({ state: { dataUpdatedAt: now - 30_000 } }, now)).toBe(true);
    // Never fetched: fetch.
    expect(refetchOnReturn({ state: { dataUpdatedAt: 0 } }, now)).toBe(true);
    const router = readFileSync(join(root, "src/router.tsx"), "utf8");
    expect(router).toMatch(/refetchOnWindowFocus: \(query\) => refetchOnReturn\(query\)/);
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
