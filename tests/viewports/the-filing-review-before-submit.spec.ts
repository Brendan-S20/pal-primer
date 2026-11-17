/**
 * #971: Settings → Texting shows the owner, above Submit, the summary, sample
 * texts and opt-in the filing sends, word for word.
 *
 * The stub's resting registration is a rejection with the form open again,
 * and its getTextingFilingContext is a mixed business at full length (a
 * 51-character name, all five lines, portal and booking links with no space
 * to wrap on). That is the longest review there is, so it is measured as it
 * rests, and proved on screen by its own words first: every rule below
 * passes on a page that never drew it.
 *
 * Its own script, `npm run test:viewports:texting-filing`.
 */
import { test, expect, type Page } from "@playwright/test";
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
}

for (const width of WIDTHS) {
  test.describe(`the filing review at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("Settings → Texting: what carriers will read, above Submit", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
      const review = page.getByTestId("texting-filing-review");
      await expect(review).toBeVisible({ timeout: 45_000 });
      await expect(review.getByText("What carriers will read")).toBeVisible();
      await expect(
        review.getByText(
          /provides yard cleanups, walks, pet sits, grooming appointments and training sessions\./,
        ),
      ).toBeVisible();
      await expect(review.locator("li")).toHaveCount(3);
      await expect(
        review.getByText(/View and pay: https:\/\/app\.houndstack\.com\/portal\/qa-test-971/),
      ).toBeVisible();
      await expect(review.getByText(/Clients imported from a spreadsheet/)).toBeVisible();
      // Above the button that files it.
      const reviewBox = await review.boundingBox();
      const submitBox = await page
        .getByRole("button", { name: /Resubmit to carriers/ })
        .boundingBox();
      expect(reviewBox!.y + reviewBox!.height).toBeLessThanOrEqual(submitBox!.y);
      await measure(page, "settings-sms-filing-review", width);
    });
  });
}
