// QA row 34, 2026-10-15: on an iPad in portrait (820px) the 256px office
// sidebar stayed open and left the page 564px. Client names wrapped to three
// lines, table columns were cut and the client tabs wrapped onto two rows.
//
// Below 1024px the docked sidebar is an icon rail, and its labelled panel
// opens OVER the page from the rail's own button, the header toggle or
// Cmd/Ctrl+B, closing on a route change, Escape or a tap outside it.
//
// #499, 2026-10-17: the rail used to run to 1280, so an iPad in landscape
// (1032, 1180, 1366 wide) always loaded the rail, an expanded panel lasted
// until the next route change, and the `sidebar_state` cookie was written
// on every toggle and read by nothing. From 1024 the sidebar is now the
// column, its toggle switches it between the icons and the labels beside
// the page, and the choice is kept on the device. With no choice yet it is
// expanded from 1180 and the icons below.
//
// The decision is lib/sidebar-shape.ts, so the breakpoints are checked here
// as arithmetic; the browser half is
// tests/viewports/an-ipad-is-not-a-laptop.spec.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIDEBAR_EXPANDED_FROM,
  SIDEBAR_EXPANDED_KEY,
  SIDEBAR_RAIL_BELOW,
  readSidebarExpanded,
  sidebarDockEdge,
  sidebarExpanded,
  sidebarShape,
  writeSidebarExpanded,
  type SidebarDocksFrom,
} from "@/lib/sidebar-shape";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*");
    })
    .join("\n");

/** The shape at a width, the way the provider's media queries answer it. */
function shapeAt(
  w: number,
  o: { docksFrom?: SidebarDocksFrom; coarse?: boolean; railBelowLg?: boolean } = {},
) {
  const docksFrom = o.docksFrom ?? "md";
  return sidebarShape({
    belowDock: w < sidebarDockEdge(docksFrom),
    coarsePointer: o.coarse ?? false,
    belowRail: w < SIDEBAR_RAIL_BELOW,
    docksFrom,
    railBelowLg: o.railBelowLg ?? true,
  });
}

/** What the office shell draws at a width: the shape, and for the column
 *  whether it is expanded. */
function officeSidebarAt(w: number, saved: boolean | null, coarse: boolean) {
  const shape = shapeAt(w, { coarse });
  if (shape !== "column") return shape;
  return sidebarExpanded({ saved, belowExpandedDefault: w < SIDEBAR_EXPANDED_FROM })
    ? "column expanded"
    : "column collapsed";
}

describe("the office sidebar's shape at each width", () => {
  it("is the sheet on a phone, the rail on an iPad in portrait, and the column from 1024", () => {
    expect(SIDEBAR_RAIL_BELOW).toBe(1024);
    for (const coarse of [false, true]) {
      expect(shapeAt(390, { coarse })).toBe("sheet");
      expect(shapeAt(767, { coarse })).toBe("sheet");
      for (const w of [768, 820, 1000, 1023]) {
        expect(shapeAt(w, { coarse }), `${w}px, coarse=${coarse}`).toBe("rail");
      }
      for (const w of [1024, 1032, 1180, 1279, 1280, 1366, 1440, 1920]) {
        expect(shapeAt(w, { coarse }), `${w}px, coarse=${coarse}`).toBe("column");
      }
    }
  });

  it("is never docked for a tech with the tab bar on a touch screen", () => {
    // The one place the pointer still decides: `lg-mouse` is only ever the
    // tech whose navigation is the bottom tab bar (useTabletTier), and the
    // tab bar stays on every touch screen. The office shell docks from md.
    for (const w of [390, 820, 1024, 1180, 1366, 1920]) {
      expect(shapeAt(w, { docksFrom: "lg-mouse", coarse: true }), `${w}px`).toBe("sheet");
    }
    // With a mouse the desk shape starts at lg, as the column.
    expect(shapeAt(1023, { docksFrom: "lg-mouse" })).toBe("sheet");
    expect(shapeAt(1024, { docksFrom: "lg-mouse" })).toBe("column");
    expect(shapeAt(1280, { docksFrom: "lg-mouse" })).toBe("column");
  });

  it("keeps the full column for a shell that did not ask for the rail", () => {
    // The platform console's sidebar is offcanvas: collapsing it hides it
    // entirely, so a rail there would be an empty 48px strip.
    for (const w of [820, 1024, 1180]) {
      expect(shapeAt(w, { railBelowLg: false }), `${w}px`).toBe("column");
    }
    const platform = codeOnly(read("src/routes/platform.tsx"));
    expect(platform).not.toMatch(/railBelowLg/);
    expect(platform).not.toMatch(/rememberExpanded/);
    expect(codeOnly(read("src/routes/_authenticated/route.tsx"))).toMatch(
      /<SidebarProvider docksFrom=\{docksFrom\} railBelowLg rememberExpanded>/,
    );
  });
});

