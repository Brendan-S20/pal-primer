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
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

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

import * as groomingFx from "./fixtures/dataset";

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
 *  has attached its handler does nothing.
 *
 *  The card is the first thing each dashboard test waits for, so it gets the
 *  first-paint ceiling (fixtures/first-paint.ts), not 30s. On 2026-10-31 the
 *  360px case ran in the first wave of eight workers against a cold dev
 *  server and failed twice with the page still on the shell's "Loading…";
 *  every other test in that wave took 35 to 45s, and the same case passes in
 *  9s once the server is warm. */
async function showAllSteps(page: Page) {
  await expect(page.getByTestId("onboarding-checklist")).toBeVisible({ timeout: FIRST_PAINT_MS });
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

/** ServiceLinesChoices, as /setup step 1 and Settings → Business defaults both
 *  draw it for a dog-walking business. Pet waste, walking (#530), sitting
 *  (#547), training (#548) and mobile grooming (#549) are all bookable, so no
 *  line carries a Coming soon badge and every one can be ticked, on /setup as
 *  in Settings and in Settings → Services. */
async function expectServiceLineChoices(page: Page) {
  await expect(page.getByText("Which services do you offer?").first()).toBeVisible({
    timeout: FIRST_PAINT_MS,
  });
  const walking = page.getByRole("checkbox", { name: /^Dog walking/ });
  await expect(walking).toBeChecked();
  await expect(page.locator("li").filter({ has: walking }).getByText("Coming soon")).toHaveCount(0);
  const petWaste = page.getByRole("checkbox", {
    name: "Pet waste removal (scooping)",
    exact: true,
  });
  await expect(petWaste).not.toBeChecked();
  await expect(petWaste).toBeEnabled();
  const sitting = page.getByRole("checkbox", { name: /^Pet sitting/ });
  await expect(sitting).not.toBeChecked();
  await expect(sitting).toBeEnabled();
  await expect(page.locator("li").filter({ has: sitting }).getByText("Coming soon")).toHaveCount(0);
  const grooming = page.getByRole("checkbox", { name: /^Mobile grooming/ });
  await expect(grooming).not.toBeChecked();
  await expect(grooming).toBeEnabled();
  await expect(page.locator("li").filter({ has: grooming }).getByText("Coming soon")).toHaveCount(
    0,
  );
  const training = page.getByRole("checkbox", { name: /^Dog training/ });
  await expect(training).not.toBeChecked();
  await expect(training).toBeEnabled();
  await expect(page.locator("li").filter({ has: training }).getByText("Coming soon")).toHaveCount(
    0,
  );
}

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
      await expectServiceLineChoices(page);
      await measure(page, w, `/setup step 1 (dog walking) @${w}px`);
    });

    test(`/setup's end-of-day step never mentions a dump site @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/setup?step=dump_site", w, h);
      await expect(page.getByRole("heading", { name: "Where does your day end?" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.locator("[data-setup-step=dump_site]")).toBeVisible();
      await expect(page.getByText(/dump site/i)).toHaveCount(0);
      await measure(page, w, `/setup end of day (dog walking) @${w}px`);
    });

    test(`/setup step 1 says routes, not trucks, and shows the workday @${w}px`, async ({
      page,
    }) => {
      // #768 and #769: the address help named trucks, and the 08:00-17:00
      // workday every arrival window is computed from was never shown.
      await open(page, "owner", DOG_WALKING, "/setup?step=business", w, h);
      await expectServiceLineChoices(page);
      await expect(page.getByText(/trucks/i)).toHaveCount(0);
      await expect(page.getByText("Where routes start each day", { exact: false })).toBeVisible();
      // What is STORED, not the column default: the stub's org starts at
      // 07:30, and a form that showed 08:00 here would be the silent default.
      await expect(page.getByLabel("Starts")).toHaveValue("07:30");
      await expect(page.getByLabel("Ends")).toHaveValue("17:00");
      await measure(page, w, `/setup step 1 (dog walking) @${w}px`);
    });

    test(`/setup prices the walks in place, the drop-in optional @${w}px`, async ({ page }) => {
      // #769: the step was a button to Settings, Services.
      await open(page, "owner", DOG_WALKING, "/setup?step=zones", w, h);
      await expect(page.getByRole("heading", { name: "Price your walks" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByLabel(/^30-minute walk \(\$\)$/)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByLabel(/^60-minute walk \(\$\)$/)).toBeVisible();
      await expect(page.getByLabel(/^Drop-in visit \(20 min\) \(\$\), optional$/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Price walks" })).toHaveCount(0);
      await expect(page.getByText(/dump|trucks|yard/i)).toHaveCount(0);
      await measure(page, w, `/setup prices (dog walking) @${w}px`);
    });

    test(`the new-client wizard has no Outline step @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/clients/new", w, h);
      await expect(page.getByRole("heading", { name: /new client/i }).first()).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect.poll(() => allText(page), { timeout: 15_000 }).toContain("Step 1 of 4");
      // Exact: the stepper's own label, not the org's name ("…Yard and Waste
      // Services") in the header.
      await expect(page.getByText("Outline", { exact: true })).toHaveCount(0);
      await measure(page, w, `/clients/new (dog walking) @${w}px`);
    });

    test(`Settings → Business defaults says what the business runs @${w}px`, async ({ page }) => {
      await open(page, "owner", DOG_WALKING, "/settings/business", w, h);
      await expectServiceLineChoices(page);
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
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
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
      await expect(page.getByLabel("Dump site address")).toBeVisible({ timeout: FIRST_PAINT_MS });
      await expect(page.getByText("Where does your day end?")).toHaveCount(0);
    });

    test(`has the Outline step @${w}px`, async ({ page }) => {
      await open(page, "owner", PET_WASTE, "/clients/new", w, h);
      await expect.poll(() => allText(page), { timeout: FIRST_PAINT_MS }).toContain("Step 1 of 5");
      await expect(page.getByText("Outline", { exact: true }).first()).toBeAttached();
    });

    test(`keeps the waste log in a tech's navigation @${w}px`, async ({ page }) => {
      await open(page, "tech", PET_WASTE, "/my-day", w, h);
      await expect(
        page.getByRole("link", { name: "Waste log" }).locator("visible=true").first(),
      ).toBeVisible({ timeout: FIRST_PAINT_MS });
    });
  });
}

