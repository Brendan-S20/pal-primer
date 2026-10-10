import { test, expect, type Page } from "@playwright/test";
import {
  WIDTHS,
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend, type SweepRole } from "./fixtures/stub-backend";

/**
 * A business that does not run pet waste, measured.
 *
 * organizations.service_lines (migration 20261008120000) hides the pet-waste
 * modules -- the waste log, the dump-site step, the Yard step, deep clean,
 * the re-clean guarantee -- from a dog walker, a sitter or a groomer. Every
 * other sweep runs as the stub org, which is a pet-waste business and says so
 * explicitly (stub-backend's getMyOrgFeatures.serviceLines). So without this
 * file the hidden branch -- a different tab in a tech's bar, a four-step
 * wizard, a different setup step -- would ship having never been drawn at
 * any width.
 *
 * CLAUDE.md: "A fixture of the wrong SHAPE measures the fallback, and looks
 * exactly as green as one of the right shape." Two guards follow from that:
 *
 *   * Every surface proves it is the HIDDEN branch by something only that
 *     branch draws ("Where does your day end?", "Step 1 of 4", a My schedule
 *     tab), not merely that the page rendered.
 *   * A CONTROL run, the same pages with service_lines {pet_waste}, proves the
 *     opposite on the same locators. If the stub's lines stopped reaching the
 *     app (a renamed field, a broken override), both runs would draw the pet-
 *     waste branch and the control would be the only one still green -- the
 *     dog-walking assertions are what go red.
 *
 * Runs with `npm run test:viewports:cases`. Locally on a loaded machine:
 *     npx playwright test a-business-that-does-not-scoop --workers=2
 */

const DOG_WALKING = ["dog_walking"];
const PET_WASTE = ["pet_waste"];

async function open(
  page: Page,
  role: SweepRole,
  lines: string[],
  path: string,
  width: number,
  height: number,
) {
  await page.setViewportSize({ width, height });
  await installSignedInSession(page);
  await installStubBackend(page, { role, serviceLines: lines });
  await page.goto(path, { waitUntil: "domcontentloaded" });
}

async function measure(page: Page, width: number, where: string) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
  const health = await page.evaluate(() => ({
    path: location.pathname,
    overlay: Boolean(document.querySelector("vite-error-overlay")),
    boundary: document.body.innerText.includes("Something went wrong"),
  }));
  expect(health.overlay, `${where}: Vite error overlay`).toBe(false);
  expect(health.boundary, `${where}: the router's error boundary, not the page`).toBe(false);

  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), where).toEqual([]);
  expect(await findSilentlyClippedText(page), where).toEqual([]);
  if (width < 768) expect(await findControlsUnder44px(page), where).toEqual([]);
}

/** On a phone the dashboard's setup checklist is folded to the NEXT step only
 *  (OnboardingChecklist's stepVisibility); "Show all N steps" opens the rest,
 *  as a person would. Wait for the card, then open it if it is folded. The
 *  click is retried until "Show less" appears, because a click before React
 *  has attached its handler does nothing. */
