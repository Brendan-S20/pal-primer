/**
 * #930: the Clients texting consent notice, in both texting states, in a
 * real browser.
 *
 *   - Texting not set up (the stub's resting state): the notice says "so they
 *     won't get texts once you set up texting" and links to Settings > Texting.
 *     Nothing on the page says "coming soon".
 *   - Texting on: the wording it always had, and no set-up link.
 *
 * Each state is proved on screen by its own words before anything is
 * measured, at 360 / 390 / 768 / 1280 / 1440 / 1920 with touch on, against
 * the stub backend (a fixture business; nothing reaches a real one). With
 * SHOTS=1 a screenshot of each state at 390, 768, 1280 and 1440 lands in
 * .helm/screenshots/issue-930/.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 390, 768, 1280, 1440, 1920];
const SHOT_WIDTHS = new Set([390, 768, 1280, 1440]);
const SHOTS = join(process.cwd(), ".helm/screenshots/issue-930");
const FIRST_PAINT = { timeout: 45_000 };

async function measure(page: Page, label: string, width: number) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${label} @${width}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `${label} @${width}: off the side`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${label} @${width}: clipped`).toEqual([]);
  expect(
    await findControlsNarrowerThanTheirLabel(page),
    `${label} @${width}: a button narrower than its label`,
  ).toEqual([]);
  if (width < 768) {
    expect(await findControlsUnder44px(page), `${label} @${width}: under 44px`).toEqual([]);
  }
  if (process.env.SHOTS && SHOT_WIDTHS.has(width)) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`) });
  }
}

test.use({ hasTouch: true });

for (const width of WIDTHS) {
  test.describe(`the clients consent notice at ${width}px`, () => {
    test.use({ viewport: { width, height: width < 768 ? 844 : 1000 }, isMobile: width < 768 });

    test("texting not set up: says set it up, links to Settings > Texting", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: { getClientTextingAvailability: { available: false, state: "none" } },
      });
      await page.goto("/clients", { waitUntil: "domcontentloaded" });
      const notice = page.getByText(/clients with a phone number have no texting consent on file/);
      await expect(notice).toBeVisible(FIRST_PAINT);
      await expect(notice).toContainText("so they won't get texts once you set up texting.");
      const link = notice.getByRole("link", { name: "Set up texting" });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute("href", "/settings/sms");
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
      await measure(page, "clients-texting-not-set-up", width);
    });

    test("texting on: the notice is unchanged", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: { getClientTextingAvailability: { available: true, state: "active" } },
      });
      await page.goto("/clients", { waitUntil: "domcontentloaded" });
      const notice = page.getByText(/clients with a phone number have no texting consent on file/);
      await expect(notice).toBeVisible(FIRST_PAINT);
      await expect(notice).toContainText("so reminders and notifications will not reach them.");
      await expect(notice.getByRole("link", { name: "Set up texting" })).toHaveCount(0);
      await measure(page, "clients-texting-on", width);
    });
  });
}
