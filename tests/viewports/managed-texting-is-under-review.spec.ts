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
 *   - #972: the same queue with a rejected and a stopped filing ahead of it,
 *     with Twilio's reason, the resubmit-by date and the last error; and
 *     Settings → Texting's plain-words advice under a 30493 rejection.
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
      await expect(page.getByText("Current plan").first()).toBeVisible({ timeout: 45_000 });
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

    test("/platform/addons: rejected and stopped filings, deadline first (#972)", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          listPlatformAddonsAdmin: { rows: [] },
          listTextingReviews: {
            rows: [
              {
                organizationId: "0f000000-0000-4000-8000-0000000000b1",
                businessName: "Whitfield-Ramirez Pet Waste Services of Detroit",
                legalName: "Greater Metropolitan Detroit Doo Disposal LLC",
                status: "rejected",
                phoneNumber: "+18445550123",
                submittedAt: "2026-11-08T15:00:00Z",
                approvedAt: null,
                opsApprovedAt: null,
                lastError: null,
                rejectionReason:
                  "Terms of Service URL is missing, unreachable, or lacking the required consumer protection and SMS disclosures (message rates, frequency and opt-out).",
                rejectionCode: "30493",
                resubmitDeadline: "2026-11-24T00:00:00Z",
              },
              {
                organizationId: "0f000000-0000-4000-8000-0000000000b2",
                businessName: "Pawsitively Spotless Walks, Sits and Grooming of Ann Arbor",
                legalName: "Pawsitively Spotless Holdings LLC",
                status: "failed",
                phoneNumber: null,
                submittedAt: "2026-11-09T15:00:00Z",
                approvedAt: null,
                opsApprovedAt: null,
                lastError:
                  "Twilio found something missing in the business profile: Business Registration Number, Website URL",
                rejectionReason: null,
                rejectionCode: null,
                resubmitDeadline: null,
              },
              {
                organizationId: "0f000000-0000-4000-8000-0000000000a1",
                businessName: "Detroit Doo",
                legalName: "Detroit Doo LLC",
                status: "in_review",
                phoneNumber: "+18445550124",
                submittedAt: "2026-11-10T15:00:00Z",
                approvedAt: null,
                opsApprovedAt: null,
                lastError: null,
                rejectionReason: null,
                rejectionCode: null,
                resubmitDeadline: null,
              },
            ],
          },
        },
      });
      await page.goto("/platform/addons", { waitUntil: "domcontentloaded" });
      const queue = page.getByTestId("texting-review-queue");
      await expect(queue).toBeVisible({ timeout: 45_000 });
      const rejected = queue.locator('li[data-status="rejected"]');
      await expect(
        rejected.getByText(/Your Terms page is missing what carriers look for/),
      ).toBeVisible();
      await expect(rejected.getByTestId("texting-resubmit-by")).toBeVisible();
      await expect(rejected.getByText(/^Twilio: Terms of Service URL/)).toBeVisible();
      await expect(rejected.getByText("Waiting on the owner")).toBeVisible();
      const failed = queue.locator('li[data-status="failed"]');
      await expect(failed.getByText(/^Last error: Twilio found something missing/)).toBeVisible();
      await expect(failed.getByRole("button")).toHaveCount(0);
      await expect(
        queue.locator('li[data-status="in_review"]').getByRole("button", { name: "Activate" }),
      ).toBeEnabled();
      await measure(page, "platform-texting-queue-rejected", width);
    });

    test("Settings → Texting: a 30493 rejection says what to fix (#972)", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: {
          getTextingRegistration: {
            ...(BASE_STUBS.getTextingRegistration as any),
            registration: {
              ...REJECTED,
              rejection_code: "30493",
              rejection_reason:
                "Terms of Service URL is missing, unreachable, or lacking the required consumer protection and SMS disclosures (message rates, frequency and opt-out).",
            },
            live: false,
            subscribed: true,
          },
        },
      });
      await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
      const advice = page.getByTestId("texting-rejection-advice");
      await expect(advice).toBeVisible({ timeout: 45_000 });
      await expect(advice.getByText(/What to fix: Your Terms page is missing/)).toBeVisible();
      await expect(
        page.getByTestId("texting-status").getByText(/Terms of Service URL is missing/),
      ).toBeVisible();
      await measure(page, "settings-sms-rejection-advice", width);
    });
  });
}