async function showAllSteps(page: Page) {
  await expect(page.getByTestId("onboarding-checklist")).toBeVisible({ timeout: 30_000 });
  const more = page.getByRole("button", { name: /^Show all \d+ steps/ });
  if ((await more.count()) === 0) return;
  await expect(async () => {
    if (await more.isVisible()) await more.click();
    await expect(page.getByRole("button", { name: /^Show less/ })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
}

/** Text in the DOM, hidden or not: the wizard's stepper names every step but
 *  shows only some of them at a given width. */
const allText = (page: Page) => page.evaluate(() => document.body.textContent ?? "");

for (const { w, h, label } of WIDTHS) {
  test.describe(`a dog-walking business, ${label}`, () => {
    test(`the setup checklist asks where the day ends, not for a dump site @${w}px`, async ({
      page,
    }) => {
      await open(page, "owner", DOG_WALKING, "/dashboard", w, h);
      await showAllSteps(page);
      await expect(page.getByText("Where does your day end?").first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("Add dump site")).toHaveCount(0);
      await measure(page, w, `/dashboard (dog walking) @${w}px`);
    });

    test(`/setup asks what the business runs, first in step 1 @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/setup?step=business", w, h);
      await expect(page.getByText("What do you run?").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("checkbox", { name: "Dog walking" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Pet waste removal" })).not.toBeChecked();
      // Not bookable yet: shown, marked, and not selectable.
      await expect(page.getByRole("checkbox", { name: "Pet sitting" })).toBeDisabled();
      await expect(page.getByText("Coming soon").first()).toBeVisible();
      await measure(page, w, `/setup step 1 (dog walking) @${w}px`);
    });

    test(`/setup's end-of-day step never mentions a dump site @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/setup?step=dump_site", w, h);
      await expect(page.getByRole("heading", { name: "Where does your day end?" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator("[data-setup-step=dump_site]")).toBeVisible();
      await expect(page.getByText(/dump site/i)).toHaveCount(0);
      await measure(page, w, `/setup end of day (dog walking) @${w}px`);
    });

    test(`the new-client wizard has no Outline step @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/clients/new", w, h);
      await expect(page.getByRole("heading", { name: /new client/i }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect.poll(() => allText(page), { timeout: 15_000 }).toContain("Step 1 of 4");
      // Exact: the stepper's own label, not the org's name ("…Yard and Waste
      // Services") in the header.
      await expect(page.getByText("Outline", { exact: true })).toHaveCount(0);
      await measure(page, w, `/clients/new (dog walking) @${w}px`);
    });

    test(`Settings → Business defaults says what the business runs @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/settings/business", w, h);
      await expect(page.getByText("What do you run?").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("checkbox", { name: "Dog walking" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Pet waste removal" })).not.toBeChecked();
      // A re-clean is a pet-waste promise: no guarantee card for this business.
      await expect(page.getByText("Re-clean guarantee")).toHaveCount(0);
      // The rail is drawn from md up; Deep clean is not in it.
      if (w >= 768) {
        const rail = page.getByRole("navigation", { name: "Settings sections" });
        await expect(rail.getByRole("link", { name: "Business defaults" })).toBeVisible();
        await expect(rail.getByRole("link", { name: "Deep clean" })).toHaveCount(0);
      }
      await measure(page, w, `/settings/business (dog walking) @${w}px`);
    });

    test(`a tech's navigation has My schedule where the waste log was @${w}px`, async ({
      page,
    }) => {
      await open(page, "tech", DOG_WALKING, "/my-day", w, h);
      // The tab bar below lg for a tech (useTabletTier), the sidebar from lg
      // up; whichever is on screen has My schedule, and nothing anywhere links
      // to the waste log.
      await expect(
        page.getByRole("link", { name: "My schedule" }).locator("visible=true").first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(page.getByRole("link", { name: "Waste log" })).toHaveCount(0);
      await measure(page, w, `/my-day as a tech (dog walking) @${w}px`);
    });
  });
}

// ── THE CONTROL ────────────────────────────────────────────────────────────
// The same locators against a pet-waste business, at a phone and a laptop.
// Not measured again (every other sweep measures this branch); only proved to
// be the other branch, so the dog-walking run above cannot pass by drawing
// the same page.
for (const { w, h, label } of WIDTHS.filter((s) => s.w === 360 || s.w === 1280)) {
  test.describe(`control: a pet-waste business, ${label}`, () => {
    test(`asks for the dump site @${w}px`, async ({ page }) => {
      await open(page, "owner", PET_WASTE, "/dashboard", w, h);
      await showAllSteps(page);
      await expect(page.getByText("Add dump site").first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Where does your day end?")).toHaveCount(0);
    });

    test(`/setup's end-of-day step asks for the dump site @${w}px`, async ({ page }) => {
      await open(page, "owner", PET_WASTE, "/setup?step=dump_site", w, h);
      await expect(page.getByLabel("Dump site address")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("Where does your day end?")).toHaveCount(0);
    });

    test(`has the Outline step @${w}px`, async ({ page }) => {
      await open(page, "owner", PET_WASTE, "/clients/new", w, h);
      await expect.poll(() => allText(page), { timeout: 30_000 }).toContain("Step 1 of 5");
      await expect(page.getByText("Outline", { exact: true }).first()).toBeAttached();
    });

    test(`keeps the waste log in a tech's navigation @${w}px`, async ({ page }) => {
      await open(page, "tech", PET_WASTE, "/my-day", w, h);
      await expect(
        page.getByRole("link", { name: "Waste log" }).locator("visible=true").first(),
      ).toBeVisible({ timeout: 30_000 });
    });
  });
}