describe("the column remembers whether it is expanded (#499)", () => {
  const WIDTHS = [1024, 1032, 1180, 1279, 1366];

  it("a saved choice wins at every docked width, with a mouse or a finger", () => {
    for (const coarse of [false, true]) {
      for (const w of WIDTHS) {
        expect(officeSidebarAt(w, true, coarse), `${w}px expanded, coarse=${coarse}`).toBe(
          "column expanded",
        );
        expect(officeSidebarAt(w, false, coarse), `${w}px collapsed, coarse=${coarse}`).toBe(
          "column collapsed",
        );
      }
    }
  });

  it("with no choice yet, expanded from 1180 and the icons below it", () => {
    expect(SIDEBAR_EXPANDED_FROM).toBe(1180);
    for (const coarse of [false, true]) {
      expect(officeSidebarAt(1024, null, coarse)).toBe("column collapsed");
      expect(officeSidebarAt(1032, null, coarse)).toBe("column collapsed");
      expect(officeSidebarAt(1179, null, coarse)).toBe("column collapsed");
      expect(officeSidebarAt(1180, null, coarse)).toBe("column expanded");
      expect(officeSidebarAt(1279, null, coarse)).toBe("column expanded");
      expect(officeSidebarAt(1366, null, coarse)).toBe("column expanded");
    }
  });

  it("gates on width, not on the pointer: touch and mouse give the same answer", () => {
    for (const saved of [true, false, null]) {
      for (const w of [390, 767, 768, 820, 1023, ...WIDTHS, 1920]) {
        expect(officeSidebarAt(w, saved, true), `${w}px saved=${saved}`).toBe(
          officeSidebarAt(w, saved, false),
        );
      }
    }
  });

  it("does not reach the phone sheet or the rail's overlay", () => {
    for (const saved of [true, false, null]) {
      expect(officeSidebarAt(390, saved, true)).toBe("sheet");
      expect(officeSidebarAt(767, saved, false)).toBe("sheet");
      expect(officeSidebarAt(820, saved, true)).toBe("rail");
    }
  });
});

describe("the choice is kept on the device", () => {
  /** A Storage with only the two methods the helper uses. */
  function memoryStore(initial: Record<string, string> = {}) {
    const data = new Map(Object.entries(initial));
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  }
  const throwing = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };

  it("under its own key, which the sign-out sweep does not touch", () => {
    expect(SIDEBAR_EXPANDED_KEY).toBe("hs.sidebar.expanded");
    // clearPersistedReadCaches removes keys with this prefix and no others.
    expect(read("src/lib/offline/read-cache-policy.ts")).toMatch(
      /READ_CACHE_KEY_PREFIX = "hs:offline-reads:"/,
    );
    expect(SIDEBAR_EXPANDED_KEY.startsWith("hs:offline-reads:")).toBe(false);
    // And nothing in the app clears the whole store.
    expect(codeOnly(read("src/lib/offline/read-cache.ts"))).not.toMatch(/localStorage\.clear\(/);
  });

  it("writes 1 and 0 and reads them back", () => {
    const store = memoryStore();
    expect(readSidebarExpanded(store)).toBeNull();
    writeSidebarExpanded(true, store);
    expect(store.data.get(SIDEBAR_EXPANDED_KEY)).toBe("1");
    expect(readSidebarExpanded(store)).toBe(true);
    writeSidebarExpanded(false, store);
    expect(store.data.get(SIDEBAR_EXPANDED_KEY)).toBe("0");
    expect(readSidebarExpanded(store)).toBe(false);
  });

  it("reads anything else as no choice", () => {
    for (const bad of ["", "true", "false", "yes", "2", " 1", "null"]) {
      expect(readSidebarExpanded(memoryStore({ [SIDEBAR_EXPANDED_KEY]: bad })), bad).toBeNull();
    }
  });

  it("survives a store that throws or is not there", () => {
    expect(readSidebarExpanded(throwing)).toBeNull();
    expect(() => writeSidebarExpanded(true, throwing)).not.toThrow();
    expect(readSidebarExpanded(null)).toBeNull();
    expect(() => writeSidebarExpanded(false, null)).not.toThrow();
  });
});

