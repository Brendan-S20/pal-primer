/**
 * The coverage banner has to REACH THE SCREEN.
 *
 * `every-signed-in-page-at-every-width.spec.ts` measures /zones and would stay
 * green with this banner deleted: its assertions are all of the form "nothing
 * is wrong", and a page missing a warning has nothing wrong with its layout.
 * The surface's own proof locator and fixture string predate this banner and
 * say nothing about it.
 *
 * So this asserts the opposite shape: that the sentence is visible, and that
 * it does not run off the side at the narrow end -- a banner is a long line of
 * prose with a zone name in it, which is the exact thing that overflows 360px.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";

for (const w of [360, 1280]) {
  test(`the coverage banner is on screen at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/zones");
    const banner = page.getByText("still carry a zone the rules would no longer give them", {
      exact: false,
    });
    await expect(banner.first()).toBeVisible({ timeout: 15000 });
    const box = await banner.first().boundingBox();
    expect(box, "banner has no box").not.toBeNull();
    expect(box!.x + box!.width, "banner runs off the side").toBeLessThanOrEqual(w + 1);
  });
}
