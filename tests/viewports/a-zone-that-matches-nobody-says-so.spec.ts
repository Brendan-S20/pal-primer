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

    // ── WHY THIS WAIT, AND WHY IT IS NOT A RETRY ──────────────────────────
    //
    // The banner is drawn from getZoneCoverage(), a server function. On a cold
    // dev server the FIRST call to one pays for its on-demand transform, and
    // that cost lands entirely on whichever test navigates first -- the same
    // cold-start effect playwright.config.ts documents for the 90s test
    // ceiling, one layer further in.
    //
    // Measured, not assumed. Against a freshly started server this file's
    // 1280px case -- the one that PASSES -- took 15.1s, against an assertion
    // ceiling of 15s. It was never comfortably green; it was winning a coin
    // toss. The 360px case is first in the loop, so it paid the cost and lost,
    // while 1280px ran second on a warm server and took 3.5s. That is the
    // whole of the difference between them, and it is why this looked like a
    // width-dependent layout fault and is not one: at 360px the banner renders
    // correctly, it simply had not arrived yet.
    //
    // So wait for the navigation to go quiet BEFORE the assertion opens its
    // budget, which is exactly what settle() does in
    // every-signed-in-page-at-every-width.spec.ts and why the big sweeps do
    // not flake here. The 15s ceiling then measures what it was written to
    // measure -- whether the banner is on screen -- rather than how warm the
    // server was. A banner that is genuinely missing still fails, and still
    // fails in the same place.
    await page.waitForLoadState("networkidle").catch(() => {});

    const banner = page.getByText("still carry a zone the rules would no longer give them", {
      exact: false,
    });
    await expect(banner.first()).toBeVisible({ timeout: 15000 });
    const box = await banner.first().boundingBox();
    expect(box, "banner has no box").not.toBeNull();
    expect(box!.x + box!.width, "banner runs off the side").toBeLessThanOrEqual(w + 1);

    // The remedy has to be reachable too. A warning whose button is off the
    // side of a phone is the same dead end the banner was added to fix, and
    // 44px is the floor CLAUDE.md sets for anything a thumb has to hit.
    const button = page.getByRole("button", { name: "Re-run zone detection" });
    await expect(button, "the remedy button is not on screen").toBeVisible({
      timeout: 15000,
    });
    const bb = await button.boundingBox();
    expect(bb, "button has no box").not.toBeNull();
    expect(bb!.x + bb!.width, "button runs off the side").toBeLessThanOrEqual(w + 1);
    expect(bb!.height, "button is under the 44px touch floor").toBeGreaterThanOrEqual(44);
  });
}
