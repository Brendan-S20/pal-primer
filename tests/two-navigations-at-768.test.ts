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
const WIDTHS = [320, 360, 767, 768, 800, 1023, 1024, 1280, 1920];

describe("the sidebar docks where the tab bar stops", () => {
  it("never both, and exactly one wherever the bar renders", async () => {
    for (const role of ["tech", "owner", "office_manager", "dispatcher", null]) {
      for (const phoneNav of ["bottom", "side"] as const) {
        const { tier, sidebarDocksFrom } = await load(role);
        // The same two conditions MobileTabBar and the layout apply.
        const barRendered = !!role && phoneNav === "bottom";
        const docksFrom = sidebarDocksFrom(tier, barRendered);
        const barEdge = PX[tier.barHiddenFrom.split(":")[0] as "md" | "lg"];
        for (const w of WIDTHS) {
          const bar = barRendered && w < barEdge;
          const docked = w >= PX[docksFrom];
          const where = `${role} / ${phoneNav} @${w}px`;
          expect(bar && docked, `${where}: sidebar and tab bar together`).toBe(false);
          if (barRendered) expect(bar || docked, `${where}: no navigation`).toBe(true);
        }
      }
    }
  });

  it("is lg for a tech with the tab bar, which is the case that was reported", async () => {
    const { tier, sidebarDocksFrom } = await load("tech");
    expect(sidebarDocksFrom(tier, true)).toBe("lg");
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
    expect(tier.barHiddenFrom).toBe("lg:hidden");
    expect(sidebarDocksFrom(tier, false)).toBe("md");
    const tech = await load("tech");
    expect(tech.sidebarDocksFrom(tech.tier, false)).toBe("md");
  });

  it("is a pure function of the tier's own edge", () => {
    // Not of the role: if the tier ever changes its mind about who keeps the
    // bar, the sidebar follows without anyone remembering it exists.
    const tier = (edge: TabletTier["barHiddenFrom"]): TabletTier => ({
      barThroughTablet: edge === "lg:hidden",
      barHiddenFrom: edge,
      mainBottomPadding: "",
    });
    return import("@/hooks/useTabletTier").then(({ sidebarDocksFrom }) => {
      expect(sidebarDocksFrom(tier("lg:hidden"), true)).toBe("lg");
      expect(sidebarDocksFrom(tier("md:hidden"), true)).toBe("md");
    });
  });
});

describe("both halves of ui/sidebar.tsx read the same edge", () => {
  const src = codeOnly(read("src/components/ui/sidebar.tsx"));

  it("the JS that picks sheet-or-docked", () => {
    expect(src).toMatch(/useIsMobile\(docksFrom === "lg" \? 1024 : 768\)/);
    expect(src).not.toMatch(/useIsMobile\(\)/);
  });

  it("the CSS that shows the docked column, in both places it is spelled", () => {
    // The gap element and the fixed column each carried `md:`. A literal
    // `md:block` or `md:flex` left in either is the sidebar docking at 768
    // whatever the layout asked for.
    expect(src).toMatch(/docksFrom === "lg" \? "lg:block" : "md:block"/);
    expect(src).toMatch(/docksFrom === "lg" \? "lg:flex" : "md:flex"/);
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
    expect(src).toMatch(/<SidebarProvider docksFrom=\{docksFrom\}>/);
    // The render condition it copies. If this one changes, that one has to.
    expect(src).toMatch(/\{headerPrefs\.phoneNav === "bottom" && <MobileTabBar \/>\}/);
    expect(read("src/components/MobileTabBar.tsx")).toMatch(/if \(!role\) return null;/);
  });

  it("My Day's NEXT UP bar clears the sidebar from where it docks, not from md", () => {
    // It is fixed to the viewport and starts at the sidebar's width. Left at
    // `md:`, it would start 256px in on a crew tablet beside no sidebar.
    // `start-`, not `left-`: in Arabic the sidebar docks on the right.
    const src = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(src).toMatch(/const \{ docksFrom \} = useSidebar\(\);/);
    expect(src).toMatch(
      /docksFrom === "lg" \? "lg:start-\(--sidebar-width\)" : "md:start-\(--sidebar-width\)"/,
    );
    expect(src).not.toMatch(/animate-fade-in md:(left|start)-\(--sidebar-width\)/);
  });
});
