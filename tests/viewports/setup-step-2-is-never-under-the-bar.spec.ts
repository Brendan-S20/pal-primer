/**
 * #946 follow-ups, from HoundStack Product's review of #950: setup step 2,
 * "Your service area and price", at 390.
 *
 * 1. The sticky bar (Save, Back, Skip) is two rows at 390, over the tab bar:
 *    about 180px of an 844px screen. The browser did not know it was there,
 *    so a field focused with Tab or the keyboard's Next, or scrolled to,
 *    counted as in view while it sat behind the bar. SetupStepFooter now sets
 *    what it covers as the page's scroll-padding-bottom, so every field
 *    focused, and the refusal brought into view, lands above the bar.
 * 2. After a refused save, picking Off left "Choose whether new clients pay
 *    for a first cleanup." on screen. The refusal is now read live, as step
 *    1's is (#942): it goes as the choice is made, and says what is still
 *    missing if something is.
 *
 * Touch on, on the stub backend: no database, nothing written anywhere.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import { FIRST_CLEANUP_PRICING } from "./fixtures/dataset";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { measurePageOverflow } from "./rules";

const CHOOSE = "Choose whether new clients pay for a first cleanup.";
const FLAT_PRICE = "Enter what a first cleanup costs, or choose Off.";

/** A business on step 2: step 1 done, no area yet, first cleanup not tiered. */
async function openStep2(page: Page) {
  const context = page.context();
  const onboarding = BASE_STUBS.getOnboardingStatus as { steps: Array<Record<string, unknown>> };
  await installSignedInSession(context);
  await installStubBackend(context, {
    overrides: {
      getOnboardingStatus: {
        ...onboarding,
        completed: 1,
        steps: onboarding.steps.map((s, i) => ({ ...s, done: i === 0 })),
      },
      // Off, not tiered: the step asks the owner to choose, with nothing picked.
      getFirstCleanupPricing: {
        pricing: { ...FIRST_CLEANUP_PRICING.pricing, mode: "off" },
      },
    },
  });
  await page.goto("/setup?step=zones");
  await expect(page.locator("[data-setup-area-form]")).toBeVisible({ timeout: FIRST_PAINT_MS });
  // Drawn from data: the fixture business's own ZIP, and the prices loaded.
  await expect(page.locator("#setup-zone-zip")).not.toHaveValue("");
  await expect(page.locator('[data-setup-action="save"]')).toHaveText("Save and continue", {
    timeout: FIRST_PAINT_MS,
  });
}

/** The top of the bar, where it is stuck, in viewport coordinates. */
const barTop = (page: Page) =>
  page.locator("[data-setup-footer]").evaluate((el) => el.getBoundingClientRect().top);

