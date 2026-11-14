/**
 * The coverage banner has to REACH THE SCREEN.
 *
 * `every-signed-in-page-at-every-width.spec.ts` measures /zones and would stay
 * green with this banner deleted: its assertions are all of the form "nothing
 * is wrong", and a page missing a warning has nothing wrong with its layout.
 * The surface's own proof locator and fixture string predate this banner and
 * say nothing about it.
 *
 * So this asserts the opposite shape: that the sentence is visible, and that
 * it does not run off the side at the narrow end -- a banner is a long line of
 * prose with a zone name in it, which is the exact thing that overflows 360px.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  findControlsOffTheSide,
  findControlsUnder44px,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";

for (const w of [360, 1280]) {
  test(`the coverage banner is on screen at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/settings/zones");

    // ── WHY THIS WAIT, AND WHY IT IS NOT A RETRY ──────────────────────────
    //
    // The banner is drawn from getZoneCoverage(), a server function. On a cold
    // dev server the FIRST call to one pays for its on-demand transform, and
    // that cost lands entirely on whichever test navigates first -- the same
    // cold-start effect playwright.config.ts documents for the 90s test
    // ceiling, one layer further in.
    //
    // Measured, not assumed. Against a freshly started server this file's
    // 1280px case -- the one that PASSES -- took 15.1s, against an assertion
    // ceiling of 15s. It was never comfortably green; it was winning a coin
    // toss. The 360px case is first in the loop, so it paid the cost and lost,
    // while 1280px ran second on a warm server and took 3.5s. That is the
    // whole of the difference between them, and it is why this looked like a
    // width-dependent layout fault and is not one: at 360px the banner renders
    // correctly, it simply had not arrived yet.
    //
    // So wait for the navigation to go quiet BEFORE the assertion opens its
    // budget, which is exactly what settle() does in
    // every-signed-in-page-at-every-width.spec.ts and why the big sweeps do
    // not flake here. The 15s ceiling then measures what it was written to
    // measure -- whether the banner is on screen -- rather than how warm the
    // server was. A banner that is genuinely missing still fails, and still
    // fails in the same place.
    await page.waitForLoadState("networkidle").catch(() => {});

    const banner = page.getByText("still carry a zone the rules would no longer give them", {
      exact: false,
    });
    await expect(banner.first()).toBeVisible({ timeout: 15000 });
    const box = await banner.first().boundingBox();
    expect(box, "banner has no box").not.toBeNull();
    expect(box!.x + box!.width, "banner runs off the side").toBeLessThanOrEqual(w + 1);

    // The remedy has to be reachable too. A warning whose button is off the
    // side of a phone is the same dead end the banner was added to fix, and
    // 44px is the floor CLAUDE.md sets for anything a thumb has to hit.
    const button = page.getByRole("button", { name: "Re-run zone detection" });
    await expect(button, "the remedy button is not on screen").toBeVisible({
      timeout: 15000,
    });
    const bb = await button.boundingBox();
    expect(bb, "button has no box").not.toBeNull();
    expect(bb!.x + bb!.width, "button runs off the side").toBeLessThanOrEqual(w + 1);
    expect(bb!.height, "button is under the 44px touch floor").toBeGreaterThanOrEqual(44);
  });
}

// ── THE ZONE LIST AT EVERY WIDTH (#450) ───────────────────────────────────
//
// Here rather than in a file of its own so the step that already runs this
// file runs it (the-sweeps-are-not-the-whole-suite.test.ts).
//
// The shared fixture has one zone with a prefix and nothing else, which is
// the tidiest list the page can draw. The owner's demo has eight: polygons,
// overlapping circles, one large ZIP zone. So this answers listZones with
// eight awkward ones: a 46-character name, a zone that is off, a ZIP list of
// 31, two zones that both list 48229, the "Michigan" chip the live database
// had, and a drawn circle with no ZIPs. Then it measures the rows at the four
// widths CLAUDE.md names and checks what the redesign promised: compact rows,
// ZIPs folded into a count, warnings never folded, search and filters, the
// map beside the list from lg and behind a toggle below it.

const LONG = "Grosse Pointe Woods, Harper Woods and Eastpointe";
const BIG_ZIPS = Array.from({ length: 31 }, (_, i) => String(48301 + i));
const ring = (lng: number, lat: number, d = 0.03) => ({
  type: "Polygon",
  coordinates: [
    [
      [lng - d, lat - d],
      [lng + d, lat - d],
      [lng + d, lat + d],
      [lng - d, lat + d],
      [lng - d, lat - d],
    ],
  ],
});
const zone = (id: number, z: Record<string, unknown>) => ({
  id: `zzzz4500-0000-4000-8000-${String(id).padStart(12, "0")}`,
  zip_codes: [],
  geo_match_mode: "zip",
  enabled: true,
  priority: 0,
  active_clients: 0,
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  pricing_mode: "flat",
  latitude: null,
  longitude: null,
  center_latitude: null,
  center_longitude: null,
  radius_meters: null,
  drive_time_minutes: null,
  boundary: null,
  ...z,
});
const EIGHT_ZONES = {
  activeClientsKnown: true,
  zones: [
    zone(1, {
      name: LONG,
      geo_match_mode: "polygon",
      boundary: ring(-82.92, 42.45),
      zip_codes: ["48236", "48225", "48021"],
      active_clients: 41,
      base_price_cents: 3200,
    }),
    zone(2, {
      name: "Detroit core",
      zip_codes: BIG_ZIPS,
      active_clients: 87,
      base_price_cents: 2200,
    }),
    zone(3, {
      name: "Dearborn circle",
      geo_match_mode: "radius",
      center_latitude: 42.32,
      center_longitude: -83.18,
      radius_meters: 8000,
      zip_codes: ["48124", "48126", "48128", "48229"],
      active_clients: 12,
    }),
    zone(4, {
      name: "Ecorse circle",
      geo_match_mode: "radius",
      center_latitude: 42.25,
      center_longitude: -83.15,
      radius_meters: 6000,
      zip_codes: ["48229", "48218", "48122"],
      priority: 2,
      active_clients: 5,
    }),
    zone(5, { name: "Southgate", zip_codes: ["Michigan"], active_clients: 0 }),
    zone(6, {
      name: "Royal Oak drive",
      geo_match_mode: "drive_time",
      center_latitude: 42.49,
      center_longitude: -83.14,
      drive_time_minutes: 15,
      zip_codes: [],
      active_clients: 3,
    }),
    zone(7, {
      name: "Livonia (paused)",
      enabled: false,
      geo_match_mode: "polygon",
      boundary: ring(-83.37, 42.39),
      zip_codes: ["48150", "48152", "48154"],
      active_clients: 9,
    }),
    zone(8, {
      name: "Warren north",
      geo_match_mode: "polygon",
      boundary: ring(-83.03, 42.51),
      zip_codes: ["48088", "48089", "48091", "48092"],
      active_clients: 22,
      base_price_cents: 2700,
    }),
  ],
};

async function openEightZones(page: import("@playwright/test").Page, w: number) {
  await installSignedInSession(page.context());
  await installStubBackend(page.context(), { overrides: { listZones: EIGHT_ZONES } });
  await page.setViewportSize({ width: w, height: 900 });
  await page.goto("/settings/zones");
  await page.waitForLoadState("networkidle").catch(() => {});
  // Proof the fixture reached the page, not the one-zone default.
  await expect(page.getByRole("heading", { name: LONG })).toBeVisible({ timeout: 15000 });
}

async function expectNothingOffTheSide(
  page: import("@playwright/test").Page,
  w: number,
  when: string,
) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `the page scrolls sideways at ${w}px ${when}`).toBeLessThanOrEqual(innerW + 1);
  expect(await findControlsOffTheSide(page), `controls off the side at ${w}px ${when}`).toEqual([]);
  expect(await findSilentlyClippedText(page), `text clipped at ${w}px ${when}`).toEqual([]);
  if (w < 768) {
    expect(await findControlsUnder44px(page), `controls under 44px at ${w}px ${when}`).toEqual([]);
  }
}

for (const w of [360, 768, 1280, 1920]) {
  test(`eight zones read as a list at ${w}px`, async ({ page }) => {
    await openEightZones(page, w);
    const rows = page.getByTestId("zone-row");
    await expect(rows).toHaveCount(8);
    await expect(page.getByTestId("zones-count")).toHaveText("8 zones");

    // Each row's facts line: shape, clients, and the base price.
    const core = rows.filter({ has: page.getByRole("heading", { name: "Detroit core" }) });
    await expect(core).toContainText("ZIP list");
    await expect(core).toContainText("87 active clients");
    await expect(core).toContainText("$22.00");
    await expect(
      rows.filter({ has: page.getByRole("heading", { name: "Dearborn circle" }) }),
    ).toContainText("Radius, 5.0 mi");

    // 31 ZIPs fold into a count, and open on demand.
    const zipToggle = core.getByRole("button", { name: "31 ZIPs" });
    await expect(zipToggle).toHaveAttribute("aria-expanded", "false");
    await expect(core.getByText("48301", { exact: true })).toHaveCount(0);

    // What needs the owner is never folded: the broken chip and its sentence,
    // the shared ZIP and who wins it, the drawn zone the signup page cannot quote.
    const southgate = rows.filter({ has: page.getByRole("heading", { name: "Southgate" }) });
    await expect(southgate.getByText("Michigan", { exact: true })).toBeVisible();
    await expect(southgate).toContainText("is not a US 5-digit ZIP and matches no address.");
    await expect(
      page.getByText("48229 is also in Ecorse circle, which ranks higher and wins."),
    ).toBeVisible();
    await expect(
      page.getByText("No ZIPs listed, so the signup page and lead form can't quote this area."),
    ).toBeVisible();

    // The map: beside the list from lg, behind a toggle below it.
    const mapPanel = page.getByTestId("zones-map-panel");
    if (w >= 1024) {
      await expect(mapPanel).toBeVisible();
      const listBox = await rows.first().boundingBox();
      const mapBox = await mapPanel.boundingBox();
      expect(mapBox!.x, "the map is not beside the list").toBeGreaterThan(
        listBox!.x + listBox!.width - 1,
      );
    } else {
      await expect(mapPanel).toBeHidden();
      await page.getByRole("button", { name: "Show map" }).click();
      await expect(mapPanel).toBeVisible();
      await page.getByRole("button", { name: "Hide map" }).click();
    }

    await expectNothingOffTheSide(page, w, "with the ZIPs folded");
    await zipToggle.click();
    await expect(zipToggle).toHaveAttribute("aria-expanded", "true");
    await expect(core.getByText("48301", { exact: true })).toBeVisible();
    await expect(core.getByText("+19 more")).toBeVisible();
    await expectNothingOffTheSide(page, w, "with 31 ZIPs open");
  });
}

test("search, filter and sort narrow the list, and the row menu holds edit", async ({ page }) => {
  await openEightZones(page, 360);
  const rows = page.getByTestId("zone-row");

  // A ZIP finds the zones that list it.
  await page.getByLabel("Search zones").fill("48229");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("zones-count")).toHaveText("2 of 8 zones");
  await page.getByLabel("Search zones").fill("no such zone");
  await expect(rows).toHaveCount(0);
  await page.getByRole("button", { name: "Clear search and filters" }).click();
  await expect(rows).toHaveCount(8);

  await page.getByLabel("Filter by status").click();
  await page.getByRole("option", { name: "Off only" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Livonia (paused)");
  await page.getByLabel("Filter by status").click();
  await page.getByRole("option", { name: "On and off" }).click();

  await page.getByLabel("Filter by shape").click();
  await page.getByRole("option", { name: "Polygon" }).click();
  await expect(rows).toHaveCount(3);
  await page.getByLabel("Filter by shape").click();
  await page.getByRole("option", { name: "All shapes" }).click();

  await page.getByLabel("Sort zones").click();
  await page.getByRole("option", { name: "Sort: Most clients" }).click();
  await expect(rows.first()).toContainText("Detroit core");

  // Edit moved into the row menu; it still opens the drawer.
  await page.getByRole("button", { name: "More actions for Detroit core" }).click();
  await page.getByRole("menuitem", { name: "Edit zone" }).click();
  await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15000 });
});
