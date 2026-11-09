import { mkdirSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  PORTAL_ORG_ID,
  PORTAL_ORG_NAME,
  PORTAL_SLUG,
  SIGNUP_FORM,
} from "./fixtures/portal-dataset";

/**
 * R2-37 / D12: a one-time cleanup shows the visit, the first-cleanup fee and
 * their total before the customer confirms, on the booking link and on the
 * quote link. Both at 390 (the width the decision asked for) and at the
 * working agreement's four, with touch on below 1024.
 *
 * The prices are the owner's, and deliberately not $18 + $75: $40.00 visit
 * (Settings → Client portal) and a $95.00 flat first cleanup, $135.00 total.
 * Screenshots land in .helm/screenshots/r2-37/.
 *
 * Named after a-session-is-not-a-weekly-plan.spec.ts (#574, the one-visit
 * booking mode this extends) so the `test:viewports:cases` filter for that
 * spec selects this one too, and CI runs it with no change to package.json.
 */

const WIDTHS = [
  { w: 360, h: 780 },
  { w: 390, h: 844 },
  { w: 768, h: 1024 },
  { w: 1280, h: 900 },
  { w: 1920, h: 1080 },
];

const CLEANUP_ID = "0e7c1ea2-0000-4000-8000-0000000d1201";
const QUOTE_TOKEN = "dddddddd-0000-4000-8000-0000000d1202";
const shotDir = ".helm/screenshots/r2-37";

const publicServices = [
  {
    id: CLEANUP_ID,
    name: "One-time yard cleanup",
    service_line: "pet_waste",
    price_unit: "visit",
    base_price_cents: null,
    extra_pet_cents: null,
    default_duration_min: 30,
    booking_mode: "one_time",
    package: null,
  },
];

const oneTimeQuote = {
  available: true,
  quote: {
    organization_id: PORTAL_ORG_ID,
    zone_id: "dddddddd-0000-4000-8000-00000000d0f1",
    zone_name: "Ravenswood",
    base_price_cents: 2000,
    per_dog_addl_cents: 500,
    // Already repriced by the server: the owner's $40 extra-visit price.
    recurring_price_cents: 4000,
    initial_cleanup_cents: 9500,
    currency: "usd",
    first_cleanup_mode: "flat",
    first_cleanup_label: null,
    first_cleanup_options: [],
    extra_lines: [],
    add_on_names: [],
    pet_sizes: [],
    booking_mode: "one_time",
    package: null,
  },
};

const publicQuote = {
  found: true,
  quote: {
    label: "Q-10512",
    status: "sent",
    title: "One-time cleanup",
    message: null,
    validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
    sentAt: new Date().toISOString(),
    acceptedAt: null,
    acceptedName: null,
    declinedAt: null,
    declineReason: null,
    recipientName: "Dana Whitfield-Ramirez",
    currency: "usd",
    depositCents: null,
    depositPayUrl: null,
    depositPaid: false,
  },
  org: {
    name: PORTAL_ORG_NAME,
    email: "office@example.com",
    phone: "+1 (312) 555-0142",
    timezone: "America/Chicago",
  },
  lines: [
    {
      description: "One-time cleanup visit",
      quantity: 1,
      unitAmountCents: 4000,
      amountCents: 4000,
      recurring: false,
    },
    {
      description: "First cleanup, 2 dogs",
      quantity: 1,
      unitAmountCents: 9500,
      amountCents: 9500,
      recurring: false,
    },
  ],
  totals: { oneTimeCents: 13500, recurringCents: 0 },
};

async function measure(page: Page, width: number, where: string) {
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: error boundary`).toBe(false);
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

for (const { w, h } of WIDTHS) {
  test.describe(`one-time cleanup at ${w}px`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 1024 });

    test("booking link: both lines and the total before Book and pay", async ({ page }) => {
      mkdirSync(shotDir, { recursive: true });
      await installStubBackend(page, {
        portal: true,
        overrides: {
          getPublicSignupForm: {
            ...SIGNUP_FORM,
            firstCleanup: { mode: "flat", tiers: [] },
            services: publicServices,
            serviceLines: { bookable: ["pet_waste"], customerRequestable: ["pet_waste"] },
            lines: ["pet_waste"],
            extras: { addOns: [], sizePrices: [] },
          },
          getSignupQuote: () => oneTimeQuote,
        },
      });
      await page.goto(`/signup/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 45_000 });

      await page.getByLabel("ZIP code").fill("60618");
      await page.getByRole("button", { name: "Get instant price" }).click();

      const total = page.getByTestId("one-time-cleanup-total").filter({ visible: true }).first();
      await expect(total).toBeVisible({ timeout: 15_000 });
      await expect(total).toContainText("Total today");
      await expect(total).toContainText("$135.00");
      const panel = page.getByTestId("one-time-cleanup-price").filter({ visible: true }).first();
      await expect(panel).toContainText("First cleanup (one-time)");
      await expect(panel).toContainText("$95.00");
      await expect(panel).toContainText("One-time cleanup visit");
      await expect(panel).toContainText("$40.00");
      await expect(page.locator("#frequency")).toHaveCount(0);
      await expect(
        page
          .getByText(/charged once for this cleanup/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible();

      await page.waitForTimeout(500);
      await measure(page, w, `booking @${w}`);
      await total.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/booking-${w}.png` });
    });

    test("quote link: both lines and the one-time total", async ({ page }) => {
      mkdirSync(shotDir, { recursive: true });
      await installStubBackend(page, {
        portal: true,
        overrides: {
          getPublicQuote: (a: Record<string, unknown>) =>
            a.token === QUOTE_TOKEN ? publicQuote : { found: false },
        },
      });
      await page.goto(`/q/${QUOTE_TOKEN}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText(/Accept quote/).first()).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("One-time cleanup visit").first()).toBeVisible();
      await expect(page.getByText("First cleanup, 2 dogs").first()).toBeVisible();
      const total = page.locator("dl div", { hasText: "One-time total" }).first();
      await expect(total).toContainText("$135.00");

      await page.waitForTimeout(500);
      await measure(page, w, `quote @${w}`);
      await total.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/quote-${w}.png` });
    });
  });
}