for (const w of [390, 820, 1024, 1440]) {
  test(`grooming setup keeps its travel buffer and request inbox @${w}px`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: w, height: 1000 });
    await installSignedInSession(page);
    await installStubBackend(page, { role: "owner", serviceLines: ["mobile_grooming"] });
    const billed: string[] = [];
    await page.route("**/_serverFn/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
      let name = "";
      try {
        name = String(
          JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
        ).replace(/_createServerFn_handler$/, "");
      } catch {
        /* Other fixture routes handle unknown calls. */
      }
      if (name === "listAddonServices")
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              services: [
                {
                  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                  name: "Matting",
                  unit_price_cents: 2500,
                  service_line: "mobile_grooming",
                  active: true,
                },
              ],
            },
          }),
        });
      if (name === "createAddonCharge") {
        billed.push(route.request().postData() ?? "");
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ result: { ok: true } }),
        });
      }
      if (name === "getMyDay") {
        const v = groomingFx
          .visitsBetween(groomingFx.TODAY, groomingFx.TODAY)
          .find((row) => row.assigned_staff_id === groomingFx.STAFF[0].id)!;
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: {
              staff: { ...groomingFx.STAFF[0], organization_id: groomingFx.ORG_ID },
              previewing: false,
              visits: [
                {
                  ...v,
                  organization_id: groomingFx.ORG_ID,
                  status: "in_progress",
                  started_at: new Date(Date.now() - 600000).toISOString(),
                  completed_at: null,
                  services: { name: "Full groom", service_line: "mobile_grooming" },
                  properties: {
                    ...(v.properties as object),
                    account_type: "residential",
                    has_units: false,
                    dogs: [{ id: "dog-groom", name: "Biscuit", temperament: "friendly" }],
                  },
                  groom_pets: [],
                  visit_photos: [],
                  visit_checklist: null,
                  gate_reply: null,
                },
              ],
            },
          }),
        });
      }
      if (name === "getVaccineSettings") {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            result: { enabled: true, rule: "warn", required: ["rabies"], bufferMin: 30 },
          }),
        });
      }
      return route.fallback();
    });
    await page.goto("/settings/services", { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Setup, cleanup and travel minutes")).toHaveValue("30", {
      timeout: 90_000,
    });
    if (w >= 768)
      await expect(page.getByRole("link", { name: "Requests", exact: true }).first()).toBeVisible();
    await measure(page, w, `grooming setup ${w}`);
    await page.screenshot({ path: `test-results/grooming-setup-${w}.png`, fullPage: true });
    await page.goto("/my-day", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Full groom").first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "More options", exact: true }).first().click();
    await page
      .getByRole("button", { name: /\+ Add.on/ })
      .first()
      .click();
    await page
      .getByLabel("Select service…")
      .first()
      .selectOption("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    await page.getByRole("button", { name: "Bill", exact: true }).first().click();
    await expect(page.getByRole("alertdialog")).toContainText("$25.00");
    await page.screenshot({ path: `test-results/grooming-matting-${w}.png`, fullPage: true });
    await page.getByRole("button", { name: "Bill it", exact: true }).click();
    await expect.poll(() => billed.length).toBe(1);
    expect(billed[0]).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
}

// #768/#769: a business that scoops AND walks. The dump site and the yard are
// the pet-waste half of each step, not the whole of it, and the walks are
// priced beside the area.
const MIXED = ["pet_waste", "dog_walking"];

for (const { w, h, label } of WIDTHS) {
  test.describe(`a business that scoops and walks, ${label}`, () => {
    test(`/setup's end-of-day step asks where the day ends, the dump site under pet waste @${w}px`, async ({
      page,
    }) => {
      await open(page, "owner", MIXED, "/setup?step=dump_site", w, h);
      await expect(page.getByRole("heading", { name: "Where does your day end?" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByText(/crew unloads/i)).toHaveCount(0);
      const petWasteHalf = page.locator("[data-setup-pet-waste-day-end]");
      await expect(petWasteHalf.getByText("For your pet waste routes")).toBeVisible();
      await expect(petWasteHalf.getByRole("button", { name: "Add dump site" })).toBeVisible();
      await measure(page, w, `/setup end of day (scoops and walks) @${w}px`);
    });

    test(`/setup's price step prices walks and the pet waste area in place @${w}px`, async ({
      page,
    }) => {
      await open(page, "owner", MIXED, "/setup?step=zones", w, h);
      await expect(page.getByRole("heading", { name: "Price your services" })).toBeVisible({
        timeout: FIRST_PAINT_MS,
      });
      await expect(page.getByText(/pet waste visits and walks/)).toBeVisible();
      await expect(page.getByText(/pet waste zones/i)).toHaveCount(0);
      const walks = page.locator('[data-setup-price-form="walks"]');
      await expect(walks.getByLabel(/^30-minute walk \(\$\)$/)).toBeVisible({ timeout: 15_000 });
      await expect(walks.getByLabel(/^60-minute walk \(\$\)$/)).toBeVisible();
      await expect(page.locator('[data-setup-price-form="area"]')).toBeVisible();
      await expect(page.getByRole("link", { name: "Price walks" })).toHaveCount(0);
      await measure(page, w, `/setup prices (scoops and walks) @${w}px`);
    });
  });
}
