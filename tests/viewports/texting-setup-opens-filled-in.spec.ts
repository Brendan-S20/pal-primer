/**
 * #970: Settings → Texting opens filled in from Business settings, needs one
 * authorized contact, and an owner holding Managed texting is offered "Text
 * your clients" in onboarding.
 *
 * Neither is a resting state of the stub (it answers a saved, rejected
 * registration and six setup steps), so each is driven here by overriding the
 * server function that decides it, and proved on screen by its own words
 * before anything is measured: every rule below passes on a page that never
 * drew the thing.
 *
 *   - /settings/sms with nothing saved: the form, prefilled at full awkward
 *     length (a 51-character DBA, a four-part address), the legal name empty,
 *     the second contact marked optional.
 *   - /setup?step=texting, for a scooping, walking, sitting, grooming,
 *     training and mixed business: the seventh step and its link.
 *
 * At 390 and 1440 (the widths #970 names) and the four CLAUDE.md asks for.
 * Its own script, `npm run test:viewports:texting-setup`.
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

const BASE_STATUS = BASE_STUBS.getOnboardingStatus as any;
const TEXTING_STEP = {
  id: "texting",
  label: "Text your clients",
  description:
    "File your business details so your own texting number can be registered with carriers. Reminders, on-my-way notices and invoices go out from it once it is approved.",
  done: false,
  to: "/settings/sms",
  cta: "Set up texting",
  gate: "/settings/billing",
};
const WITH_TEXTING = {
  ...BASE_STATUS,
  total: 7,
  steps: [...BASE_STATUS.steps, TEXTING_STEP],
};

const LINES: Record<string, string[]> = {
  scooping: ["pet_waste"],
  walking: ["dog_walking"],
  sitting: ["pet_sitting"],
  grooming: ["mobile_grooming"],
  training: ["training"],
  mixed: ["pet_waste", "dog_walking", "pet_sitting", "mobile_grooming", "training"],
};

for (const width of WIDTHS) {
  test.describe(`texting setup at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 1 });

    test("Settings → Texting: nothing saved, opens filled in", async ({ page, context }) => {
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
      await expect(page.getByTestId("texting-status")).toBeVisible({ timeout: 45_000 });
      await expect(page.locator("#dba")).toHaveValue(
        "QA TEST 970 Pet Waste, Walks and Yard Sanitation Co",
      );
      await expect(page.locator("#legal_name")).toHaveValue("");
      await expect(page.locator("#street")).toHaveValue("4200 Packard Street");
      await expect(page.locator("#street2")).toHaveValue("Building C, Suite 2400");
      await expect(page.locator("#city")).toHaveValue("Ann Arbor");
      await expect(page.locator("#region")).toHaveValue("MI");
      await expect(page.locator("#postal_code")).toHaveValue("48108");
      await expect(page.locator("#business_email")).toHaveValue(
        "office@qa-test-970-pet-waste-and-yard-sanitation.example.com",
      );
      await expect(page.locator("#c0-first")).toHaveValue("Avery");
      await expect(page.locator("#c0-last")).toHaveValue("Testington-Abernathy");
      await expect(page.locator("#c0-email")).toHaveValue(
        "avery@qa-test-970-pet-waste-and-yard-sanitation.example.com",
      );
      await expect(page.locator("#c1-first")).toHaveValue("");
      await expect(page.getByText("Second authorized contact (optional)")).toBeVisible();
      await measure(page, "settings-sms-prefilled", width);
    });

    for (const [kind, lines] of Object.entries(LINES)) {
      test(`/setup: a ${kind} business holding Managed texting`, async ({ page, context }) => {
        await installSignedInSession(context);
        await installStubBackend(context, {
          serviceLines: lines,
          overrides: { getOnboardingStatus: WITH_TEXTING },
        });
        await page.goto("/setup?step=texting", { waitUntil: "domcontentloaded" });
        const step = page.locator('[data-setup-step="texting"]');
        await expect(step).toBeVisible({ timeout: 45_000 });
        await expect(step.getByText("Text your clients").first()).toBeVisible();
        const link = page.locator('[data-setup-action="texting"]');
        await expect(link).toHaveAttribute("href", "/settings/sms");
        await measure(page, `setup-texting-${kind}`, width);
      });
    }
  });
}
