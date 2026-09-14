/**
 * The map view has to be MEASURED, not just built.
 *
 * `every-signed-in-page-at-every-width.spec.ts` loads /my-day and measures it
 * at four widths. It will never see this screen. The map is behind a toggle,
 * the sweep does not press anything, and every rule it runs is of the form
 * "nothing is wrong" — so a map view that overflowed 360px, or drew a control
 * under the 44px floor, would leave that sweep entirely green. The same blind
 * spot the coverage-banner spec was written for, one interaction deeper.
 *
 * So this presses the toggle and then runs the same four rules against what
 * appears.
 *
 * ── WHAT IT PROVES FIRST ──────────────────────────────────────────────────
 *
 * A Leaflet container that failed to mount is an empty div, and an empty div
 * passes every one of those rules. So the map has to prove it rendered before
 * anything is measured — `.leaflet-container` plus a pin — for the same reason
 * `settle()` refuses to measure a route that did not render.
 *
 * ── TILES DO NOT LOAD HERE, AND THAT IS THE POINT ─────────────────────────
 *
 * The stub backend fences the network to localhost, so no tile server is
 * reachable and the basemap stays blank. That is not a gap in the test: it is
 * the van-with-no-signal case, and the thing being measured — where the
 * container, the pins and the controls sit — is laid out by Leaflet from the
 * bounds, not by the imagery. A map that only holds its shape when the tiles
 * arrive is a map that falls apart exactly where this product is used.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";
import {
  findControlsOffTheSide,
  findControlsUnder44px,
  findSilentlyClippedText,
  measurePageOverflow,
} from "./rules";

for (const { w, label } of [
  { w: 360, label: "360 · a real phone" },
  { w: 768, label: "768 · tablet portrait" },
  { w: 1280, label: "1280 · small laptop" },
]) {
  test(`the day map is laid out inside ${w}px (${label})`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto("/my-day");
    await page.waitForLoadState("networkidle").catch(() => {});

    // "Map", not "Map view". The toggle carried an icon and an sr-only
    // "Map view" until 2026-09-14; it now shows the word next to the glyph,
    // so the visible label IS the accessible name and the sr-only span that
    // used to supply it is gone. Matching the visible text is the point
    // (WCAG 2.5.3), not an accident of this rename.
    const toggle = page.getByRole("button", { name: "Map", exact: true });
    await expect(toggle).toBeVisible({ timeout: 15000 });
    await toggle.click();

    // It rendered, and it has the day on it. Leaflet is loaded lazily, so this
    // also covers the Suspense boundary actually resolving.
    const map = page.locator(".leaflet-container");
    await expect(map).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({ timeout: FIRST_PAINT_MS });

    const { scrollW, innerW } = await measurePageOverflow(page);
    expect(scrollW, `the day map scrolls sideways at ${w}px`).toBeLessThanOrEqual(innerW + 1);

    const findings = [
      ...(await findControlsOffTheSide(page)),
      ...(await findSilentlyClippedText(page)),
      ...(w < 768 ? await findControlsUnder44px(page) : []),
    ];
    expect(findings, `the day map at ${w}px breaks the responsiveness agreement`).toEqual([]);
  });
}
