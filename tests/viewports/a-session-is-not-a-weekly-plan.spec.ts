import { mkdirSync } from "node:fs";
import { test, expect, type Page, type Route } from "@playwright/test";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  PORTAL_ORG_ID,
  PORTAL_ORG_NAME,
  PORTAL_SLUG,
  SIGNUP_FORM,
} from "./fixtures/portal-dataset";
import * as fx from "./fixtures/dataset";

/**
 * #574: the booking link starts a service the way the owner set it up. The
 * owner's control in Settings -> Services, and the public form for a
 * one-visit Evaluation beside a weekly walk: the Evaluation has no cadence
 * picker and says it is charged once; the walk keeps its cadence and the
 * prepaid sentence. Screenshots land in .helm/screenshots/issue-574/.
 */

const WIDTHS = [
  { w: 390, h: 844 },
  { w: 820, h: 1180 },
  { w: 1024, h: 900 },
  { w: 1440, h: 900 },
];

const EVAL_ID = "e867d1a8-0000-4000-8000-000000000574";
const WALK_ID = "55555555-0000-4000-8000-000000005741";
const LESSON_ID = "aaaaaaaa-0000-4000-8000-000000005742";
const PACKAGE_ID = "cccccccc-0000-4000-8000-000000005743";

const LINES = ["pet_waste", "dog_walking", "pet_sitting", "training", "mobile_grooming"];

const settingsServices = [
  ...fx.SERVICES.map((s: Record<string, unknown>) => ({
    ...s,
    public_booking_mode: "recurring",
    public_package_id: null,
  })),
  {
    id: EVAL_ID,
    organization_id: fx.ORG_ID,
    name: "Evaluation (45 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 6500,
    extra_pet_cents: 0,
    default_duration_min: 45,
    public_booking_mode: "one_time",
    public_package_id: null,
    active: true,
  },
  {
    id: LESSON_ID,
    organization_id: fx.ORG_ID,
    name: "Private lesson (60 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 8000,
    extra_pet_cents: 0,
    default_duration_min: 60,
    public_booking_mode: "package",
    public_package_id: PACKAGE_ID,
    active: true,
  },
];

const catalogPackage = {
  id: PACKAGE_ID,
  organization_id: fx.ORG_ID,
  service_id: LESSON_ID,
  name: "4-pack",
  sessions_count: 4,
  expires_after_days: 90,
  price_cents: 30000,
  active: true,
};

const publicServices = [
  {
    id: WALK_ID,
    name: "30-minute walk",
    service_line: "dog_walking",
    price_unit: "visit",
    base_price_cents: 3000,
    extra_pet_cents: 500,
    default_duration_min: 30,
    booking_mode: "recurring",
    package: null,
  },
  {
    id: EVAL_ID,
    name: "Evaluation (45 min)",
    service_line: "training",
    price_unit: "visit",
    base_price_cents: 6500,
    extra_pet_cents: 0,
    default_duration_min: 45,
    booking_mode: "one_time",
    package: null,
  },
];

function quoteFor(a: Record<string, unknown>) {
  const one = a.service_id === EVAL_ID;
  return {
    available: true,
    quote: {
      organization_id: PORTAL_ORG_ID,
      zone_id: "dddddddd-0000-4000-8000-00000000d0f1",
      zone_name: "Ravenswood",
      base_price_cents: one ? 6500 : 3000,
      per_dog_addl_cents: 0,
      recurring_price_cents: one ? 6500 : 3000,
      initial_cleanup_cents: 0,
      currency: "usd",
      first_cleanup_mode: "off",
      first_cleanup_label: null,
      first_cleanup_options: [],
      extra_lines: [],
      add_on_names: [],
      pet_sizes: [],
      booking_mode: one ? "one_time" : "recurring",
      package: null,
    },
  };
}

