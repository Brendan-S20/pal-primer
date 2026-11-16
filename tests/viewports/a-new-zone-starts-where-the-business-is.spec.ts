/**
 * Zones > New zone, for a business that has just been through setup (#914).
 *
 * Driven the way the onboarding QA run drove it: New zone, a click on the map
 * to place a one-mile circle by the business, Create zone, and a look at the
 * list. The backend is the shared stub with five answers made for this:
 *
 *   - getStandardPricing: the business's standard price is $20 + $5;
 *   - getNewZoneCenter: the business is in Lansing, ZIP 48933;
 *   - zipsInZoneShape: no ZIP's center is inside the circle, and the ZIP at
 *     its middle is 48912 -- the QA circle, where 48933 had to be typed;
 *   - createZone / listZones: a list that grows when a zone is created, whose
 *     REFETCH takes 15 seconds. The assertion that the new zone is on screen
 *     runs well inside that, so it can only pass on the cache write Create
 *     makes, not on the refetch.
 *
 * And a second case: no standard price at all, with $20 / $5 still in setup's
 * draft on this device (setup's save failed, #881).
 *
 * At 390 and 1440 it asserts what the owner sees, measures the page for
 * horizontal overflow, and, with SHOTS_DIR set, writes the screenshots the PR
 * shows. SHOTS_ONLY=1 takes the screenshots without the assertions, which is
 * how the BEFORE set was taken on main.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession, SWEEP_USER_ID } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { ORG_ID } from "./fixtures/dataset";
import { measurePageOverflow } from "./rules";

const SHOTS_DIR = process.env.SHOTS_DIR;
const SHOTS_ONLY = process.env.SHOTS_ONLY === "1";
const check = (fn: () => Promise<void>) => (SHOTS_ONLY ? Promise.resolve() : fn());

const LANSING = { lat: 42.7144, lng: -84.5562 };
const EXISTING_ZONE = {
  id: "zzzz1111-0000-4000-8000-000000000001",
  name: "Ravenswood Manor / Lincoln Square North",
  priority: 1,
  zip_codes: ["60625"],
  geo_match_mode: "zip",
  enabled: true,
  base_price_cents: null,
  per_dog_addl_cents: null,
  active_clients: 3,
};

function serverFnName(url: string): string {
  const id = new URL(url).pathname.split("/_serverFn/")[1] ?? "";
  try {
    return String(
      JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
    ).replace(/_createServerFn_handler$/, "");
  } catch {
    return "";
  }
}

async function installNewZoneBackend(
  page: Page,
  opts: { standardCents: number | null },
): Promise<{ created: Array<Record<string, any>> }> {
  const created: Array<Record<string, any>> = [];
  let listReads = 0;
  await page.context().route("**/_serverFn/**", async (route) => {
    const name = serverFnName(route.request().url());
    const reply = (result: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result }),
      });
    if (name === "getStandardPricing") {
      return reply({
        basePriceCents: opts.standardCents,
        perDogAddlCents: opts.standardCents == null ? null : 500,
        serviceId: null,
        serviceName: "Pet waste removal",
        frequencyMultipliers: { weekly: 1, biweekly: 1.7, twice_weekly: 1.8, monthly: 3.2 },
      });
    }
    if (name === "getNewZoneCenter") return reply({ ...LANSING, zip: "48933" });
    if (name === "zipsInZoneShape") {
      return reply({
        inside: [],
        insideTotal: 0,
        edge: ["48915", "48917"],
        candidatesCapped: false,
        tooLarge: false,
        centerZip: "48912",
      });
    }
    if (name === "createZone") {
      const zone = {
        id: "zzzz1111-0000-4000-8000-0000000000aa",
        name: "Lansing",
        priority: 0,
        zip_codes: ["48912", "48933"],
        geo_match_mode: "radius",
        center_latitude: LANSING.lat,
        center_longitude: LANSING.lng,
        radius_meters: 1609,
        base_price_cents: null,
        per_dog_addl_cents: null,
        enabled: true,
        active_clients: 0,
      };
      created.push(zone);
      return reply({ id: zone.id, zone, propertiesUpdated: 0, zipsFilled: 0 });
    }
    if (name === "listZones") {
      listReads++;
      const body = { zones: [EXISTING_ZONE, ...created], activeClientsKnown: true };
      // The first read is the page's own. Every refetch after a Create is
      // slow, as a listZones that retries ZIP fills and pages active clients
      // can be: the list must not be waiting on it.
      if (listReads > 1 && created.length > 0) await new Promise((r) => setTimeout(r, 15_000));
      return reply(body).catch(() => {});
    }
    return route.fallback();
  });
  return { created };
}

async function shot(page: Page, name: string) {
  if (!SHOTS_DIR) return;
  await page.screenshot({ path: `${SHOTS_DIR}/${name}.png`, fullPage: false });
}

async function openNewZoneAndPlaceCircle(page: Page) {
  await page.goto("/settings/zones");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Zone name").fill("Lansing");
  const map = dialog.locator(".leaflet-container").first();
  await map.scrollIntoViewIfNeeded();
  const mb = await map.boundingBox();
  expect(mb, "the coverage map has no box").not.toBeNull();
  await page.mouse.click(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);
  return dialog;
}

for (const w of [390, 1440]) {
  test(`a new zone by the business: its ZIP, its price, and the list at ${w}px`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await installSignedInSession(context);
    await installStubBackend(context);
    const backend = await installNewZoneBackend(page, { standardCents: 2000 });
    await page.setViewportSize({ width: w, height: 900 });

    const dialog = await openNewZoneAndPlaceCircle(page);
    const status = page.getByTestId("zone-zip-fill-status");
    // Finished, on main and here alike: the lookup's answer, not "Finding…".
    await expect(status).toContainText("No ZIP has its center inside the circle", {
      timeout: 15000,
    });

    await check(async () => {
      // 2. The ZIP at the middle and the business's own ZIP are on the list,
      //    and the sentence says so instead of "add a nearby ZIP below".
      await expect(status).toHaveText(
        "No ZIP has its center inside the circle, so 48912, the ZIP at its middle, and 48933, your business's ZIP, were added.",
      );
      const chips = page.getByTestId("zone-zips").locator("[data-zip-chip]");
      await expect(chips.filter({ hasText: "48933" })).toHaveCount(1);
      await expect(chips.filter({ hasText: "48912" })).toHaveCount(1);
    });

    // 1. The price: blank (the standard applies), with the standard shown.
    const base = dialog.getByLabel("Zone price / visit");
    await base.scrollIntoViewIfNeeded();
    await check(async () => {
      await expect(base).toHaveValue("");
      await expect(base).toHaveAttribute("placeholder", "20.00");
      await expect(dialog.getByText("Standard: $20.00.", { exact: false })).toBeVisible();
      await expect(base).not.toHaveValue("25.00");
    });
    await shot(page, `new-zone-dialog-price-${w}`);
    await page.getByTestId("zone-zips").scrollIntoViewIfNeeded();
    await shot(page, `new-zone-dialog-zips-${w}`);

    await check(async () => {
      const overflow = await measurePageOverflow(page);
      expect(overflow.scrollW, `page scrolls sideways at ${w}px`).toBeLessThanOrEqual(
        overflow.innerW,
      );
    });

    // 3. Create, and the list has it while the refetch is still out.
    const created = Date.now();
    await dialog.getByRole("button", { name: "Create zone" }).click();
    await expect(dialog).toBeHidden({ timeout: 15000 });
    await check(async () => {
      expect(backend.created).toHaveLength(1);
      await expect(page.getByText("Lansing", { exact: true }).first()).toBeVisible({
        timeout: 5000,
      });
      expect(Date.now() - created, "the list waited on the slow refetch").toBeLessThan(12_000);
    });
    // Not ruled on in SHOTS_ONLY: the BEFORE list is whatever main drew.
    await page.waitForTimeout(800);
    // The list itself, not the banner above it: at 390 it is below the fold.
    // Anchored on the search box, which is drawn whatever the list holds, and
    // with a short timeout, so the shot is what the owner sees about a second
    // after Create -- not whatever the slow refetch draws later.
    await page
      .getByPlaceholder("Search name or ZIP")
      .first()
      .evaluate((el) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 1000 })
      .catch(() => {});
    await page.waitForTimeout(200);
    await shot(page, `zones-list-after-create-${w}`);
  });

  test(`no standard price yet: the price typed into setup at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await installNewZoneBackend(page, { standardCents: null });
    // Setup's service-area step left its draft on this device (#881).
    await context.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, JSON.stringify({ v: 1, savedAt: Date.now(), value }));
      },
      {
        key: `hs:form-draft:${SWEEP_USER_ID}:${ORG_ID}:setup-area`,
        value: { name: "Main service area", miles: 15, zip: "48933", price: "20", extraDog: "5" },
      },
    );
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/settings/zones");
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });
    const dialog = page.getByRole("dialog");
    const base = dialog.getByLabel("Zone price / visit");
    await base.scrollIntoViewIfNeeded();
    await check(async () => {
      await expect(base).toHaveValue("20.00", { timeout: 15000 });
      await expect(dialog.getByLabel("Each additional dog")).toHaveValue("5.00");
      await expect(page.getByTestId("zone-price-from-setup")).toHaveText(
        "Filled in from the price you entered in setup.",
      );
      // Not a dirty form: closing an untouched drawer asks nothing.
    });
    await page.waitForTimeout(500);
    await shot(page, `new-zone-dialog-price-from-setup-${w}`);
  });
}
