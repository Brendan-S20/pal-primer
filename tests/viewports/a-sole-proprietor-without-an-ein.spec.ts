/**
 * #968: Settings → Texting asks "Do you have an EIN from the IRS?", and No
 * files a sole proprietor in their own name with no EIN.
 *
 * No is not a resting state of the stub (it answers a rejected LLC), so the
 * spec opens a new form (registration: null, the fixture's suggestions) and
 * answers No as an owner would, then proves the No branch on screen by what
 * only it draws: the EIN field gone, the business type fixed to sole
 * proprietor, the legal name read-only and equal to contact 1's name, and
 * the LLC warning. A second case picks LLC first, then No, and must be told
 * an LLC has an EIN. Every rule below passes on a page that never drew the
 * branch, so the branch is proved first.
 *
 * At 390 and 1440 (the widths #968 names) and the four CLAUDE.md asks for.
 * Its own script, `npm run test:viewports:no-ein`.
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

async function open(page: Page, context: import("@playwright/test").BrowserContext) {
  await installSignedInSession(context);
  await installStubBackend(context, {
    overrides: {
      getTextingRegistration: {
        ...(BASE_STUBS.getTextingRegistration as any),
        registration: null,
        live: false,
        subscribed: true,
      },
    },
  });
  await page.goto("/settings/sms", { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("texting-ein-question")).toBeVisible({ timeout: 45_000 });
}

for (const width of WIDTHS) {
  test.describe(`no EIN at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("Settings → Texting: No files a sole proprietor in their own name", async ({
      page,
      context,
    }) => {
      await open(page, context);
      // Yes is the default, and draws the EIN field.
      await expect(page.locator("#ein")).toBeVisible();
      await page.getByLabel("No, I'm a sole proprietor without one").check();
      await expect(page.getByTestId("texting-no-ein")).toBeVisible();
      await expect(page.getByText(/An LLC always has an EIN/)).toBeVisible();
      await expect(page.locator("#ein")).toHaveCount(0);
      await expect(page.locator("#business_type")).toHaveValue("sole_proprietor");
      await expect(page.locator("#business_type")).toBeDisabled();
      const legal = page.locator("#legal_name");
      await expect(legal).toHaveAttribute("readonly", "");
      await expect(legal).toHaveValue(
        `${await page.locator("#c0-first").inputValue()} ${await page.locator("#c0-last").inputValue()}`.trim(),
      );
      // The legal name follows contact 1 as it is typed.
      await page.locator("#c0-last").fill("Doe");
      await page.locator("#c0-first").fill("Devin");
      await expect(legal).toHaveValue("Devin Doe");
      await measure(page, "settings-sms-no-ein", width);
    });

    test("Settings → Texting: an LLC that answers No is told it has an EIN", async ({
      page,
      context,
    }) => {
      await open(page, context);
      await page.locator("#business_type").selectOption("llc");
      await page.getByLabel("No, I'm a sole proprietor without one").check();
      await expect(
        page.getByText(
          "You chose LLC as your business type. That kind of business has an EIN: choose Yes.",
        ),
      ).toBeVisible();
      await measure(page, "settings-sms-no-ein-llc", width);
      // Yes puts the LLC back, and the EIN field.
      await page.getByLabel("Yes, the business has an EIN").check();
      await expect(page.locator("#business_type")).toHaveValue("llc");
      await expect(page.locator("#ein")).toBeVisible();
    });
  });
}
