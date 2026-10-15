// QA row 34, 2026-10-15: on an iPad in portrait (820px) the 256px office
// sidebar stayed open and left the page 564px. Client names wrapped to three
// lines, table columns were cut and the client tabs wrapped onto two rows.
//
// Below 1280px the docked sidebar is now an icon rail, and its labelled panel
// opens OVER the page from the rail's own button, the header toggle or
// Cmd/Ctrl+B, closing on a route change, Escape or a tap outside it. From
// 1280px up nothing changed. The decision is lib/sidebar-shape.ts, so the
// breakpoints are checked here as arithmetic; the browser half is
// tests/viewports/an-ipad-is-not-a-laptop.spec.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SIDEBAR_RAIL_BELOW,
  sidebarDockEdge,
  sidebarShape,
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
  o: { docksFrom?: SidebarDocksFrom; coarse?: boolean; railBelowXl?: boolean } = {},
) {
  const docksFrom = o.docksFrom ?? "md";
  return sidebarShape({
    belowDock: w < sidebarDockEdge(docksFrom),
    coarsePointer: o.coarse ?? false,
    belowRail: w < SIDEBAR_RAIL_BELOW,
    docksFrom,
    railBelowXl: o.railBelowXl ?? true,
  });
}

describe("the office sidebar's shape at each width", () => {
  it("is the rail on every iPad size an office user holds, and the column from 1280", () => {
    expect(SIDEBAR_RAIL_BELOW).toBe(1280);
    for (const coarse of [false, true]) {
      expect(shapeAt(390, { coarse })).toBe("sheet");
      expect(shapeAt(767, { coarse })).toBe("sheet");
      for (const w of [768, 820, 1024, 1180, 1279]) {
        expect(shapeAt(w, { coarse }), `${w}px, coarse=${coarse}`).toBe("rail");
      }
      for (const w of [1280, 1366, 1440, 1920]) {
        expect(shapeAt(w, { coarse }), `${w}px, coarse=${coarse}`).toBe("column");
      }
    }
  });

  it("is never docked for a tech with the tab bar on a touch screen", () => {
    for (const w of [390, 820, 1024, 1180, 1366, 1920]) {
      expect(shapeAt(w, { docksFrom: "lg-mouse", coarse: true }), `${w}px`).toBe("sheet");
    }
    // With a mouse the desk shape starts at lg, as the rail below 1280.
    expect(shapeAt(1023, { docksFrom: "lg-mouse" })).toBe("sheet");
    expect(shapeAt(1024, { docksFrom: "lg-mouse" })).toBe("rail");
    expect(shapeAt(1280, { docksFrom: "lg-mouse" })).toBe("column");
  });

  it("keeps the full column for a shell that did not ask for the rail", () => {
    // The platform console's sidebar is offcanvas: collapsing it hides it
    // entirely, so a rail there would be an empty 48px strip.
    for (const w of [820, 1024, 1180]) {
      expect(shapeAt(w, { railBelowXl: false }), `${w}px`).toBe("column");
    }
    expect(codeOnly(read("src/routes/platform.tsx"))).not.toMatch(/railBelowXl/);
    expect(codeOnly(read("src/routes/_authenticated/route.tsx"))).toMatch(
      /<SidebarProvider docksFrom=\{docksFrom\} railBelowXl>/,
    );
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

  it("toggles the overlay, not the desktop collapse, from the header button and Cmd/Ctrl+B", () => {
    expect(src).toMatch(/if \(rail\) return setRailOpen\(\(open\) => !open\);/);
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

  it("has its own expand button, labelled in the interface language, 44px on touch", () => {
    expect(src).toMatch(/aria-label=\{railOpen \? t\("nav\.collapseMenu"\) : t\("nav\.expandMenu"\)\}/);
    expect(src).toMatch(/aria-expanded=\{railOpen\}/);
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
