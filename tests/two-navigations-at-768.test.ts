// From the product review of 2026-09-27, at 768px: the sidebar and the
// bottom tab bar, both on screen at once.
//
// The tablet tier (tests/tablet-tier.test.ts) moved the tab bar's edge from
// `md` to `lg` for a technician, so a tech on a crew tablet keeps the tech
// navigation. Nothing moved the sidebar's edge. It docks from ui/sidebar.tsx's
// own 768 — once in `useIsMobile`, which picks sheet-or-docked in JS, and
// again in `md:block` / `md:flex`, which shows the docked column in CSS — so
// from 768 to 1023 a tech had the docked office sidebar AND the tab bar.
//
// The fix gives the sidebar a `docksFrom` that the layout sets from the same
// tier, through `sidebarDocksFrom`, and has both halves of ui/sidebar.tsx read
// it. The invariant below is the one the reviewer asked for, checked at the
// widths either side of each edge: never both, and wherever the tab bar is in
// play, exactly one.

import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { TabletTier } from "@/hooks/useTabletTier";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

/** Drive the hook without a React renderer, the way tablet-tier.test.ts does. */
async function load(role: string | null) {
  vi.resetModules();
  vi.doMock("@/hooks/useMyRole", () => ({
    useMyRole: () => ({ role, orgId: "org", loading: false }),
  }));
  const mod = await import("@/hooks/useTabletTier");
  return { tier: mod.useTabletTier(), sidebarDocksFrom: mod.sidebarDocksFrom };
}

/** Tailwind's two breakpoints in play, in px. */
const PX = { md: 768, lg: 1024 } as const;
// 820, 1180 and 1366 are iPad portrait and landscape (QA rows 34 and 35).
const WIDTHS = [320, 360, 767, 768, 800, 820, 1023, 1024, 1180, 1280, 1366, 1920];

/** What the CSS classes say, as a function of width and primary pointer.
 *  `lg:mouse:hidden` hides from lg only when the pointer is fine. */
function hiddenAt(cls: string, w: number, pointer: "mouse" | "touch"): boolean {
  const [bp, ...rest] = cls.split(":");
  const fromBp = w >= PX[bp as "md" | "lg"];
  return rest[0] === "mouse" ? fromBp && pointer === "mouse" : fromBp;
}
function dockedAt(docksFrom: "md" | "lg-mouse", w: number, pointer: "mouse" | "touch"): boolean {
  return docksFrom === "lg-mouse" ? w >= PX.lg && pointer === "mouse" : w >= PX.md;
}

describe("the sidebar docks where the tab bar stops", () => {
  it("never both, and exactly one wherever the bar renders, with a mouse or a finger", async () => {
    for (const role of ["tech", "owner", "office_manager", "dispatcher", null]) {
      for (const phoneNav of ["bottom", "side"] as const) {
        const { tier, sidebarDocksFrom } = await load(role);
        // The same two conditions MobileTabBar and the layout apply.
        const barRendered = !!role && phoneNav === "bottom";
        const docksFrom = sidebarDocksFrom(tier, barRendered);
        for (const pointer of ["mouse", "touch"] as const) {
          for (const w of WIDTHS) {
            const bar = barRendered && !hiddenAt(tier.barHiddenFrom, w, pointer);
            const docked = dockedAt(docksFrom, w, pointer);
            const where = `${role} / ${phoneNav} / ${pointer} @${w}px`;
            expect(bar && docked, `${where}: sidebar and tab bar together`).toBe(false);
            if (barRendered) expect(bar || docked, `${where}: no navigation`).toBe(true);
          }
        }
      }
    }
  });

  it("a tech on a touch screen keeps the tab bar at every width (QA row 35)", async () => {
    const { tier, sidebarDocksFrom } = await load("tech");
    const docksFrom = sidebarDocksFrom(tier, true);
    for (const w of WIDTHS) {
      expect(hiddenAt(tier.barHiddenFrom, w, "touch"), `tab bar @${w}px`).toBe(false);
      expect(dockedAt(docksFrom, w, "touch"), `office sidebar @${w}px`).toBe(false);
    }
    // With a mouse, a laptop, the desk shape still starts at lg.
    expect(hiddenAt(tier.barHiddenFrom, 1024, "mouse")).toBe(true);
    expect(dockedAt(docksFrom, 1024, "mouse")).toBe(true);
  });

  it("an office user on an iPad keeps the docked sidebar, not the tab bar", async () => {
    for (const role of ["owner", "office_manager", "dispatcher"]) {
      const { tier, sidebarDocksFrom } = await load(role);
      for (const w of [820, 1024, 1180, 1366]) {
        expect(hiddenAt(tier.barHiddenFrom, w, "touch"), `${role} @${w}`).toBe(true);
        expect(dockedAt(sidebarDocksFrom(tier, true), w, "touch"), `${role} @${w}`).toBe(true);
      }
    }
  });

  it("is lg-mouse for a tech with the tab bar, which is the case that was reported", async () => {
    const { tier, sidebarDocksFrom } = await load("tech");
    expect(sidebarDocksFrom(tier, true)).toBe("lg-mouse");
  });

  it("stays md for everyone else, so the dispatch board keeps its sidebar", async () => {
    for (const role of ["owner", "office_manager", "dispatcher"]) {
      const { tier, sidebarDocksFrom } = await load(role);
      expect(sidebarDocksFrom(tier, true), role).toBe("md");
    }
  });

  it("stays md whenever the bar is not rendered — the sidebar is then the only navigation", async () => {
    // A null role takes the tech tier (tablet-tier.test.ts says why), but
    // MobileTabBar draws nothing for it. Docking from lg there would leave
    // 768–1023 with no navigation at all while the role loads.
    const { tier, sidebarDocksFrom } = await load(null);
    expect(tier.barHiddenFrom).toBe("lg:mouse:hidden");
    expect(sidebarDocksFrom(tier, false)).toBe("md");
    const tech = await load("tech");
    expect(tech.sidebarDocksFrom(tech.tier, false)).toBe("md");
  });

  it("is a pure function of the tier's own edge", () => {
    // Not of the role: if the tier ever changes its mind about who keeps the
    // bar, the sidebar follows without anyone remembering it exists.
    const tier = (edge: TabletTier["barHiddenFrom"]): TabletTier => ({
      barThroughTablet: edge === "lg:mouse:hidden",
      barHiddenFrom: edge,
      mainBottomPadding: "",
    });
    return import("@/hooks/useTabletTier").then(({ sidebarDocksFrom }) => {
      expect(sidebarDocksFrom(tier("lg:mouse:hidden"), true)).toBe("lg-mouse");
      expect(sidebarDocksFrom(tier("md:hidden"), true)).toBe("md");
    });
  });
});

