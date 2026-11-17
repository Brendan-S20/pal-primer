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
 *     "set up your page first" line with a link to Directory;
 *   - (review) the hosted addresses are links that open in a new tab, and
 *     the "Read them before you submit" line sits above Submit;
 *   - (review) Settings > Directory while a hosted registration is filed:
 *     the address is read-only, the listing switch is held, and the reason
 *     is said.
 *
 * Run with `npm run test:viewports:texting-hosted`. SHOTS_DIR=<dir> also
 * writes 390x844 and 1440x900 screenshots there (never committed).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
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
  ...(BASE_STUBS.getTextingRegistration as Record<string, unknown>),
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

async function open(page: Page, context: BrowserContext, hosted: unknown) {
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
      for (const url of [HOSTED.urls.privacy_url, HOSTED.urls.terms_url]) {
        const link = panel.getByRole("link", { name: url, exact: true });
        await expect(link).toHaveAttribute("href", url);
        await expect(link).toHaveAttribute("target", "_blank");
      }
      await expect(page.getByTestId("texting-read-policies")).toHaveText(
        "These pages are your business's Privacy Policy and Terms. Read them before you submit.",
      );
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

/** A TEST business's listing, published, for Settings > Directory. */
const QA_DIRECTORY = {
  canEdit: true,
  orgName: "QA TEST 969 Walks",
  hasLogo: false,
  zoneZips: ["48236", "48230"],
  services: [
    {
      id: "96900000-0000-4000-8000-000000000001",
      name: "TEST small-group walk",
      service_line: "dog_walking",
      price_unit: "visit",
      base_price_cents: 2400,
      active: true,
    },
  ],
  profile: {
    slug: SLUG,
    published: true,
    display_name: "QA TEST 969 Walks",
    show_logo: false,
    bio: "TEST listing used to check the texting lock.",
    coverage_zips: ["48236", "48230"],
    coverage_cities: ["Grosse Pointe"],
    confirmed_at: "2026-11-17T12:00:00Z",
    tagline: "TEST listing",
    highlights: [],
    areas: [],
    listed: [{ service_id: "96900000-0000-4000-8000-000000000001", price_from_cents: 2400 }],
  },
  booking: {
    available: true,
    enabled: false,
    policyText: "",
    publicSignupEnabled: true,
    chargesEnabled: false,
  },
};

for (const { width, height } of SIZES) {
  test.describe(`Settings > Directory while texting files the page at ${width}px`, () => {
    test.use({ viewport: { width, height }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("the address is read-only, the switch is held, and the reason is said", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: { getMyDirectoryProfile: QA_DIRECTORY, getDirectoryTextingLock: { slug: SLUG } },
      });
      await page.goto("/settings/directory", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Listed in the directory")).toBeVisible({ timeout: 45_000 });
      await expect(page.getByTestId("directory-texting-lock")).toContainText(
        "Your texting registration uses this page",
      );
      await expect(page.locator("#dir-slug")).toHaveAttribute("readonly", "");
      await expect(page.locator("#dir-slug")).toHaveValue(SLUG);
      await expect(
        page.getByRole("switch", { name: "List my business in the directory" }),
      ).toBeDisabled();
      await measure(page, "settings-directory-texting-lock", width);
      await shot(page, "settings-directory-texting-lock", width);
    });
  });
}
