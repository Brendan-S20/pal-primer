// QA row 35, 2026-10-15: "On an iPad a tech gets the office sidebar." The
// tech tab bar reached `lg` and stopped, so an iPad in landscape (1180 or
// 1366px) gave a technician a column of office destinations they cannot
// open instead of the four tabs they use on the phone in the same hand.
//
// For a field role the bar is now hidden from `lg` only with a mouse
// (`lg:mouse:hidden`), so on a touch screen it stays at every width, and
// everything that has to agree with the bar says the same thing with a
// `touch:` twin of its `max-lg:` class. The width-by-input arithmetic is in
// tests/two-navigations-at-768.test.ts; the browser half is
// tests/viewports/an-ipad-is-not-a-laptop.spec.ts.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

async function tierFor(role: string | null) {
  vi.resetModules();
  vi.doMock("@/hooks/useMyRole", () => ({
    useMyRole: () => ({ role, orgId: "org", loading: false }),
  }));
  const { useTabletTier } = await import("@/hooks/useTabletTier");
  return useTabletTier();
}

describe("the tech's tab bar on a touch screen", () => {
  it("is hidden from lg only with a mouse, and the padding under it agrees", async () => {
    const t = await tierFor("tech");
    expect(t.barHiddenFrom).toBe("lg:mouse:hidden");
    expect(t.mainBottomPadding).toContain("lg:mouse:pb-8");
    expect(t.mainBottomPadding).not.toMatch(/(^|\s)lg:pb-8/);
  });

  it("changes nothing for an office role: the iPad keeps the board and the rail", async () => {
    for (const role of ["owner", "office_manager", "dispatcher"]) {
      const t = await tierFor(role);
      expect(t.barHiddenFrom, role).toBe("md:hidden");
    }
  });

  it("hides the shell header, the account avatar and the menu toggle wherever the bar is", () => {
    const src = codeOnly(read("src/routes/_authenticated/route.tsx"));
    for (const name of ["myDayHeaderHidden", "accountMenuHidden", "phoneOnlyHidden"]) {
      expect(src, name).toMatch(
        new RegExp(`const ${name} = barThroughTablet \\? "max-lg:hidden touch:hidden" : "max-md:hidden"`),
      );
    }
    expect(src).toMatch(/"max-lg:pt-\[env\(safe-area-inset-top\)\] touch:pt-\[env\(safe-area-inset-top\)\]"/);
    // The native status-bar strip is drawn exactly where the header is not.
    expect(src).toMatch(/barThroughTablet \? "lg:mouse:hidden" : "md:hidden"/);
    expect(src).not.toMatch(/barThroughTablet \? "lg:hidden"/);
  });

  it("keeps My Day's NEXT UP bar and list padding on top of the bar, iPad landscape included", () => {
    const src = codeOnly(read("src/routes/_authenticated/my-day.tsx"));
    expect(src).toContain(
      "touch:bottom-[calc(var(--tab-bar-h)+env(safe-area-inset-bottom))] touch:pb-0",
    );
    expect(src).toContain("touch:pb-[calc(7rem+var(--tab-bar-h)+env(safe-area-inset-bottom))]");
  });

  it("is the bar the phone has: the same component, the same four tabs", () => {
    // No second tablet bar to drift from the phone's.
    const bar = read("src/components/MobileTabBar.tsx");
    expect(bar).toMatch(/const \{ barHiddenFrom \} = useTabletTier\(\);/);
    expect(bar).toMatch(/<ul className="grid h-full grid-cols-4">/);
  });
});