describe("ui/sidebar.tsx draws the rail and its overlay", () => {
  const src = codeOnly(read("src/components/ui/sidebar.tsx"));

  it("reads the shape from the one function, before paint", () => {
    expect(src).toMatch(/useMediaMatch\(`\(max-width: \$\{SIDEBAR_RAIL_BELOW - 1\}px\)`\)/);
    expect(src).toMatch(/const rail = shape === "rail";/);
    // useLayoutEffect in the browser, so an iPad never paints the 256px
    // column for one frame and then snaps to the rail.
    expect(src).toMatch(/typeof window === "undefined" \? React\.useEffect : React\.useLayoutEffect/);
  });

  it("is collapsed unless its overlay is open, and the page keeps its width either way", () => {
    expect(src).toMatch(/const state = \(rail \? railOpen : open\) \? "expanded" : "collapsed";/);
    // The gap beside the page is the rail's width on the rail, open or not.
    expect(src).toMatch(/rail\s*\?\s*"w-\(--sidebar-width-icon\)"/);
    // The open panel is above the header (z-30) and the bottom bars (z-40).
    expect(src).toMatch(/rail && railOpen && "z-\[45\] shadow-xl"/);
  });

  it("closes on Escape and on a tap outside it", () => {
    expect(src).toMatch(/if \(event\.key === "Escape"\) setRailOpen\(false\);/);
    expect(src).toMatch(
      /data-sidebar="rail-backdrop"\s+onClick=\{\(\) => setRailOpen\(false\)\}/,
    );
  });

  it("toggles the overlay on the rail, and the column everywhere else it docks", () => {
    expect(src).toMatch(/if \(rail\) return setRailOpen\(\(open\) => !open\);/);
    expect(src).toMatch(/return setOpen\(\(open\) => !open\);/);
  });

  it("reads the kept choice in its first render and writes it on every toggle", () => {
    expect(src).toMatch(/rememberExpanded \? readSidebarExpanded\(\) : null/);
    expect(src).toMatch(/sidebarExpanded\(\{ saved: savedExpanded, belowExpandedDefault \}\)/);
    expect(src).toMatch(/useMediaMatch\(`\(max-width: \$\{SIDEBAR_EXPANDED_FROM - 1\}px\)`\)/);
    expect(src).toMatch(/if \(rememberExpanded\) writeSidebarExpanded\(openState\);/);
    // The cookie is still written, for a year now rather than a week.
    expect(src).toMatch(/const SIDEBAR_COOKIE_MAX_AGE = 60 \* 60 \* 24 \* 365;/);
  });

  it("gives each rail icon a 44px target on a touch screen, inside a rail wide enough for it", () => {
    expect(src).toMatch(/touch:group-data-\[collapsible=icon\]:!size-11/);
    expect(src).toMatch(/\[--sidebar-width-icon:3rem\] touch:\[--sidebar-width-icon:3\.75rem\]/);
    // 3.75rem is 60px: a 44px button plus SidebarGroup's 8px each side.
    expect(3.75 * 16).toBeGreaterThanOrEqual(44 + 2 * 8);
    // And the rail scrolls: twenty-odd 44px icons are taller than an iPad
    // in landscape.
    expect(src).not.toMatch(/group-data-\[collapsible=icon\]:overflow-hidden/);
  });
});

describe("AppSidebar on the rail", () => {
  const src = codeOnly(read("src/components/AppSidebar.tsx"));

  it("closes the overlay on every route change", () => {
    expect(src).toMatch(/useEffect\(\(\) => \{\s*if \(isMobile\) setOpenMobile\(false\);\s*setRailOpen\(false\);/);
  });

  it("has its own toggle wherever it docks, labelled in the interface language, 44px on touch", () => {
    expect(src).toMatch(/\{!isMobile && \(\s*<button/);
    expect(src).toMatch(/onClick=\{toggleSidebar\}/);
    expect(src).toMatch(
      /aria-label=\{collapsed \? t\("nav\.expandMenu"\) : t\("nav\.collapseMenu"\)\}/,
    );
    expect(src).toMatch(/aria-expanded=\{!collapsed\}/);
    expect(src).toMatch(/data-sidebar="rail-toggle"[\s\S]{0,400}touch:h-11 touch:w-11/);
  });

  it("names every icon-only entry, because a tooltip is not a name", () => {
    expect(src).toMatch(/aria-label=\{collapsed \? navItemTitle\(t, item\) : undefined\}/);
    expect(src).toMatch(/aria-label=\{collapsed \? t\("nav\.yourAccount"\) : undefined\}/);
    // The tooltips stay, for a mouse.
    expect(src).toMatch(/tooltip=\{/);
  });
});

describe("My Day's NEXT UP bar starts at the rail, not 16rem in", () => {
  it("reads the docked width the provider publishes", () => {
    const sidebar = codeOnly(read("src/components/ui/sidebar.tsx"));
    expect(sidebar).toMatch(/"--sidebar-docked-width": dockedWidth/);
    expect(sidebar).toMatch(
      /rail \|\| state === "collapsed" \? "var\(--sidebar-width-icon\)" : "var\(--sidebar-width\)"/,
    );
    const myDay = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(myDay).not.toMatch(/start-\(--sidebar-width\)/);
    expect(myDay).toMatch(/md:start-\(--sidebar-docked-width\)/);
  });
});
