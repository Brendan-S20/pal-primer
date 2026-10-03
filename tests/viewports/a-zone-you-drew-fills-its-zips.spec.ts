/**
 * A drawn zone fills its own ZIPs, and the list it fills fits on a phone.
 *
 * Owner, 2026-10-01: placing a radius, drive time or polygon "does not auto
 * insert all the zip codes that are within that". Now it does, and a fill is
 * the first time this drawer has had to hold a LOT of chips: a 20-mile circle
 * round a city is a few hundred ZIPs. That is the layout this measures --
 * 142 filled ZIPs, nine edge suggestions and an overlap note naming a long
 * zone name -- at 360, 768 and 1280.
 *
 * The fill is driven the way an owner drives it: "New zone", then a click on
 * the map to place the circle's center. The lookup is answered by a stub
 * keyed on the server function's name, like everything else in
 * fixtures/stub-backend.ts; the geometry itself is tested against real Census
 * centers in tests/a-zone-you-drew-named-no-zips.test.ts.
 *
 * What it asserts, at every width:
 *   - the fill reached the screen (status sentence, collapsed "142 ZIPs ·
 *     show all", the edge suggestions, the overlap note) -- a drawer that drew
 *     none of it would pass every "nothing is wrong" rule below;
 *   - no horizontal page scroll, with the list folded and unfolded;
 *   - nothing in the ZIP section runs past the drawer's own right edge (the
 *     desktop drawer is an overflow-hidden dialog, so the page-level rule
 *     cannot see a chip clipped inside it);
 *   - below 768, every control in the ZIP section is a 44px target.
 */
import { test, expect, type Page } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { measurePageOverflow } from "./rules";

const INSIDE = Array.from({ length: 142 }, (_, i) => String(60601 + i));
const EDGE = ["60512", "60513", "60514", "60515", "60516", "60517", "60518", "60519", "60520"];
const OTHER_ZONE = "Ravenswood Manor / Lincoln Square North";
const DRAWN_ZONE = "Albany Park and North Park Circle";

async function installZipFill(page: Page) {
  // Registered after installStubBackend, so these two names are answered
  // here and everything else falls through to the shared stub.
  await page.context().route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      ).replace(/_createServerFn_handler$/, "");
    } catch {
      /* not ours */
    }
    const reply = (result: unknown) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ result }),
      });
    if (name === "zipsInZoneShape") {
      return reply({
        inside: INSIDE,
        insideTotal: INSIDE.length,
        edge: EDGE,
        candidatesCapped: false,
        tooLarge: false,
      });
    }
    if (name === "listZones") {
      return reply({
        zones: [
          {
            id: "zzzz1111-0000-4000-8000-000000000001",
            name: OTHER_ZONE,
            postal_prefix: "606",
            zip_codes: [
              "60601",
              "60602",
              "60603",
              "60610",
              "60611",
              "60612",
              "60613",
              "60614",
              "60615",
              "60616",
            ],
            color: "#2563eb",
          },
          // Drawn before 2026-10-01: a circle, and no ZIPs at all.
          {
            id: "zzzz1111-0000-4000-8000-0000000000c1",
            name: DRAWN_ZONE,
            zip_codes: [],
            geo_match_mode: "radius",
            center_latitude: 41.97,
            center_longitude: -87.7,
            radius_meters: 8000,
            base_price_cents: 2500,
            per_dog_addl_cents: 500,
            color: "#0891b2",
          },
        ],
      });
    }
    return route.fallback();
  });
}

for (const w of [360, 768, 1280]) {
  test(`a drawn zone fills 142 ZIPs and they fit at ${w}px`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await installZipFill(page);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/zones");
    // Same reason as a-zone-that-matches-nobody-says-so.spec.ts: a cold dev
    // server pays for its first server function here, not in the assertion.
    await page.waitForLoadState("networkidle").catch(() => {});

    await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });
    const zips = page.getByTestId("zone-zips");
    await expect(zips).toBeVisible({ timeout: 15000 });

    // Place the circle the way an owner does: a click on the map.
    // The drawer's own map: the page behind it draws an overview map too.
    const map = page.getByRole("dialog").locator(".leaflet-container").first();
    await map.scrollIntoViewIfNeeded();
    const mb = await map.boundingBox();
    expect(mb, "the coverage map has no box").not.toBeNull();
    await page.mouse.click(mb!.x + mb!.width / 2, mb!.y + mb!.height / 2);

    const status = page.getByTestId("zone-zip-fill-status");
    await expect(status).toContainText("Added 142 ZIPs with a center inside the circle", {
      timeout: 15000,
    });
    const toggle = zips.getByRole("button", { name: "142 ZIPs · show all" });
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId("zone-zip-edge")).toContainText("only partly overlap");
    await expect(page.getByTestId("zone-zip-overlap")).toContainText(OTHER_ZONE);
    // Folded: 16 chips, not 142 -- at 360px a chip is a 44px row of two.
    await expect(zips.locator("[data-zip-chip]")).toHaveCount(16);

    const check = async (when: string) => {
      const { scrollW, innerW } = await measurePageOverflow(page);
      expect(scrollW, `${when}: the page scrolls sideways at ${w}px`).toBeLessThanOrEqual(innerW);

      const faults = await page.evaluate(
        ({ small }) => {
          const out: string[] = [];
          const section = document.querySelector('[data-testid="zone-zips"]')!;
          const host = section.closest('[role="dialog"]') ?? document.documentElement;
          const edge = Math.min(host.getBoundingClientRect().right, window.innerWidth);
          const scope = [section, document.querySelector('[data-testid="zone-zip-edge"]')].filter(
            Boolean,
          ) as Element[];
          for (const root of scope) {
            for (const el of root.querySelectorAll("button, input, [data-zip-chip]")) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              const label =
                el.getAttribute("aria-label") ||
                el.getAttribute("data-zip-chip") ||
                (el.textContent ?? "").trim().slice(0, 30);
              if (r.right > edge + 1)
                out.push(`${label}: right edge ${r.right.toFixed(0)} > ${edge.toFixed(0)}`);
              if (small && el.matches("button, input") && (r.height < 44 || r.width < 44)) {
                out.push(`${label}: ${r.width.toFixed(0)}x${r.height.toFixed(0)}, under 44px`);
              }
            }
          }
          return out;
        },
        { small: w < 768 },
      );
      expect(faults, `${when} at ${w}px`).toEqual([]);
    };

    await check("folded");
    await toggle.click();
    await expect(zips.locator("[data-zip-chip]")).toHaveCount(142);
    await expect(zips.getByRole("button", { name: "Show fewer" })).toBeVisible();
    await check("unfolded");

    // Removing a chip is a thumb's job too, and it has to work.
    await zips.getByRole("button", { name: "Remove 60700" }).click();
    await expect(zips.locator("[data-zip-chip]")).toHaveCount(141);
  });
}

