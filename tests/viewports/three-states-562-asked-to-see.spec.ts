/**
 * The three states #562 changed, at four widths, in a real browser.
 *
 * Product's review of #562 found "Four real widths in a real browser" SKIPPED
 * on the PR's head: the sweeps open each page in its resting state, and none
 * of these three is a resting state.
 *
 *   - The client Visits tab's popup on a COMPLETED visit, which now draws
 *     CompletedVisitActions (Reopen, Mark missed) (#532), and the confirm it
 *     asks before Reopen, which states the billing consequence.
 *   - My schedule when the load fails (#536): with no copy ("couldn't load"
 *     with Retry), and with a copy and the network gone (the saved-copy
 *     banner with its age and Retry).
 *   - The weather popover's list of zones with no forecast (#455): one zone
 *     with no location, one the weather service did not answer, a name long
 *     enough to wrap, and Retry because a service error is in the list.
 *
 * Each state is proved on screen by its own words before anything is
 * measured, for the reason settle() gives: every rule below passes on a page
 * that never drew the thing. A screenshot of each lands in
 * docs/evidence/562/ when SHOTS=1, so a reviewer can look without running it.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { CLIENT_ID } from "./fixtures/dataset";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
  findControlsNarrowerThanTheirLabel,
} from "./rules";

const WIDTHS = [360, 768, 1280, 1920];
const SHOTS = join(process.cwd(), "docs/evidence/562");

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
  if (process.env.SHOTS) {
    mkdirSync(SHOTS, { recursive: true });
    await page.screenshot({ path: join(SHOTS, `${label}-${width}.png`) });
  }
}

/** Answer one server function with a 500, ahead of the stub backend. */
async function failServerFn(page: Page, name: string) {
  await page.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let exported = "";
    try {
      exported = JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export;
    } catch {
      /* not ours */
    }
    if (exported === `${name}_createServerFn_handler`) {
      return route.fulfill({ status: 500, contentType: "text/plain", body: "boom" });
    }
    return route.fallback();
  });
}

const FAILED_ZONES = [
  {
    id: "z-ok",
    name: "Southgate",
    postal_prefix: "481",
    latitude: 42.2,
    longitude: -83.2,
    status: "ok",
    error: null,
    stale: false,
    days: [],
  },
  {
    id: "z-no-coords",
    name: "Grosse Pointe Woods & Harper Woods (east of Mack Avenue)",
    postal_prefix: null,
    latitude: null,
    longitude: null,
    status: "no_coords",
    error: null,
    stale: false,
    days: [],
  },
  {
    id: "z-error",
    name: "Downriver - Taylor",
    postal_prefix: "481",
    latitude: 42.24,
    longitude: -83.27,
    status: "error",
    error: "The weather service is busy. Try again in a minute.",
    stale: false,
    days: [],
  },
];

for (const width of WIDTHS) {
  test.describe(`#562 states at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, isMobile: width < 768, deviceScaleFactor: 2 });

    test("Visits tab: a completed visit's popup and its Reopen confirm", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await page.goto(`/clients/${CLIENT_ID}`, { waitUntil: "domcontentloaded" });
      const tab = page.getByRole("tab", { name: "Visits", exact: true }).first();
      await expect(tab).toBeVisible({ timeout: 30_000 });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");

      const row = page
        .getByRole("row")
        .filter({ has: page.getByRole("cell", { name: "completed", exact: true }) })
        .first();
      await row.getByRole("button", { name: /^View visit/ }).click();
      const reopen = page.getByRole("button", { name: /Reopen/ }).first();
      await expect(reopen).toBeVisible({ timeout: 15_000 });
      await expect(page.getByRole("button", { name: /Mark missed/ }).first()).toBeVisible();
      await page.waitForTimeout(400);
      await measure(page, "visits-completed-popup", width);

      await reopen.click();
      await expect(page.getByText("Reopen this visit?")).toBeVisible();
      await expect(page.getByText(/not billed unless it is completed again/)).toBeVisible();
      await page.waitForTimeout(300);
      await measure(page, "visits-reopen-confirm", width);
    });

    test("My schedule: failed with no copy", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await failServerFn(page, "getMyUpcomingDays");
      await page.goto("/my-schedule", { waitUntil: "domcontentloaded" });
      await expect(page.getByText(/Your schedule couldn't load/)).toBeVisible({ timeout: 45_000 });
      await expect(page.getByRole("alert").getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.getByText(/no visits assigned/i)).toHaveCount(0);
      await measure(page, "my-schedule-no-copy", width);
    });

    test("My schedule: offline with a saved copy", async ({ page, context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await page.goto("/my-schedule", { waitUntil: "domcontentloaded" });
      // The fixture's own day, so the copy is the stub's and not an empty week.
      await expect(page.getByText("Southgate").first()).toBeVisible({ timeout: 30_000 });
      await context.setOffline(true);
      await expect(page.getByText(/Offline: saved copy/)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("Southgate").first()).toBeVisible();
      await measure(page, "my-schedule-offline-saved-copy", width);
      await context.setOffline(false);
    });

    test("Weather popover: zones with no forecast, each with its reason", async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context, {
        overrides: { getWeatherForZones: { zones: FAILED_ZONES, enabled: true } },
      });
      await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
      const trigger = page.getByRole("button", { name: "Weather forecast" });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await trigger.click();
      await expect(page.getByText(/no location set\. Add one in Zones/)).toBeVisible({
        timeout: 15_000,
      });
      await expect(
        page.getByText("The weather service is busy. Try again in a minute."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry Downriver - Taylor" })).toBeVisible();
      await page.waitForTimeout(300);
      await measure(page, "weather-failed-zones", width);

      // Per-zone retry: the stub answers the same failure again, so the
      // zone's own line has to say the retry ran and failed.
      await page.getByRole("button", { name: "Retry Downriver - Taylor" }).click();
      await expect(page.getByText(/Tried again; still no answer\./)).toBeVisible({
        timeout: 15_000,
      });
      await page.waitForTimeout(300);
      await measure(page, "weather-zone-retried", width);
    });
  });
}