describe("both halves of ui/sidebar.tsx read the same edge", () => {
  const src = codeOnly(read("src/components/ui/sidebar.tsx"));

  it("the JS that picks sheet-or-docked", () => {
    expect(src).toMatch(/useIsMobile\(docksFrom === "lg-mouse" \? 1024 : 768\)/);
    expect(src).not.toMatch(/useIsMobile\(\)/);
    // ...and the input half of `lg:mouse:`: a coarse pointer never docks it.
    // The decision itself is lib/sidebar-shape.ts, tested in
    // tests/a-sidebar-that-took-a-third-of-an-ipad.test.ts.
    expect(src).toMatch(/useMediaMatch\("\(pointer: coarse\)"\)/);
    expect(src).toMatch(
      /sidebarShape\(\{ belowDock, coarsePointer, belowRail, docksFrom, railBelowLg \}\)/,
    );
  });

  it("the CSS that shows the docked column, in both places it is spelled", () => {
    // The gap element and the fixed column each carried `md:`. A literal
    // `md:block` or `md:flex` left in either is the sidebar docking at 768
    // whatever the layout asked for.
    expect(src).toMatch(/docksFrom === "lg-mouse" \? "lg:mouse:block" : "md:block"/);
    expect(src).toMatch(/docksFrom === "lg-mouse" \? "lg:mouse:flex" : "md:flex"/);
    expect(src).not.toMatch(/text-sidebar-foreground md:block/);
    expect(src).not.toMatch(/ease-linear md:flex/);
  });

  it("useIsMobile answers below N exactly where the CSS says from N", () => {
    // `max-width: N-1` and `innerWidth < N` agree with Tailwind's
    // `width >= N` at every integer width. `max-width: N` would put 768 on
    // both sides.
    const hook = codeOnly(read("src/hooks/use-mobile.tsx"));
    expect(hook).toMatch(/\(max-width: \$\{breakpoint - 1\}px\)/);
    expect(hook).toMatch(/window\.innerWidth < breakpoint/);
  });
});

describe("the consumers pass it on", () => {
  it("the layout sets docksFrom from the tier and the bar's own render condition", () => {
    const src = codeOnly(read("src/routes/_authenticated/route.tsx"));
    expect(src).toMatch(
      /sidebarDocksFrom\(\s*tier,\s*!!role && headerPrefs\.phoneNav === "bottom",?\s*\)/,
    );
    expect(src).toMatch(/<SidebarProvider docksFrom=\{docksFrom\} railBelowLg rememberExpanded>/);
    // The render condition it copies. If this one changes, that one has to.
    expect(src).toMatch(/\{headerPrefs\.phoneNav === "bottom" && <MobileTabBar \/>\}/);
    expect(read("src/components/MobileTabBar.tsx")).toMatch(/if \(!role\) return null;/);
  });

  it("My Day's NEXT UP bar clears the sidebar from where it docks, not from md", () => {
    // It is fixed to the viewport and starts at the sidebar's width. Left at
    // `md:`, it would start 256px in on a crew tablet beside no sidebar.
    // `start-`, not `left-`: in Arabic the sidebar docks on the right.
    const src = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    // And from the width it actually takes, which on the icon rail below
    // 1024px or a collapsed column is the icons' (QA row 34, #499), not the
    // full 16rem.
    expect(src).toMatch(/const \{ docksFrom \} = useSidebar\(\);/);
    expect(src).toMatch(
      /docksFrom === "lg-mouse"\s*\?\s*"lg:mouse:start-\(--sidebar-docked-width\)"\s*:\s*"md:start-\(--sidebar-docked-width\)"/,
    );
    expect(src).not.toMatch(/animate-fade-in md:(left|start)-\(--sidebar-width\)/);
  });
});
