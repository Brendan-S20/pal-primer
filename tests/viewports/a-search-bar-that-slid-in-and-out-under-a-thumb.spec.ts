/**
 * A technician's chrome should not change shape as they move between their own
 * four tabs.
 *
 * The shell header — 56px with a "Search or jump to…" field in it — was hidden
 * on My Day and nowhere else. So Today had no bar, Waste log grew one, Alerts
 * grew one, and flicking between them slid it in and out from under the user's
 * thumb. Reported as: "I am not a fan how the layout changes as a technician
 * when you flick between views, such as waste log, and canvassing, it pops-up
 * the search bar, that's not necessary."
 *
 * ── WHY HIDING IT IS SAFE FOR A TECH AND NOT FOR AN OFFICE ROLE ───────────
 *
 * Everything the header offers a tech is already in the tab bar: Alerts is the
 * bell, More is the sidebar, and the sidebar trigger is hidden anyway when the
 * phone is on bottom navigation. What is left is the command palette, a
 * keyboard affordance on a device with no keyboard.
 *
 * An office role has eleven destinations and reaches a client by typing their
 * name, so they keep it everywhere. That asymmetry is the thing most likely to
 * be "simplified" away later by someone reading only the tech half, which is
 * why both halves are asserted here rather than just the one that changed.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

/** The tech tab bar's three page destinations, plus canvassing, which the
 *  report named and which a tech reaches from More. */
const TECH_ROUTES = ["/my-day", "/waste-log", "/notifications", "/neighbors"];

async function signInAs(page: Page, role: SweepRole) {
  await installSignedInSession(page);
  await installStubBackend(page, { role });
}

/** Is the shell's search field on screen? Found by its own copy — it is the
 *  control the report named. */
const searchVisible = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll("button")].find((b) =>
      (b.textContent || "").includes("Search or jump to"),
    ) as HTMLElement | undefined;
    // offsetParent is null for a `display:none` ancestor, which is what
    // `max-md:hidden` compiles to. A zero-size rect would not catch it.
    return !!el && el.offsetParent !== null;
  });

test.describe("a technician's chrome does not change shape between tabs", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 2 });

  test("the search bar is absent on every tech destination, not just My Day", async ({ page }) => {
    await signInAs(page, "tech");

    const seen: Array<{ route: string; search: boolean }> = [];
    for (const route of TECH_ROUTES) {
      await page.goto(route, { waitUntil: "domcontentloaded" });
      // Proves the page rendered before anything is measured — "no search bar"
      // is trivially true of a blank page, which is how this test would lie.
      await expect(page.locator("body")).toBeVisible({ timeout: FIRST_PAINT_MS });
      await page.waitForLoadState("networkidle").catch(() => {});
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      seen.push({ route, search: await searchVisible(page) });
    }

    const withBar = seen.filter((s) => s.search).map((s) => s.route);
    expect(
      withBar,
      `the search bar appears on ${withBar.join(", ")} but not on the rest — that is ` +
        "the bar sliding in and out as a technician moves between tabs",
    ).toEqual([]);
  });

  test("an office role keeps the search bar", async ({ page }) => {
    // The other half. A rule that hid this for everyone would pass the test
    // above and quietly take search away from the people who navigate by it.
    await signInAs(page, "office_manager");
    await page.goto("/waste-log", { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible({ timeout: FIRST_PAINT_MS });
    await page.waitForLoadState("networkidle").catch(() => {});
    expect(
      await searchVisible(page),
      "an office role lost the search field — they reach a client by typing a name",
    ).toBe(true);
  });
});
