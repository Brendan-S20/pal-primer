/**
 * A training evaluation is one session (#574), in a real browser.
 *
 * Three surfaces no sweep opens in this state:
 *
 *   - Settings -> Services -> Edit on "Evaluation (45 min)": the "On your
 *     booking link" control, set to One visit.
 *   - The booking link for that Evaluation, priced: no Frequency select, "One
 *     session", "charged once", and no "After today" sentence.
 *   - The same service set to a repeating plan (the control): the Frequency
 *     select is back and the per-session billing sentence with it.
 *
 * Each state is proved by its own words before anything is measured, and the
 * other mode's words are asserted ABSENT, so a fixture that fell back to the
 * weekly path goes red. Screenshots at 390, 820, 1024 and 1440 land in
 * .helm/screenshots/issue-574/ when SHOTS=1.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import * as fx from "./fixtures/dataset";
import { PORTAL_ORG_NAME, PORTAL_SLUG, SIGNUP_FORM } from "./fixtures/portal-dataset";
import { LAUNCH_DEFAULT } from "../support/service-line-availability";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [
  { w: 390, h: 844 },
  { w: 820, h: 1180 },
  { w: 1024, h: 900 },
  { w: 1440, h: 900 },
];
const SHOTS = join(process.cwd(), ".helm/screenshots/issue-574");

const EVAL_ID = "aaaaaaaa-0000-4000-8000-00000000c574";
const EVALUATION = {
  id: EVAL_ID,
  name: "Evaluation (45 min)",
  service_line: "training",
  price_unit: "visit",
  base_price_cents: 7500,
  extra_pet_cents: 0,
  default_duration_min: 45,
};

function quoteFor(mode: "one_time" | "recurring") {
  return {
    available: true as const,
    quote: {
      organization_id: SIGNUP_FORM.id,
      zone_id: "dddddddd-0000-4000-8000-00000000d0f1",
      zone_name: "Ravenswood Manor",
      base_price_cents: 7500,
      per_dog_addl_cents: 0,
      recurring_price_cents: 7500,
      initial_cleanup_cents: 0,
      currency: "usd",
      first_cleanup_mode: "off",
      first_cleanup_label: null,
      first_cleanup_options: [],
      extra_lines: [],
      add_on_names: [],
      pet_sizes: [],
      booking_mode: mode,
      package: null,
    },
  };
}

async function measure(page: Page, label: string, width: number) {
  await page.waitForTimeout(400);
  const health = await page.evaluate(() => ({
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${label}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${label}: error boundary`).toBe(false);
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
  if (!process.env.SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}-${width}.png`), fullPage: true });
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

async function openBookingLink(page: Page, mode: "one_time" | "recurring") {
  await installStubBackend(page, {
    portal: true,
    overrides: {
      getPublicSignupForm: {
        ...SIGNUP_FORM,
        firstCleanup: { mode: "off", tiers: [] },
        services: [{ ...EVALUATION, booking_mode: mode, package: null }],
        lines: ["training"],
        // Training on, as the platform switch has it since 20261027120000.
        // Without it the form lists nothing and falls back to the default
        // path, which is green for the wrong reason.
        serviceLines: LAUNCH_DEFAULT,
        extras: { addOns: [], sizePrices: [] },
      },
      getSignupQuote: quoteFor(mode),
    },
  });
  await page.goto(`/signup/${PORTAL_SLUG}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByText(PORTAL_ORG_NAME).first()).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("ZIP code").fill("60625");
  // The quote names the Evaluation by id: the page is pricing THIS service,
  // not the business's default path.
  const quoted = page.waitForRequest(
    (r) => r.url().includes("/_serverFn/") && (r.postData() ?? "").includes(EVAL_ID),
  );
  await page.getByRole("button", { name: "Get instant price" }).click();
  await quoted;
}

for (const { w, h } of WIDTHS) {
  test.describe(`a training evaluation @${w}px`, () => {
    test.use({ viewport: { width: w, height: h } });

    test("the booking link sells one session, charged once", async ({ page }) => {
      await openBookingLink(page, "one_time");
      await expect(page.getByText("One session, booked once.")).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByText("charged once for this session").filter({ visible: true }).first(),
      ).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText("One session", { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(page.getByLabel("Frequency")).toHaveCount(0);
      await expect(page.getByText(/After today, you pay/)).toHaveCount(0);
      await measure(page, "booking link, one session", w);
      await shot(page, "public-start-one-time", w);
    });

    test("the control: the same service as a repeating plan", async ({ page }) => {
      await openBookingLink(page, "recurring");
      await expect(
        page
          .getByText(/After today, you pay \$75\.00 per session/)
          .filter({ visible: true })
          .first(),
      ).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel("Frequency")).toBeVisible();
      await expect(page.getByText("One session, booked once.")).toHaveCount(0);
      await measure(page, "booking link, repeating", w);
      await shot(page, "public-start-recurring", w);
    });

    test("Settings sets how the link starts the service", async ({ page }) => {
      await installSignedInSession(page);
      await installStubBackend(page, { role: "owner", serviceLines: ["pet_waste", "training"] });
      const answers: Record<string, unknown> = {
        ensureTrainingCatalog: { ok: true },
        listServices: {
          services: [
            ...fx.SERVICES,
            {
              ...EVALUATION,
              organization_id: fx.ORG_ID,
              public_booking_mode: "one_time",
              public_package_id: null,
              active: true,
              created_at: "2026-10-01T00:00:00Z",
              updated_at: "2026-10-01T00:00:00Z",
            },
          ],
        },
        listServicePackages: { packages: [] },
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
      const row = page.locator("li", { hasText: "Evaluation (45 min)" });
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByText("Booking link: one visit")).toBeVisible();
      await row.getByRole("button", { name: "Edit" }).click();
      const dialog = page.getByRole("dialog");
      const control = dialog.getByRole("radiogroup", { name: "On your booking link" });
      await expect(control).toBeVisible();
      await expect(control.getByRole("radio", { name: "One visit" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      await expect(control.getByRole("radio", { name: "Package of sessions" })).toBeVisible();
      await expect(
        dialog.getByText("Clients pay once for one visit. Nothing repeats."),
      ).toBeVisible();
      await page.waitForTimeout(500);
      await measure(page, "settings, booking link mode", w);
      await shot(page, "settings-booking-mode", w);
    });
  });
}
