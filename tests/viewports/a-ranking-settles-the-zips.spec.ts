/**
 * The ranking control, and the warning for an area it has left with no ZIPs
 * (#858), have to REACH THE SCREEN and work with a thumb.
 *
 * `every-signed-in-page-at-every-width.spec.ts` measures /settings/zones
 * (where #870 moved the Zones page) on a one-zone fixture, which draws no ranking at all: the panel needs two
 * areas, and the warning needs one of them to lose every ZIP it lists to the
 * ones above it. So this answers listZones with three overlapping areas --
 * a 48-character name on top, a riverfront area at the bottom whose two ZIPs
 * the two above it both list -- and keeps the order in the stub, so a "Move
 * up" is answered the way the server answers it and the list redraws from
 * the new order.
 *
 * At 360, 768, 1280 and 1920:
 *   - the ranking is on screen in rank order, and the warning names the
 *     area and both areas that took its ZIPs;
 *   - no horizontal page scroll, nothing off the side, no clipped text;
 *   - below 768, every control in the panel is a 44px target;
 *   - moving the bottom area to the top clears the warning, and the summary
 *     under the area that was on top now says what it lost.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  findControlsOffTheSide,
  findControlsUnder44px,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";

const TOP = "Grosse Pointe Woods, Harper Woods and Eastpointe";
const MID = "Detroit core";
const BOTTOM = "Riverfront and Belle Isle";
const ID = (n: number) => `zzzz8580-0000-4000-8000-${String(n).padStart(12, "0")}`;

const zone = (n: number, z: Record<string, unknown>) => ({
  id: ID(n),
  enabled: true,
  active_clients: 0,
  base_price_cents: 2500,
  per_dog_addl_cents: 500,
  pricing_mode: "flat",
  geo_match_mode: "radius",
  center_latitude: 42.33 + n * 0.02,
  center_longitude: -83.05 - n * 0.02,
  radius_meters: 6000,
  boundary: null,
  latitude: null,
  longitude: null,
  drive_time_minutes: null,
  zip_fill_pending_since: null,
  ...z,
});

/** The three areas, with the order kept so a reorder is answered and shown. */
function rankingStub() {
  const zones = [
    // 48207 is in all three and goes to the top; 48214 is in the middle and
    // bottom ones and goes to the middle. The bottom area keeps nothing.
    zone(1, { name: TOP, priority: 3, zip_codes: ["48236", "48225", "48207"] }),
    zone(2, { name: MID, priority: 2, zip_codes: ["48226", "48201", "48207", "48214"] }),
    zone(3, { name: BOTTOM, priority: 1, zip_codes: ["48207", "48214"] }),
  ];
  return {
    listZones: () => ({ zones, activeClientsKnown: true }),
    reorderZones: (a: Record<string, any>) => {
      const ids: string[] = a.ids ?? [];
      const order = [...ids, ...zones.filter((z) => !ids.includes(z.id)).map((z) => z.id)];
      for (const z of zones) z.priority = order.length - order.indexOf(z.id);
      return { ok: true, order, propertiesUpdated: 0 };
    },
    getZoneCoverage: { problem: null, summary: { stale: 0, orphaned: 0, reassigned: 0, unassigned: 0 } },
  };
}

async function measure(page: Page, w: number, when: string) {
  const { scrollW, innerW } = await measurePageOverflow(page);
  expect(scrollW, `${when}: the page scrolls sideways at ${w}px`).toBeLessThanOrEqual(innerW);
  expect(await findControlsOffTheSide(page), `${when}: off the side at ${w}px`).toEqual([]);
  expect(await findSilentlyClippedText(page), `${when}: clipped at ${w}px`).toEqual([]);
  if (w < 768) {
    const faults = await findControlsUnder44px(page);
    expect(
      faults.filter((f) => /Move .* (up|down)/.test(f)),
      `${when}: a ranking button is under 44px at ${w}px`,
    ).toEqual([]);
  }
}

for (const w of [360, 768, 1280, 1920]) {
  test(`the ranking and its warning are on screen and usable at ${w}px`, async ({
    page,
    context,
  }) => {
    await installSignedInSession(context);
    await installStubBackend(context, { overrides: rankingStub() });
    await page.setViewportSize({ width: w, height: 1000 });
    await page.goto("/settings/zones");
    // A cold dev server pays for its first server function here, not in the
    // assertion (see a-zone-that-matches-nobody-says-so.spec.ts).
    await page.waitForLoadState("networkidle").catch(() => {});

    const panel = page.getByTestId("zone-ranking");
    await expect(panel).toBeVisible({ timeout: 15000 });
    const rows = panel.getByTestId("zone-rank-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(TOP);
    await expect(rows.nth(2)).toContainText(BOTTOM);

    // The warning names the area and both areas that took its ZIPs.
    const warning = page.getByTestId("zone-no-zips-left");
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(`“${BOTTOM}” keeps none of its ZIPs`);
    await expect(warning).toContainText(`“${TOP}” and “${MID}” rank higher`);
    const wb = await warning.boundingBox();
    expect(wb!.x + wb!.width, "the warning runs off the side").toBeLessThanOrEqual(w + 1);
    await measure(page, w, "as opened");

    // The drawer no longer asks for a typed priority.
    await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.locator("#zone-priority")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // Move the bottom area to the top: two taps, and the warning clears.
    await panel.getByRole("button", { name: `Move ${BOTTOM} up` }).click();
    await expect(rows.nth(1)).toContainText(BOTTOM, { timeout: 15000 });
    await panel.getByRole("button", { name: `Move ${BOTTOM} up` }).click();
    await expect(rows.nth(0)).toContainText(BOTTOM, { timeout: 15000 });
    await expect(page.getByTestId("zone-no-zips-left")).toHaveCount(0);
    // The area that was on top now says what it lost, and keeps the rest.
    await expect(rows.nth(1)).toContainText(`2 of 3 ZIPs, 1 to “${BOTTOM}”`);
    await measure(page, w, "after the move");
  });
}