test.describe("setup step 2 at 390x844, touch (#946 follow-ups)", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("a field focused, or the refusal shown, is never under the sticky bar", async ({ page }) => {
    await openStep2(page);
    const ids = await page
      .locator(
        "[data-setup-area-form] input:not([type=hidden]), [data-setup-area-form] button[type=button]",
      )
      .evaluateAll((els) => els.map((e) => e.id || "").filter(Boolean));
    // Every input, and the first-cleanup choice, which has ids for this.
    expect(ids).toEqual(
      expect.arrayContaining([
        "setup-zone-name",
        "setup-zone-zip",
        "setup-zone-price",
        "setup-zone-dog",
        "setup-first-cleanup-off",
        "setup-mult-weekly",
        "setup-mult-biweekly",
      ]),
    );
    for (const id of ids) {
      // Park the field just behind the bar, then focus it, as Tab or the
      // keyboard's Next does: the browser scrolls it out only if it knows
      // the bar is there.
      await page.evaluate((fieldId) => {
        const el = document.getElementById(fieldId)!;
        const bar = document.querySelector("[data-setup-footer]")!.getBoundingClientRect();
        window.scrollBy(0, el.getBoundingClientRect().top - (bar.top + 20));
        (document.activeElement as HTMLElement | null)?.blur();
      }, id);
      await page.locator(`#${id}`).focus();
      await page.waitForTimeout(100);
      const box = (await page.locator(`#${id}`).boundingBox())!;
      const top = await barTop(page);
      expect(box.y + box.height, `#${id} focused under the bar at 390`).toBeLessThanOrEqual(top);
      expect(box.y, `#${id} focused above the screen at 390`).toBeGreaterThanOrEqual(0);
    }

    // The keyboard's own way there, once: Tab from Weekly to Every 2 weeks.
    await page.evaluate(() => {
      const el = document.getElementById("setup-mult-biweekly")!;
      const bar = document.querySelector("[data-setup-footer]")!.getBoundingClientRect();
      window.scrollBy(0, el.getBoundingClientRect().top - (bar.top + 20));
    });
    await page
      .locator("#setup-mult-weekly")
      .evaluate((e) => (e as HTMLElement).focus({ preventScroll: true }));
    await page.keyboard.press("Tab");
    await expect(page.locator("#setup-mult-biweekly")).toBeFocused();
    const tabbed = (await page.locator("#setup-mult-biweekly").boundingBox())!;
    expect(tabbed.y + tabbed.height, "Tab lands under the bar").toBeLessThanOrEqual(
      await barTop(page),
    );

    // Refused from the top of the page: the sentence is brought clear of the
    // bar, and nothing is drawn over it.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.fill("#setup-zone-price", "20");
    await page.locator('[data-setup-action="save"]').click();
    const alert = page.locator("[data-setup-error]");
    await expect(alert).toHaveText(CHOOSE);
    await page.waitForTimeout(400);
    const a = (await alert.boundingBox())!;
    expect(a.y + a.height, "the refusal is under the bar at 390").toBeLessThanOrEqual(
      await barTop(page),
    );
    expect(a.y).toBeGreaterThanOrEqual(0);
    const clear = await alert.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    expect(clear, "something is drawn over the refusal").toBe(true);

    // Scrolled to the end, the last of the form clears the bar for good.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(150);
    const end = (await alert.boundingBox())!;
    expect(end.y + end.height).toBeLessThanOrEqual(await barTop(page));

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW, "the page scrolls sideways at 390").toBeLessThanOrEqual(innerW + 1);
  });
});

for (const size of [
  { width: 390, height: 844, touch: true },
  { width: 1440, height: 900, touch: false },
]) {
  test.describe(`setup step 2's refusal at ${size.width} (#946 follow-ups)`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: size.touch,
      hasTouch: size.touch,
    });

    test("picking Off clears the first-cleanup refusal; picking Flat names what is left", async ({
      page,
    }) => {
      await openStep2(page);
      await page.fill("#setup-zone-price", "20");
      await page.locator('[data-setup-action="save"]').click();
      const alert = page.locator("[data-setup-error]");
      await expect(alert).toHaveText(CHOOSE);
      await expect(alert).toHaveAttribute("role", "alert");
      await expect(page).toHaveURL(/step=zones/);

      // Flat with no price: still refused, and the sentence says so, live.
      await page.locator("#setup-first-cleanup-flat").click();
      await expect(alert).toHaveText(FLAT_PRICE);

      // Off: nothing left to refuse, so the sentence goes. No second press.
      await page.locator("#setup-first-cleanup-off").click();
      await expect(page.locator("#setup-first-cleanup-off")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(alert).toHaveCount(0);
      await expect(page.locator("[data-setup-first-cleanup-unchosen]")).toHaveCount(0);

      // And a field emptied after a refusal is named again, live.
      await page.fill("#setup-zone-price", "");
      await expect(alert).toHaveText("Enter what you charge per visit.");
      await page.fill("#setup-zone-price", "20");
      await expect(alert).toHaveCount(0);
    });
  });
}
