/**
 * Price by how often (#572, F-07), in a real browser.
 *
 * Settings → Business defaults for a pet-waste owner draws the cadence card:
 * each cadence's per-visit multiplier, and what a visit and a week cost
 * against the $25 standard price in the fixture. Twice a week must read
 * 0.9x a visit ($22.50) and 1.8x a week ($45.00), the D1 table, not 3.6x.
 * A business that does not scoop is not shown the card.
 *
 * Measured at the four CLAUDE.md widths and the four widths #572 asked for
 * screenshots at, with touch on. Screenshots land in
 * .helm/screenshots/issue-572/ when SHOTS=1.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [
  { w: 360, h: 780 },
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 820, h: 1180 },
  { w: 1024, h: 1366 },
  { w: 1280, h: 800 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
];
const SHOTS = join(process.cwd(), ".helm/screenshots/issue-572");
const SHOT_WIDTHS = [390, 820, 1024, 1440];

function features(lines: string[]) {
  return { ...(BASE_STUBS.getMyOrgFeatures as Record<string, unknown>), serviceLines: lines };
}

async function measure(page: Page, width: number) {
  await page.waitForTimeout(400);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `@${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `@${width}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `@${width}: clipped`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `@${width}: a button narrower than its label`,
  ).toEqual([]);
  expect(await findControlsUnder44px(page), `@${width}: under 44px`).toEqual([]);
}

for (const { w, h } of WIDTHS) {
  test.describe(`@${w}px`, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: true });

    test("a pet-waste owner sees and can edit every cadence", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "owner",
        serviceLines: ["pet_waste"],
        overrides: { getMyOrgFeatures: features(["pet_waste"]) },
      });
      await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
      const heading = page.getByRole("heading", { name: "Price by how often" });
      await expect(heading).toBeVisible({ timeout: 45_000 });

      await expect(page.getByLabel("Twice a week")).toHaveValue("0.9");
      await expect(page.getByLabel("Every 2 weeks")).toHaveValue("1.7");
      await expect(page.getByLabel("Monthly")).toHaveValue("3.2");
      await expect(page.getByTestId("freq-week-weekly")).toHaveText("1x ($25.00)");
      await expect(page.getByTestId("freq-week-twice_weekly")).toHaveText("1.8x ($45.00)");
      await expect(page.getByTestId("freq-week-biweekly")).toHaveText("0.85x ($21.25)");

      // Typing the old per-visit 1.8 is refused before it reaches the server.
      await page.getByLabel("Twice a week").fill("1.8");
      await expect(page.getByTestId("freq-week-twice_weekly")).toHaveText("3.6x ($90.00)");
      await expect(page.getByText(/A twice-weekly visit can cost at most/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Save" }).filter({ hasNotText: "Saving" }).last(),
      ).toBeDisabled();
      await page.getByLabel("Twice a week").fill("0.9");

      await heading.scrollIntoViewIfNeeded();
      await measure(page, w);
      if (process.env.SHOTS && SHOT_WIDTHS.includes(w)) {
        mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: join(SHOTS, `settings-business-${w}.png`), fullPage: true });
        const card = page.locator("form").filter({ has: page.getByLabel("Twice a week") });
        await card.locator("xpath=..").screenshot({ path: join(SHOTS, `cadence-card-${w}.png`) });
      }
    });

    test("a business that does not scoop is not shown the card", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, {
        role: "owner",
        serviceLines: ["dog_walking"],
        overrides: { getMyOrgFeatures: features(["dog_walking"]) },
      });
      await page.goto("/settings/business", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: "Standard pricing" })).toBeVisible({
        timeout: 45_000,
      });
      await expect(page.getByRole("heading", { name: "Price by how often" })).toHaveCount(0);
    });
  });
}
