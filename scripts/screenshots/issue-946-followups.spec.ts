// #946 follow-ups PR evidence: setup step 2's sticky bar and its refusal,
// before and after, at 390 and 1440.
//
// Stub backend only (tests/viewports/fixtures): no hosted database, nothing
// written. PHASE=before is run against origin/main's src, PHASE=after at the
// PR head. Viewport shots, not full-page: a full-page capture paints a sticky
// bar where the FIRST screen ended, which is how #950's 390 shots showed it
// "over the middle" of the form. What a thumb sees is one screen.
//
//   PHASE=after npx playwright test -c scripts/screenshots/issue-946-followups.config.ts
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { installSignedInSession } from "../../tests/viewports/fixtures/session";
import { BASE_STUBS, installStubBackend } from "../../tests/viewports/fixtures/stub-backend";
import { FIRST_CLEANUP_PRICING } from "../../tests/viewports/fixtures/dataset";

const directory = ".helm/screenshots/issue-946-followups";
const phase = process.env.PHASE === "before" ? "before" : "after";

async function open(page: Page) {
  const onboarding = BASE_STUBS.getOnboardingStatus as { steps: Array<Record<string, unknown>> };
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), {
    overrides: {
      getOnboardingStatus: {
        ...onboarding,
        completed: 1,
        steps: onboarding.steps.map((s, i) => ({ ...s, done: i === 0 })),
      },
      getFirstCleanupPricing: { pricing: { ...FIRST_CLEANUP_PRICING.pricing, mode: "off" } },
    },
  });
  await page.goto("/setup?step=zones");
  await expect(page.locator("[data-setup-area-form]")).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-setup-action="save"]')).toHaveText("Save and continue", {
    timeout: 90_000,
  });
}

async function shoot(page: Page, width: number, state: string, extra: Record<string, unknown>) {
  await page.waitForTimeout(400);
  const geometry = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    barTop: document.querySelector("[data-setup-footer]")!.getBoundingClientRect().top,
    scrollPaddingBottom: document.documentElement.style.scrollPaddingBottom || null,
  }));
  expect(geometry.scrollWidth, `${state} @${width}: no horizontal page scroll`).toBeLessThanOrEqual(
    width + 1,
  );
  mkdirSync(directory, { recursive: true });
  const name = `${phase}-${state}-${width}`;
  await page.screenshot({ path: `${directory}/${name}.png` });
  writeFileSync(
    `${directory}/${name}.json`,
    JSON.stringify({ phase, state, width, ...geometry, ...extra }, null, 2) + "\n",
  );
}

const box = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });

for (const size of [
  { width: 390, height: 844, touch: true },
  { width: 1440, height: 900, touch: false },
]) {
  test.describe(`#946 follow-ups @${size.width}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      isMobile: size.touch,
      hasTouch: size.touch,
    });

    test("a field reached with Tab, and the refusal after Off", async ({ page }) => {
      test.setTimeout(180_000);
      await open(page);

      // 1. "Every 2 weeks" parked just behind the bar, then reached with Tab.
      await page.evaluate(() => {
        const el = document.getElementById("setup-mult-biweekly")!;
        const bar = document.querySelector("[data-setup-footer]")!.getBoundingClientRect();
        window.scrollBy(0, el.getBoundingClientRect().top - (bar.top + 20));
      });
      await page
        .locator("#setup-mult-weekly")
        .evaluate((e) => (e as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press("Tab");
      await shoot(page, size.width, "tab-to-every-2-weeks", {
        focusedField: await box(page, "#setup-mult-biweekly"),
      });

      // 2. Save refused for the first cleanup.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.fill("#setup-zone-price", "20");
      await page.locator('[data-setup-action="save"]').click();
      await expect(page.locator("[data-setup-error]")).toBeVisible();
      await shoot(page, size.width, "save-refused", {
        alert: await box(page, "[data-setup-error]"),
      });

      // 3. Off picked: the choice is made.
      await page.locator("#setup-first-cleanup-off").click();
      await page
        .locator("[data-setup-error]")
        .waitFor({ state: "detached", timeout: 1500 })
        .catch(() => {});
      await page
        .locator("[data-setup-area-form] [data-setup-first-cleanup]")
        .scrollIntoViewIfNeeded();
      await shoot(page, size.width, "off-picked-after-refusal", {
        alertText: (await page.locator("[data-setup-error]").allTextContents())[0] ?? null,
      });
    });
  });
}
