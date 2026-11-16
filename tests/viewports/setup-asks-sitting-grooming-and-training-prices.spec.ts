import { test, expect, type Page } from "@playwright/test";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { setupLinePriceOverrides } from "./fixtures/setup-line-prices";

/**
 * #959: /setup's price step at a sitter, a groomer, a trainer and a business
 * that does all three, measured at the four widths.
 *
 * Before #959 each of these was a button to Settings, Services; now each is a
 * form on the step (SetupLinePrices.tsx), and the size grid, the stay prices
 * and the package are new wide-ish content on a page that has to work at
 * 360px. Every case proves it drew the FORM, by a field only that form has,
 * and that the old Settings button is gone, before it measures: a page that
 * quietly drew the fallback would otherwise be measured green (CLAUDE.md).
 *
 * The refusal is pressed too, at every width, because the sentence beside
 * Save is the widest thing the form draws.
 *
 * Stub backend only. Runs with `npm run test:viewports:cases`.
 */

async function open(page: Page, lines: string[], w: number, h: number, skills = true) {
  await page.setViewportSize({ width: w, height: h });
  await installSignedInSession(page);
  await installStubBackend(page, {
    serviceLines: lines,
    overrides: setupLinePriceOverrides(lines, { skills }),
  });
  await page.goto("/setup?step=zones", { waitUntil: "domcontentloaded" });
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the router's error boundary, not the page`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

const noSettingsButton = async (page: Page) => {
  for (const name of [/^Review sitting prices$/, /^Review grooming setup$/, /^Price lessons$/])
    await expect(page.getByRole("link", { name })).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Review grooming prices, vaccines and buffer" }),
  ).toHaveCount(0);
};

for (const { w, h, label } of WIDTHS) {
  test.describe(`#959 setup prices, ${label}`, () => {
    test(`a sitter prices the three stays in place @${w}px`, async ({ page }) => {
      await open(page, ["pet_sitting"], w, h);
      await expect(page.getByRole("heading", { name: "Price your sitting services" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByLabel("Overnight stay ($ per night)")).toHaveValue("75.00", {
        timeout: 15_000,
      });
      await expect(page.getByLabel("Drop-in ($ per visit)")).toHaveValue("25.00");
      await noSettingsButton(page);
      await measure(page, w, `/setup stays @${w}px`);

      await page.getByLabel("Overnight stay ($ per night)").fill("");
      // Past the browser's own required check, to the form's sentence.
      await page.locator("form[data-setup-stay-prices]").evaluate((f) => {
        for (const i of f.querySelectorAll("input")) i.removeAttribute("required");
      });
      await page.locator('[data-setup-action="save-stays"]').click();
      await expect(page.locator("[data-setup-line-error]")).toHaveText(
        "Enter a price for Overnight stay.",
      );
      await measure(page, w, `/setup stays, refused @${w}px`);
    });

    test(`a groomer prices the size grid and reviews vaccines in place @${w}px`, async ({
      page,
    }) => {
      await open(page, ["mobile_grooming"], w, h);
      await expect(
        page.getByRole("heading", { name: "Review your grooming prices, vaccines and buffer" }),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.locator("[data-setup-size]")).toHaveCount(4, { timeout: 15_000 });
      await expect(page.locator("#setup-size-small-minutes")).toHaveValue("60");
      await expect(page.getByLabel("Setup, cleanup and travel minutes")).toHaveValue("15");
      await expect(page.getByLabel("Size prices for")).toBeVisible();
      await noSettingsButton(page);
      await measure(page, w, `/setup grooms @${w}px`);

      await page.locator('[data-setup-action="save-grooms"]').click();
      await expect(page.locator("[data-setup-line-error]")).toHaveText(
        "Enter a price for at least one size.",
      );
      await measure(page, w, `/setup grooms, refused @${w}px`);
    });

    test(`a trainer prices the package and adds a skill in place @${w}px`, async ({ page }) => {
      await open(page, ["training"], w, h, false);
      await expect(page.getByRole("heading", { name: "Price your lessons" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByLabel("6-session package ($)")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel("Lessons in the package")).toHaveValue("6");
      await expect(page.getByText("No skills yet. Add at least one.")).toBeVisible();
      await noSettingsButton(page);
      await measure(page, w, `/setup lessons @${w}px`);
    });

    test(`a business that sits, grooms and trains gets all three forms @${w}px`, async ({
      page,
    }) => {
      await open(page, ["pet_sitting", "mobile_grooming", "training"], w, h);
      await expect(page.getByRole("heading", { name: "Price your services" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      for (const part of ["stays", "grooms", "lessons"])
        await expect(page.locator(`[data-setup-price-form="${part}"]`)).toBeVisible();
      await expect(page.locator("[data-setup-stay-prices] input")).toHaveCount(3, {
        timeout: 15_000,
      });
      await expect(page.locator("[data-setup-size]")).toHaveCount(4);
      await expect(page.locator("[data-setup-skills] li")).toHaveCount(2);
      await expect(page.locator('[data-setup-action="save-stays"]')).toHaveText("Save stay prices");
      await noSettingsButton(page);
      await measure(page, w, `/setup mixed @${w}px`);
    });
  });
}