// A zone drawn before the fill existed is not changed behind the owner's back:
// its card says the signup page cannot quote it, and offers the fill. One
// click opens it with the ZIPs added, for the owner to look over and save.
test("an old drawn zone with no ZIPs offers the fill, and the click fills it", async ({
  page,
  context,
}) => {
  await installSignedInSession(context);
  await installStubBackend(context);
  await installZipFill(page);
  await page.setViewportSize({ width: 360, height: 900 });
  await page.goto("/zones");
  await page.waitForLoadState("networkidle").catch(() => {});

  const button = page.getByRole("button", { name: "Fill ZIPs from the area" });
  await expect(button).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("No ZIPs listed, so the signup page and lead form can't quote this area."),
  ).toBeVisible();
  const bb = await button.boundingBox();
  expect(bb!.height, "the fill button is under the 44px touch floor").toBeGreaterThanOrEqual(44);
  expect(bb!.x + bb!.width, "the fill button runs off the side").toBeLessThanOrEqual(361);

  await button.click();
  await expect(page.getByTestId("zone-zip-fill-status")).toContainText(
    "Added 142 ZIPs with a center inside the circle",
    { timeout: 15000 },
  );
  await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
});

// ── THREE TARGETS IN THE SAME DRAWER, MEASURED WITH A FINGER ─────────────
//
// Measured at 360px on 2026-10-02, in the drawer "New zone" opens: the
// radius slider was 16px tall (a range input's hit area is its own box, and
// with no height that box is the thumb), Leaflet's +/- were 30px, and the
// drawer's Cancel was 36px. All three are sized with `touch:` now, so this
// runs with touch ON — Chromium then reports `pointer: coarse`, Leaflet adds
// its own `leaflet-touch` class (the rule that made the buttons 30px), and
// the iPad width proves the sizing is about the finger rather than the
// width. At 820px `max-md:` would have switched itself off; `touch:` does not.
test.describe("the new-zone drawer with a finger", () => {
  test.use({ hasTouch: true });
  for (const w of [360, 820]) {
    test(`slider, zoom buttons and Cancel are 44px targets at ${w}px`, async ({
      page,
      context,
    }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
      await installZipFill(page);
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto("/zones");
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.getByRole("button", { name: "New zone" }).click({ timeout: 30000 });

      const dialog = page.getByRole("dialog");
      // A new zone opens in radius mode — the slider is the proof it did.
      const slider = dialog.getByRole("slider", { name: "Radius" });
      await expect(slider).toBeVisible({ timeout: 15000 });
      const zoomIn = dialog.locator(".leaflet-control-zoom-in");
      const zoomOut = dialog.locator(".leaflet-control-zoom-out");
      await expect(zoomIn).toBeVisible({ timeout: 15000 });
      const cancel = dialog.getByRole("button", { name: "Cancel", exact: true });

      for (const [label, loc] of [
        ["radius slider", slider],
        ["zoom in", zoomIn],
        ["zoom out", zoomOut],
        ["Cancel", cancel],
      ] as const) {
        await loc.scrollIntoViewIfNeeded();
        const bb = await loc.boundingBox();
        expect(bb, `${label} has no box at ${w}px`).not.toBeNull();
        expect(bb!.height, `${label} is ${bb!.height}px tall at ${w}px`).toBeGreaterThanOrEqual(44);
        if (label !== "radius slider") {
          // The slider is as wide as its row; the buttons have to be 44 across.
          expect(bb!.width, `${label} is ${bb!.width}px wide at ${w}px`).toBeGreaterThanOrEqual(44);
        } else {
          expect(
            bb!.width,
            `the slider was squeezed to ${bb!.width}px at ${w}px`,
          ).toBeGreaterThanOrEqual(128);
        }
      }
    });
  }
});
