import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { beforeNewZoneCenter } from "./fixtures/issue-884-before-center";
import { newZoneCenter } from "../../src/lib/new-zone-center";

const directory = ".helm/screenshots/issue-884";
const business = { contact_address: "Lansing, MI", latitude: 42.73, longitude: -84.55 };
const existing = {
  id: "zzzz1111-0000-4000-8000-000000000001",
  name: "Existing Detroit zone",
  geo_match_mode: "radius",
  center_latitude: 42.33,
  center_longitude: -83.05,
  radius_meters: 1609,
  zip_codes: ["48201"],
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  color: "#2563eb",
  enabled: true,
};

for (const width of [390, 768, 1280]) {
  test(`issue 884 screenshots at ${width}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    // Diagnostic tiles make the actual renderer's geographic viewport readable
    // behind the network fence. These are explicitly labelled, not street imagery.
    await context.route("https://*.tile.openstreetmap.org/**", async (route) => {
      const [, z, x, filename] = new URL(route.request().url()).pathname.split("/");
      const y = parseInt(filename);
      const scale = 2 ** Number(z);
      const lng = ((Number(x) + 0.5) / scale) * 360 - 180;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 0.5)) / scale))) * 180) / Math.PI;
      return route.fulfill({
        contentType: "image/svg+xml",
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">
          <rect width="256" height="256" fill="#eef2f6" stroke="#aab8c8"/>
          <path d="M128 0V256M0 128H256" stroke="#d0d8e2" stroke-dasharray="4 4"/>
          <g font-family="sans-serif" text-anchor="middle" fill="#475569">
            <text x="128" y="93" font-size="12">OFFLINE TEST TILE</text>
            <text x="128" y="115" font-size="13">${lat.toFixed(3)}, ${lng.toFixed(3)}</text>
            <text x="128" y="150" font-size="11">zoom ${z} · tile ${x}/${y}</text>
          </g>
        </svg>`,
      });
    });
    let lookupCalls = 0;
    const geocode = async () => {
      lookupCalls++;
      return business;
    };
    // The pre-review implementation always looked up a nonempty business address.
    const beforeCenter = await beforeNewZoneCenter(business, geocode);
    expect(lookupCalls).toBe(1);
    lookupCalls = 0;
    const afterCenter = await newZoneCenter(business, geocode);
    expect(lookupCalls).toBe(0);
    let phase = "before";
    let openingRequests = 0;
    await context.route("**/_serverFn/**", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
      let name = "";
      try {
        name = String(
          JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
        ).replace(/_createServerFn_handler$/, "");
      } catch {
        /* shared handler */
      }
      const reply = (result: unknown) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ result }),
        });
      if (name === "getNewZoneCenter") {
        openingRequests++;
        return reply(phase === "before" ? beforeCenter : afterCenter);
      }
      if (name === "listZones") return reply({ zones: [existing], activeClientsKnown: true });
      return route.fallback();
    });
    await page.setViewportSize({ width, height: 1000 });
    mkdirSync(directory, { recursive: true });
    for (const scenario of ["before", "after", "existing"]) {
      phase = scenario;
      await page.goto("/zones");
      await page.waitForLoadState("networkidle");
      if (scenario === "existing") {
        openingRequests = 0;
        await page.getByRole("button", { name: `More actions for ${existing.name}` }).click();
        await page.getByRole("menuitem", { name: "Edit zone", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "New zone", exact: true }).click();
      }
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("Zone name")).toHaveValue(
        scenario === "existing" ? existing.name : "",
      );
      const map = dialog.locator(".leaflet-container").first();
      await map.scrollIntoViewIfNeeded();
      await expect(map).toBeVisible();
      await expect.poll(async () => map.locator("img.leaflet-tile").count()).toBeGreaterThan(0);
      await page.waitForTimeout(600);
      const tiles = await map
        .locator("img.leaflet-tile")
        .evaluateAll((images) => images.map((img) => (img as HTMLImageElement).src));
      const zooms = tiles.map((url) => Number(new URL(url).pathname.split("/")[1]));
      expect(zooms.every((zoom) => zoom >= 11 && zoom <= 14)).toBe(true);
      const expectedCenter = scenario === "existing" ? { lat: 42.33, lng: -83.05 } : afterCenter!;
      const zoom = zooms[0];
      const scale = 2 ** zoom;
      const latitude = (expectedCenter.lat * Math.PI) / 180;
      const centerTileX = Math.floor(((expectedCenter.lng + 180) / 360) * scale);
      const centerTileY = Math.floor(((1 - Math.asinh(Math.tan(latitude)) / Math.PI) / 2) * scale);
      expect(
        tiles.some((url) => {
          const [, z, x, y] = new URL(url).pathname.split("/");
          return Number(z) === zoom && Number(x) === centerTileX && parseInt(y) === centerTileY;
        }),
        "the map loads the tile containing its expected center",
      ).toBe(true);
      if (scenario === "existing") expect(openingRequests).toBe(0);
      if (scenario !== "existing") await expect(map.locator(".zone-center")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `${directory}/${scenario}-${width}.png` });
      writeFileSync(
        `${directory}/${scenario}-${width}.json`,
        JSON.stringify(
          {
            width,
            scenario,
            viewport: { width, height: 1000 },
            geocoderCalls: scenario === "before" ? 1 : 0,
            expectedCenter: scenario === "existing" ? { lat: 42.33, lng: -83.05 } : afterCenter,
            tileUrls: tiles,
            note: "Signed-in fixture data. Basemap uses explicitly labelled offline coordinate-grid test tiles; external street imagery is blocked.",
          },
          null,
          2,
        ) + "\n",
      );
    }
  });
}
