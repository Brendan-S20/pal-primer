/**
 * #969: Settings > Texting starts on the business's hosted page, and "I have
 * my own website" is the option. Driven by overriding the two server
 * functions that decide it, proved on screen by its own words before
 * anything is measured. TEST business only; nothing here reaches a backend.
 *
 *   - new registration, published TEST listing: hosted preselected, the three
 *     URLs shown, own-website inputs absent, Gmail email hint;
 *   - the same, switched to "I have my own website": today's three inputs;
 *   - new registration, no listing yet: hosted preselected, the plain
 *     "set up your page first" line with a link to Directory.
 *
 * Run with `npm run test:viewports:texting-hosted`. SHOTS_DIR=<dir> also
 * writes 390x844 and 1440x900 screenshots there (never committed).
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

const SIZES: Array<{ width: number; height: number }> = [
  { width: 360, height: 900 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
  { width: 1280, height: 900 },
  { width: 1440, height: 900 },
  { width: 1920, height: 900 },
];
const SLUG = "qa-test-969";
const HOSTED = {
  slug: SLUG,
  published: true,
  urls: {
    website_url: `https://mypets.services/${SLUG}`,
    privacy_url: `https://mypets.services/${SLUG}/privacy`,
    terms_url: `https://mypets.services/${SLUG}/terms`,
  },
};
const NEW_REGISTRATION = {
  ...(BASE_STUBS.getTextingRegistration as any),
  registration: null,
  live: false,
  subscribed: true,
  suggestions: { businessName: "QA TEST 969 Walks", email: "qa.test.969@gmail.com", phone: "" },
};

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

async function shot(page: Page, name: string, width: number) {
  const dir = process.env.SHOTS_DIR;
  if (!dir || (width !== 390 && width !== 1440)) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}-${width}.png`), fullPage: true });
}

async function open(page: Page, context: any, hosted: unknown) {
  await installSignedInSession(context);
  await installStubBackend(context, {
    overrides: { getTextingRegistration: NEW_REGISTRATION, getTextingHostedSite: hosted },
  });
  await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("texting-site-choice")).toBeVisible({ timeout: 45_000 });
}

for (const { width, height } of SIZES) {
  test.describe(`texting starts on the hosted page at ${width}px`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("new registration with a published listing: hosted preselected", async ({
      page,
      context,
    }) => {
      await open(page, context, HOSTED);
      const choice = page.getByTestId("texting-site-choice");
      await expect(choice.getByRole("radio", { name: /Use my free .* page/ })).toBeChecked();
      await expect(choice.getByRole("radio", { name: /I have my own website/ })).not.toBeChecked();
      const panel = page.getByTestId("texting-hosted-site");
      for (const url of Object.values(HOSTED.urls)) {
        await expect(panel.getByText(url, { exact: true })).toBeVisible();
      }
      await expect(page.locator("#website_url")).toHaveCount(0);
      await expect(page.getByText("Any email you check works, Gmail included.")).toBeVisible();
      await page.getByTestId("texting-site-choice").scrollIntoViewIfNeeded();
      await measure(page, "settings-sms-hosted", width);
      await shot(page, "settings-sms-hosted", width);
    });

    test("switched to 'I have my own website': today's three fields", async ({ page, context }) => {
      await open(page, context, HOSTED);
      await page.getByRole("radio", { name: /I have my own website/ }).check();
      await expect(page.locator("#website_url")).toBeVisible();
      await expect(page.locator("#privacy_url")).toBeVisible();
      await expect(page.locator("#terms_url")).toBeVisible();
      await expect(page.getByTestId("texting-hosted-site")).toHaveCount(0);
      await expect(page.getByText("On your website's domain.")).toBeVisible();
      await measure(page, "settings-sms-own-site", width);
      await shot(page, "settings-sms-own-site", width);
    });

    test("no listing yet: hosted preselected, says to set up the page first", async ({
      page,
      context,
    }) => {
      await open(page, context, { slug: null, published: false, urls: null });
      await expect(page.getByRole("radio", { name: /Use my free .* page/ })).toBeChecked();
      const panel = page.getByTestId("texting-hosted-site");
      await expect(
        panel.getByText(/Set up your .* page in Settings > Directory first/),
      ).toBeVisible();
      await expect(panel.getByRole("link", { name: "Open Directory" })).toBeVisible();
      await measure(page, "settings-sms-no-listing", width);
      await shot(page, "settings-sms-no-listing", width);
    });
  });
}
