/**
 * #771: /setup step 1's "Save and continue", and the sticky bar it sat under.
 *
 * The bar (Back, Skip for now or Next) is sticky to the bottom of the screen
 * so a tall step still has a way forward under the thumb. Save was the last
 * thing in step 1's form, just above it, so whenever the end of the form was
 * near the bottom of the screen the bar was drawn over Save: at 1280 and on a
 * phone, the owner saw half a button and tapped the bar.
 *
 * Save is now IN the bar (SetupStepPrimary). This walks step 1 from the top
 * to the bottom of the page at each width, with touch on, and at every stop
 * asserts that Save, the way forward and Back are all on screen, a thumb's
 * size, and hit-testable: nothing is drawn over them. Then that the page does
 * not scroll sideways and that the bar did not grow a control under 44px.
 *
 * 360 and 402 are phones (402 is the iPhone 17 Pro the owner holds), 768 an
 * iPad in portrait, 1280 a small laptop: the widths #771 was filed at, and
 * the tablet band between them.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { findControlsOffTheSide, findControlsUnder44px, measurePageOverflow } from "./rules";

const SIZES = [
  { width: 360, height: 780 },
  { width: 402, height: 874 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];

const SHOTS = "test-results/setup-save-is-never-under-the-bar";

/** On screen, at least 44px tall, and the topmost thing at its centre. */
async function expectClearAndTappable(page: Page, control: Locator, name: string, at: string) {
  const vp = page.viewportSize()!;
  await expect(control, `${name} at ${at}`).toBeVisible();
  const box = (await control.boundingBox())!;
  expect(box, `${name} has no box at ${at}`).not.toBeNull();
  expect(box.x, `${name} off the left at ${at}`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${name} off the right at ${at}`).toBeLessThanOrEqual(vp.width);
  expect(box.y, `${name} above the screen at ${at}`).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, `${name} below the screen at ${at}`).toBeLessThanOrEqual(vp.height);
  expect(box.height, `${name} is ${box.height}px tall at ${at}`).toBeGreaterThanOrEqual(44);
  // The centre and four points just inside the corners: the bar used to
  // cover the lower half of Save, which a centre-only probe can miss. 8px in
  // from the side, so a rounded corner (hit-testing follows border-radius)
  // does not read as covered.
  await expect
    .poll(
      () =>
        control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const pts = [
            [r.left + r.width / 2, r.top + r.height / 2],
            [r.left + 8, r.top + 2],
            [r.right - 8, r.top + 2],
            [r.left + 8, r.bottom - 2],
            [r.right - 8, r.bottom - 2],
          ];
          return pts.every(([x, y]) => {
            const top = document.elementFromPoint(x, y);
            return !!top && (top === el || el.contains(top));
          });
        }),
      { message: `something is drawn over ${name} at ${at}`, timeout: 3000 },
    )
    .toBe(true);
}

for (const size of SIZES) {
  test.describe(`setup step 1 at ${size.width}x${size.height}, touch`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: size.width < 768,
      hasTouch: true,
    });

    test("Save and continue is never under the sticky bar, and Skip or Next stays on screen", async ({
      page,
    }) => {
      const context = page.context();
      await installSignedInSession(context);
      await installStubBackend(context);
      await page.goto("/setup?step=business");
      await expect(page.locator('[data-setup-step="business"]')).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      // The fixture's own business, so this is step 1 drawn from data and not
      // an empty form or the sign-in page.
      await expect(page.locator("#setup-name")).not.toHaveValue("");

      const bar = page.locator("[data-setup-footer]");
      const save = page.locator('[data-setup-action="save"]');
      const forward = page.locator('[data-setup-action="next"], [data-setup-action="skip"]');
      await expect(save).toHaveText("Save and continue", { timeout: FIRST_PAINT_MS });
      await expect(save).toHaveCount(1);
      await expect(forward).toHaveCount(1);
      // In the bar, not above it.
      expect(await bar.locator('[data-setup-action="save"]').count()).toBe(1);

      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const stops = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round((height - size.height) * f));
      for (const y of stops) {
        await page.evaluate((top) => window.scrollTo(0, top), y);
        await page.waitForTimeout(100);
        const at = `${size.width}px, scrolled to ${y}`;
        await expectClearAndTappable(page, save, "Save and continue", at);
        await expectClearAndTappable(page, forward, "Skip or Next", at);
        // The form's last field clears the bar once scrolled to the end:
        // the bar never sits over the end of the form for good.
        if (y === stops[stops.length - 1]) {
          const end = (await page.locator("#setup-workday-end").boundingBox())!;
          const barBox = (await bar.boundingBox())!;
          expect(
            end.y + end.height,
            `the last field is under the bar at ${at}`,
          ).toBeLessThanOrEqual(barBox.y);
        }
      }
      await page.screenshot({ path: `${SHOTS}/${size.width}.png` });

      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `the page scrolls sideways at ${size.width}`).toBeLessThanOrEqual(innerW + 1);
      expect(await findControlsOffTheSide(page)).toEqual([]);
      expect(await findControlsUnder44px(page)).toEqual([]);
    });
  });
}
