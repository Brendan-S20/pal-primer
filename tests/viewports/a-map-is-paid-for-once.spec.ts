/* eslint-disable @typescript-eslint/no-explicit-any -- stands in for, and reads back from, an untyped foreign API on `window`. */
/**
 * Google bills a map LOAD — each `new google.maps.Map` — and nothing for what
 * happens on a map afterwards. So the cost of moving every map to Google
 * (2026-10-02) is set almost entirely by one question: how often does the app
 * construct a map? This measures it, in a real browser, through the app's
 * real loader, components, data changes and client-side navigation.
 *
 * ── HOW IT REACHES THE GOOGLE PATH BEHIND THE FENCE ─────────────────────
 *
 * The sweeps draw maps with the Leaflet fallback: playwright.config.ts builds
 * with no key and the stub answers `getMapsBrowserKey` with null. Here the
 * stub is overridden to hand out a key, and the Maps script URL is answered
 * with tests/support/fake-google-maps.ts instead of Google's script. So the
 * app does everything it does in production — resolves a key from the server,
 * injects the script, waits for the callback, imports the libraries, builds
 * renderers and pools maps — and the only thing faked is Google itself, which
 * counts every map constructed.
 *
 * Nothing is sent to Google: the fence still turns back any other request to
 * a non-local host, and the key is a placeholder.
 *
 * ── WHAT THE NUMBERS MEAN ─────────────────────────────────────────────────
 *
 * The first test walks an office day — Schedule, three ranges, next and back,
 * Board and back to Map, the Dashboard, My Day's map toggled three times —
 * and asserts it costs ONE map load. The second walks the same day on the
 * Leaflet path, which builds a map per mount as every map here did before,
 * and records how many that is: the cost a straight port would have had.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import { installFakeGoogleMaps } from "../support/fake-google-maps";

const FAKE_SCRIPT =
  `(${installFakeGoogleMaps.toString()})(window);\n` +
  `(function () {\n` +
  `  var s = document.currentScript;\n` +
  `  var cb = s && new URL(s.src).searchParams.get("callback");\n` +
  `  if (cb && typeof window[cb] === "function") window[cb]();\n` +
  `})();`;

async function serveFakeGoogle(context: BrowserContext) {
  // Registered after the stub backend, so these win (Playwright matches the
  // most recently registered route first).
  await context.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      );
    } catch {
      /* not ours */
    }
    if (name.startsWith("getMapsBrowserKey")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result: { key: "placeholder-not-a-real-key" } }),
      });
    }
    return route.fallback();
  });
  await context.route("https://maps.googleapis.com/maps/api/js**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SCRIPT }),
  );
}

const loads = (page: Page) =>
  page.evaluate(() => (window as any).__fakeGoogleMaps?.maps ?? 0) as Promise<number>;
const scripts = (page: Page) =>
  page.evaluate(() => (window as any).__fakeGoogleMaps?.scripts ?? 0) as Promise<number>;

/** A map on screen, drawn by the Google path, with pins on it. */
async function googleMapWithPins(page: Page, pin = ".hs-map-marker.route-marker") {
  await expect(page.locator("[data-fake-google-map]").first()).toBeAttached({
    timeout: FIRST_PAINT_MS,
  });
  await expect(page.locator(pin).first()).toBeAttached({ timeout: FIRST_PAINT_MS });
  // Proved twice, the way the sweeps prove a surface rendered: the Google
  // path drew it, and the fallback did not.
  await expect(page.locator(".leaflet-container")).toHaveCount(0);
}

/** The same as above for the Leaflet fallback, which is what every map was
 *  before 2026-10-02. Counted by watching for containers Leaflet initialises,
 *  since Leaflet is bundled rather than global. */
async function leafletMapWithPins(page: Page) {
  await expect(page.locator(".leaflet-container").first()).toBeVisible({ timeout: FIRST_PAINT_MS });
  await expect(page.locator(".leaflet-marker-icon").first()).toBeAttached({
    timeout: FIRST_PAINT_MS,
  });
}

/** An office day: Schedule in three ranges, a day forward and back, Board
 *  and back to Map, then the Dashboard, then My Day's map toggled three
 *  times. Every step either changes the data on a map or mounts one. */
