/**
 * site-r2-05: Managed texting's "Under review" states, at four widths, in a
 * real browser.
 *
 * None of these is a resting state the sweeps open: the stub answers a
 * rejected registration and a business with no texting state at all. So each
 * one is driven here by overriding the server functions that decide it, and
 * proved on screen by its own words before anything is measured (every rule
 * below passes on a page that never drew the thing).
 *
 *   - Settings → Texting, submitted: the status card says "Under review" and
 *     "Under review, usually ready shortly", with the filed details beneath.
 *   - Settings → Texting, add-on not on the plan: the card that sends the
 *     owner to Plan & billing, above the form.
 *   - Plan & billing: a subscribed Managed texting card that reads Under
 *     review, not Active, with the sentence under it.
 *   - Messages: the header and the disabled New message, Under review.
 *   - /platform/addons: the admin queue with one business waiting and its
 *     Activate button, a 46-character name and a long legal name.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { BASE_STUBS, installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const LINE = "Under review, usually ready shortly";

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

const REJECTED = (BASE_STUBS.getTextingRegistration as any).registration;
const SUBMITTED = {
  ...REJECTED,
  status: "in_review",
  rejection_reason: null,
  rejection_code: null,
  resubmit_deadline: null,
};
const UNDER_REVIEW_AVAILABILITY = { available: false, state: "under_review" };

const MANAGED_SMS = {
  id: "00000000-0000-4000-8000-0000000005a1",
  slug: "managed-sms",
  name: "Managed texting",
  description:
    "Two-way texting with your clients from your own number, registered with carriers under your business name. HoundStack handles the setup and carrier filing for you, with consent and STOP handling built in. Add it, then submit your business details in Settings, Texting: it shows Under review, usually ready shortly, until we switch it on. No Twilio account of your own required.",
  price_cents: 2900,
  billing_interval: "month",
  status: "active",
  subscribed: true,
  includedReason: null,
  waivedReason: null,
  textingState: "under_review",
};

for (const width of WIDTHS) {
  test.describe(`managed texting under review at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("Settings → Texting: submitted, under review", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          getTextingRegistration: {
            ...(BASE_STUBS.getTextingRegistration as any),
            registration: SUBMITTED,
            live: false,
            subscribed: true,
          },
          getClientTextingAvailability: UNDER_REVIEW_AVAILABILITY,
        },
      });
      await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
      const card = page.getByTestId("texting-status");
      await expect(card).toBeVisible({ timeout: 45_000 });
      await expect(card.getByText("Under review", { exact: true })).toBeVisible();
      await expect(card.getByText(new RegExp(`^${LINE}\\.`))).toBeVisible();
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
      await measure(page, "settings-sms-under-review", width);
    });

    test("Settings → Texting: add-on not on the plan", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          getTextingRegistration: {
            ...(BASE_STUBS.getTextingRegistration as any),
            registration: null,
            live: false,
            subscribed: false,
          },
          getClientTextingAvailability: { available: false, state: "not_added" },
        },
      });
      await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
      const notice = page.getByTestId("texting-addon-needed");
      await expect(notice).toBeVisible({ timeout: 45_000 });
      await expect(notice.getByRole("link", { name: "Open Plan & billing" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Submit to carriers" })).toBeDisabled();
      await measure(page, "settings-sms-addon-needed", width);
    });

    test("Plan & billing: subscribed Managed texting reads Under review", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          listPlatformAddons: {
            addons: [MANAGED_SMS],
            canSubscribe: true,
            setup: { planSlug: "growth", founding: false },
          },
        },
      });
      await page.goto("/settings/billing", { waitUntil: "domcontentloaded" });
      await expect(page.getByText("Current plan")).toBeVisible({ timeout: 45_000 });
      const line = page.getByTestId("managed-texting-state");
      await expect(line).toHaveText(`Texting your clients is ${LINE.toLowerCase()}.`, {
        timeout: 15_000,
      });
      await expect(page.getByText("Under review", { exact: true }).first()).toBeVisible();
      await measure(page, "billing-managed-texting-under-review", width);
    });

    test("Messages: the header and New message say Under review", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: { getClientTextingAvailability: UNDER_REVIEW_AVAILABILITY },
      });
      await page.goto("/messages", { waitUntil: "domcontentloaded" });
      await expect(page.getByRole("heading", { name: /Messages/ }).first()).toBeVisible({
        timeout: 45_000,
      });
      await expect(
        page.getByText(`Texting your clients is ${LINE.toLowerCase()}.`, { exact: false }).first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText(/coming soon/i)).toHaveCount(0);
      await measure(page, "messages-under-review", width);
    });

    test("/platform/addons: the queue an admin activates from", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          listPlatformAddonsAdmin: { rows: [] },
          listTextingReviews: {
            rows: [
              {
                organizationId: "0f000000-0000-4000-8000-0000000000a1",
                businessName: "Whitfield-Ramirez Pet Waste Services of Detroit",
                legalName: "Greater Metropolitan Detroit Doo Disposal LLC",
                status: "approved",
                phoneNumber: "+18445550123",
                submittedAt: "2026-11-08T15:00:00Z",
                approvedAt: "2026-11-09T09:00:00Z",
                opsApprovedAt: null,
                lastError: null,
              },
            ],
          },
        },
      });
      await page.goto("/platform/addons", { waitUntil: "domcontentloaded" });
      const queue = page.getByTestId("texting-review-queue");
      await expect(queue).toBeVisible({ timeout: 45_000 });
      await expect(queue.getByText("Carrier approved. Ready to activate.")).toBeVisible();
      await expect(queue.getByRole("button", { name: "Activate" })).toBeEnabled();
      await measure(page, "platform-texting-queue", width);
    });
  });
}
