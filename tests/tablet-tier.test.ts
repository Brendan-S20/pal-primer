import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Q-2, answered in v1.1 and unbuilt until now: a real tablet tier at
// 768–1024px. The app had ONE breakpoint. The bottom tab bar was `md:hidden`,
// so it vanished at exactly 768 — and a crew tablet is 768–1024. A tech on the
// tablet the whole offline cache was written for got the desktop sidebar and
// none of the tech navigation.
//
// The reason a breakpoint move was never the fix: the dispatch board renders
// from `md` up and belongs on an iPad, so widening the bar to `lg` for everyone
// puts a phone tab bar on top of a board a dispatcher is dragging visits
// across. Width was standing in for role, and it is the wrong proxy.
//
// The tab bar's reach and the main content's bottom padding are ONE decision.
// The padding was `pb-[4.5rem] md:pb-8` — it stops clearing the bar at exactly
// the point the bar used to disappear. Widen one and not the other and the bar
// covers the last row of content, which on My Day is the Complete button.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Drive the hook without a React renderer by stubbing the role it reads. */
async function tierFor(role: string | null) {
  vi.resetModules();
  vi.doMock("@/hooks/useMyRole", () => ({
    useMyRole: () => ({ role, orgId: "org", loading: false }),
  }));
  const { useTabletTier } = await import("@/hooks/useTabletTier");
  return useTabletTier();
}

describe("who keeps the tab bar through 768–1024px", () => {
  it("a tech does — this is the crew tablet Q-2 is about", async () => {
    const t = await tierFor("tech");
    expect(t.barThroughTablet).toBe(true);
    // And from lg up only with a mouse: on a touch screen of any width the
    // tech keeps the bar (QA row 35, iPad landscape at 1180 and 1366).
    expect(t.barHiddenFrom).toBe("lg:mouse:hidden");
  });

  it("an office user does not — the dispatch board is there", async () => {
    // Sequential, not Promise.all: each case re-mocks the role module and
    // re-imports the hook, so running them concurrently lets one case observe
    // another's mock. The first version of this did exactly that and failed.
    for (const role of ["owner", "office_manager", "dispatcher"]) {
      const t = await tierFor(role);
      expect(t.barThroughTablet, role).toBe(false);
      expect(t.barHiddenFrom, role).toBe("md:hidden");
    }
  });

  it("an unknown role gets the tech rule, not the office one", async () => {
    // The role arrives asynchronously and is null until it does. Showing the
    // bar to a desk user for one frame is a flicker; hiding it from a tech
    // mid-visit takes their navigation away.
    const t = await tierFor(null);
    expect(t.barThroughTablet).toBe(true);
    expect(t.barHiddenFrom).toBe("lg:mouse:hidden");
  });
});

describe("the padding clears the bar for exactly as long as the bar is there", () => {
  it("matches the visibility breakpoint in every case", async () => {
    // This is the invariant. A tab bar hidden from `lg` needs padding that
    // survives to `lg`; one hidden from `md` needs padding to `md`. Anything
    // else is content underneath a fixed bar.
    for (const role of ["tech", "owner", "office_manager", "dispatcher", null]) {
      const t = await tierFor(role);
      // Every variant on the bar's hiding class, `lg:mouse` included: padding
      // released at `lg` alone would leave the bar over the last row on an
      // iPad in landscape, where the bar now stays.
      const breakpoint = t.barHiddenFrom.replace(/:hidden$/, "");
      expect(t.mainBottomPadding, `${role}: padding must release at ${breakpoint}`).toContain(
        `${breakpoint}:pb-8`,
      );
      expect(t.mainBottomPadding, `${role}`).not.toMatch(/(^|\s)lg:pb-8/);
      // And it must actually clear the bar's height below that point.
      expect(t.mainBottomPadding, `${role}`).toContain("4.5rem");
      expect(t.mainBottomPadding, `${role}`).toContain("safe-area-inset-bottom");
    }
  });
});

describe("both consumers read the shared rule", () => {
  it("the tab bar takes its visibility class from the hook", () => {
    const src = read("src/components/MobileTabBar.tsx");
    expect(src).toMatch(/useTabletTier\(\)/);
    // A hard-coded breakpoint here is the bug returning — the bar would vanish
    // at 768 again regardless of what the hook decided.
    expect(src).toMatch(/\$\{barHiddenFrom\}/);
    // Quote-agnostic. The first version of this only matched className="…" and
    // a mutation that hard-coded md:hidden inside a TEMPLATE LITERAL passed it
    // — the very syntax the fix introduced.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code, "a literal breakpoint class is hard-coded on the bar").not.toMatch(
      /\b(md|lg):hidden\b/,
    );
  });

  it("the layout takes its padding from the same hook", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    expect(src).toMatch(/useTabletTier\(\)/);
    // Was pinned as a bare `${mainBottomPadding}`. It is now the `bottom`
    // branch of a conditional, because with the tab bar switched off that
    // padding reserves the height of a bar that is not there. The rule this
    // test exists for is unchanged — the reservation still comes from the
    // hook and is not hand-spelled — so it is the NAME that is pinned, not
    // the punctuation around it.
    expect(src).toMatch(/mainBottomPadding/);
    expect(src).not.toMatch(/pb-\[calc\(4\.5rem/);
    // The old literal must be gone, or the two disagree for tech users.
    expect(src).not.toMatch(
      /pb-\[calc\(4\.5rem\+env\(safe-area-inset-bottom\)\)\] sm:px-6 sm:pt-8 md:pb-8/,
    );
  });

  it("the dispatch board still renders from md up", () => {
    // The thing that made a blunt `lg` move wrong. If this ever flips, an
    // office user on an iPad loses the board, which is the regression the
    // tablet tier exists to avoid.
    const src = read("src/routes/_authenticated/routes.tsx");
    expect(src).toMatch(/max-md:hidden/);
  });
});