function serverFnName(route: Route): string {
  const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
  try {
    const meta = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString());
    return String(meta.export ?? "").replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

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

const shotDir = ".helm/screenshots/issue-574";

for (const { w, h } of WIDTHS) {
  test.describe(`#574 at ${w}px`, () => {
    test.use({ viewport: { width: w, height: h }, isMobile: w < 768, hasTouch: w < 1024 });

    test("Settings: the booking-link mode on an Evaluation", async ({ page }) => {
      mkdirSync(shotDir, { recursive: true });
      await installSignedInSession(page);
      await installStubBackend(page, { role: "owner", serviceLines: ["pet_waste", "training"] });
      const answers: Record<string, unknown> = {
        ensureTrainingCatalog: { ok: true },
        listServices: { services: settingsServices },
        listServicePackages: { packages: [catalogPackage] },
        listTrainingSkills: { skills: [] },
        getTrainingSessionRules: { lateCancelHours: 24, missedUsesSession: true },
      };
      await page.route("**/_serverFn/**", async (route) => {
        const name = serverFnName(route);
        if (!(name in answers)) return route.fallback();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ result: answers[name] }),
        });
      });
      await page.goto("/settings/services", { waitUntil: "domcontentloaded" });
      const row = page
        .getByTestId("services-list")
        .locator("li", { hasText: "Evaluation (45 min)" });
      await expect(row).toBeVisible({ timeout: 45_000 });
      await expect(row.getByText("Booking link: One visit")).toBeVisible();
      await row.getByRole("button", { name: "Edit" }).click();
      const dialog = page.getByRole("dialog");
      const modes = dialog.getByTestId("booking-mode");
      await expect(modes).toBeVisible();
      await expect(modes.getByRole("radio", { name: /One visit/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(modes.getByRole("radio", { name: /Repeating plan/ })).toBeVisible();
      await expect(modes.getByRole("radio", { name: /Request only/ })).toBeVisible();
      await page.waitForTimeout(500);
      await measure(page, w, `settings @${w}`);
      await modes.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shotDir}/settings-mode-one-time-${w}.png` });
    });

    for (const which of ["one_time", "recurring"] as const) {
      test(`public Start: ${which}`, async ({ page }) => {
        mkdirSync(shotDir, { recursive: true });
        await installStubBackend(page, {
          portal: true,
          overrides: {
            getPublicSignupForm: {
              ...SIGNUP_FORM,
              firstCleanup: { mode: "off", tiers: [] },
              services: publicServices,
              serviceLines: { bookable: LINES, customerRequestable: LINES },
              lines: ["dog_walking", "training"],
              extras: { addOns: [], sizePrices: [] },
            },
            getSignupQuote: (a: Record<string, unknown>) => quoteFor(a),
          },
        });
        await page.goto(`/signup/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });
        await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 45_000 });

        await page.locator("#service").click();
        await page
          .getByRole("option", { name: which === "one_time" ? /Evaluation/ : /30-minute walk/ })
          .click();
        await page.getByLabel("ZIP code").fill("60601");
        await page.getByRole("button", { name: "Get instant price" }).click();

        if (which === "one_time") {
          await expect(page.locator("#frequency")).toHaveCount(0);
          await expect(
            page.getByText("One visit. You pay once for this session.").first(),
          ).toBeVisible();
          await expect(
            page
              .getByText(/charged once for this session/)
              .filter({ visible: true })
              .first(),
          ).toBeVisible({ timeout: 15_000 });
          await expect(page.getByText(/After today, you pay/)).toHaveCount(0);
          await expect(
            page.getByRole("button", { name: "Book and pay" }).filter({ visible: true }),
          ).toBeVisible();
        } else {
          await expect(page.locator("#frequency")).toBeVisible();
          await expect(
            page
              .getByText(/After today, you pay/)
              .filter({ visible: true })
              .first(),
          ).toBeVisible({ timeout: 15_000 });
          await expect(page.getByRole("button", { name: "Start service" })).toBeVisible();
        }
        await page.waitForTimeout(700);
        await measure(page, w, `public ${which} @${w}`);
        await page.screenshot({
          path: `${shotDir}/public-start-${which.replace("_", "-")}-${w}.png`,
          fullPage: true,
        });
      });
    }
  });
}