async function officeDay(page: Page, mapIsUp: (page: Page) => Promise<void>) {
  await page.goto("/routes");
  await mapIsUp(page);

  for (const r of ["Week", "Month", "Day"]) {
    await page.getByRole("button", { name: r, exact: true }).click();
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("button", { name: "Previous day" }).click();
  await mapIsUp(page);

  // Board hides the map and Map brings it back: an unmount and a mount.
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator("[data-fake-google-map], .leaflet-container")).toHaveCount(0);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await mapIsUp(page);

  // Client-side navigation to two more map screens.
  await page.getByRole("link", { name: "Dashboard", exact: true }).first().click();
  await expect(page).toHaveURL(/\/dashboard/);
  // The dashboard's map sits below the setup checklist, off the first
  // screen at 1280x900. Under Leaflet it was built anyway; now it waits to be
  // scrolled to, so the walk scrolls to it.
  await page
    .getByRole("link", { name: /Open routes/ })
    .first()
    .scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 300);
  await mapIsUp(page);

  await page.getByRole("link", { name: "My day", exact: true }).first().click();
  await expect(page).toHaveURL(/\/my-day/);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await mapIsUp(page);
    await page.getByRole("button", { name: "List", exact: true }).click();
  }
}

test("an office day on the schedule, dashboard and My Day costs one map load", async ({
  page,
  context,
}) => {
  await installSignedInSession(context, { "routes.viewMode": "map", "routes.range": "today" });
  await installStubBackend(context);
  await serveFakeGoogle(context);
  await page.setViewportSize({ width: 1280, height: 900 });

  await officeDay(page, (p) => googleMapWithPins(p));

  const total = await loads(page);
  test.info().annotations.push({ type: "google map loads", description: String(total) });
  expect(total, "map loads for the whole walk").toBe(1);
  // And the API itself was fetched once for the page lifetime.
  expect(await scripts(page)).toBe(1);
});

test("the same day built a map per screen and per toggle, which is what it would have cost", async ({
  page,
  context,
}) => {
  // The baseline for the number above, MEASURED rather than estimated: the
  // same walk on the Leaflet path, which builds a map on every mount — as
  // every map in the app did before the Google move, and as a straight port
  // to Google would have, at one billed load each.
  await page.addInitScript(() => {
    const seen = new WeakSet<Element>();
    (window as any).__leafletMaps = 0;
    new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as Element;
        if (el.classList?.contains("leaflet-container") && !seen.has(el)) {
          seen.add(el);
          (window as any).__leafletMaps++;
        }
      }
    }).observe(document, { attributes: true, attributeFilter: ["class"], subtree: true });
  });
  await installSignedInSession(context, { "routes.viewMode": "map", "routes.range": "today" });
  await installStubBackend(context);
  await page.setViewportSize({ width: 1280, height: 900 });

  await officeDay(page, leafletMapWithPins);

  const built = (await page.evaluate(() => (window as any).__leafletMaps)) as number;
  test.info().annotations.push({ type: "maps built per mount", description: String(built) });
  // At least six mounts on this walk — Schedule, Schedule again after Board,
  // the Dashboard, and My Day's map three times — and the range switches add
  // more: measured at 8 on 2026-10-01, against 1 for the Google path above.
  expect(built).toBeGreaterThanOrEqual(6);
});

test("a map that is hidden on a phone is never loaded", async ({ page, context }) => {
  await installSignedInSession(context);
  await installStubBackend(context);
  await serveFakeGoogle(context);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/dashboard");
  // The dashboard's route map is `max-md:hidden` until "Show map" is pressed.
  // It is still MOUNTED — under Leaflet it was built and drawn every time —
  // so this is the case "defer until on screen" exists for.
  const show = page.getByRole("button", { name: "Show map" });
  await expect(show).toBeVisible({ timeout: FIRST_PAINT_MS });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_000);
  expect(await loads(page), "a hidden map was loaded").toBe(0);

  await show.click();
  await googleMapWithPins(page);
  expect(await loads(page)).toBe(1);
});
