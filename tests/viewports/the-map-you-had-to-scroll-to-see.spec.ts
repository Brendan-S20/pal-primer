/**
 * Two faults reported from a real phone on 2026-09-13, and the measurements
 * that say they stay fixed.
 *
 * ── 1. "map doesn't fit flush; I have to scroll up and down to see the whole
 *       map" ─────────────────────────────────────────────────────────────
 *
 * The map was a flat 460px on a phone, placed below a header that is about
 * 250px, inside a page carrying 10.5rem of bottom padding to clear the two
 * bars pinned to the bottom of the screen. That padding is what keeps the LIST
 * off the bars and it is right for the list; under a map that already stops
 * where it should, it is 168px of empty page. So the one view whose entire job
 * is showing the shape of the day at a glance could not be seen without
 * scrolling.
 *
 * The map now measures the gap between its own top edge and the highest bar
 * carrying `data-bottom-chrome`, and the page drops the padding in map mode.
 * This asserts the outcome rather than the mechanism: the page does not scroll,
 * and the bottom of the map is above the bars.
 *
 * NO MINIMUM HEIGHT, and that is the point of the second assertion. A floor
 * larger than the room available does not make the map bigger, it moves the
 * bottom of it behind the navigation — the same fault, quieter. An earlier
 * attempt with a 200px floor passed "does the page scroll" and put 62px of map
 * under the tab bar at 360x800.
 *
 * ── 2. "the cards are still busy" ─────────────────────────────────────────
 *
 * A scheduled stop rendered nine controls before the technician had arrived:
 * Start, a greyed-out Complete, Skip, + Add-on, Stations, DNA sample, Text
 * reminder, Text "on my way", and a photo-type select beside Take photo.
 *
 * What this pins is BOTH halves, because either alone is easy and wrong. The
 * card shows what the stop needs next — and everything folded away is still
 * one tap down, not deleted. A test that only counted controls would pass just
 * as well if the buttons had been removed.
 */
import { test, expect } from "@playwright/test";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { FIRST_PAINT_MS } from "./fixtures/first-paint";

const PHONES = [
  { w: 360, h: 800, label: "360x800 · a small phone" },
  { w: 390, h: 844, label: "390x844 · iPhone 14" },
  { w: 430, h: 932, label: "430x932 · iPhone Pro Max" },
] as const;

for (const { w, h, label } of PHONES) {
  test(`the day map fits the screen it is on (${label})`, async ({ page, context }) => {
    await installSignedInSession(context);
    await installStubBackend(context);
    await page.setViewportSize({ width: w, height: h });
    await page.goto("/my-day");
    await page.waitForLoadState("networkidle").catch(() => {});

    // "Map", not "Map view". The toggle carried an icon and an sr-only
    // "Map view" until 2026-09-14; it now shows the word next to the glyph,
    // so the visible label IS the accessible name and the sr-only span that
    // used to supply it is gone. Matching the visible text is the point
    // (WCAG 2.5.3), not an accident of this rename.
    const toggle = page.getByRole("button", { name: "Map", exact: true });
    await expect(toggle).toBeVisible({ timeout: FIRST_PAINT_MS });
    await toggle.click();

    // It rendered before anything is measured. An unmounted Leaflet container
    // is an empty div, and an empty div fits any screen perfectly.
    await expect(page.locator(".leaflet-container")).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(page.locator(".leaflet-marker-icon").first()).toBeVisible({ timeout: FIRST_PAINT_MS });

    const m = await page.evaluate(() => {
      const frame = document.querySelector(".leaflet-container")?.parentElement as HTMLElement;
      const r = frame.getBoundingClientRect();
      let floor = window.innerHeight;
      for (const bar of document.querySelectorAll<HTMLElement>("[data-bottom-chrome]")) {
        const br = bar.getBoundingClientRect();
        if (br.height > 0) floor = Math.min(floor, br.top);
      }
      return {
        overflow: document.documentElement.scrollHeight - window.innerHeight,
        below: Math.round(floor - r.bottom),
        height: Math.round(r.height),
      };
    });

    expect(m.overflow, `the map view scrolls the page by ${m.overflow}px at ${label}`).toBeLessThanOrEqual(1);
    expect(m.below, `${m.below < 0 ? -m.below : 0}px of map is behind the bottom bars at ${label}`).toBeGreaterThanOrEqual(0);
    // Not a design minimum — a tripwire. Zero would mean the measurement
    // returned nothing and every assertion above passed on an absent map.
    expect(m.height, "the map has no height at all").toBeGreaterThan(40);
  });
}

test("a scheduled stop asks for one thing, and hides nothing", async ({ page, context }) => {
  await installSignedInSession(context);
  await installStubBackend(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});

  const card = page.locator("ol > li").first();
  await expect(card.getByRole("button", { name: "Start" })).toBeVisible({ timeout: FIRST_PAINT_MS });

  const visible = () =>
    page.evaluate(() => {
      const c = document.querySelector("ol > li") as HTMLElement;
      return [...c.querySelectorAll("button, a, select")]
        .filter((e) => (e as HTMLElement).offsetParent !== null)
        .map((e) => (e.textContent || "").trim())
        .filter(Boolean);
    });

  const closed = await visible();
  // "Stop" is the live-tracking banner's control, first on the card while the
  // fixture has this stop's location being shared (getMyLiveShare). It is
  // deliberately never folded away: a tech must always be one tap from ending
  // what their customer can see of them.
  expect(closed, `a scheduled card shows too much: ${closed.join(" | ")}`).toEqual([
    "Stop",
    "Navigate",
    "Call",
    "Start",
    "More options",
  ]);

  // And the rest is one tap away, not gone. Skip in particular: a technician
  // who cannot get into a yard has to be able to say so.
  await card.getByRole("button", { name: "More options" }).click();
  const opened = await visible();
  for (const label of ["Skip", "+ Add-on", "Take photo"]) {
    expect(opened, `${label} is not reachable from the card`).toContain(label);
  }
});

test("a stop in progress asks for the next thing instead", async ({ page, context }) => {
  // The claim the card rework rests on is that WHICH controls show is the
  // visit's own state. Until the fixture grew a third stop, two of the three
  // states existed on this screen — scheduled and completed — and the one that
  // changed most did not, so that claim was tested at a third of its width.
  //
  // What must be true here and is false one card up: no Start (it has been
  // started), and Complete present rather than folded away, because on a stop
  // in progress finishing it IS the next act. Complete is disabled until a
  // completion photo exists, and that is correct — the difference from the
  // scheduled card is that here the sentence explaining why is on screen.
  await installSignedInSession(context);
  await installStubBackend(context);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/my-day");
  await page.waitForLoadState("networkidle").catch(() => {});

  // The badge renders `status.replace("_", " ")`, so the word on screen is
  // "in progress" and not the column value.
  //
  // A STRING and not a regex, measured rather than assumed: Playwright
  // normalises whitespace for a string `hasText` and does not for a RegExp,
  // and the badge's text arrives with JSX whitespace in it. `/\bin progress\b/`
  // matches zero of these cards; "in progress" matches exactly one.
  const inProgress = page.locator("ol > li").filter({ hasText: "in progress" }).first();
  await expect(inProgress).toBeVisible({ timeout: FIRST_PAINT_MS });

  const ctl = await inProgress.evaluate((li) =>
    [...li.querySelectorAll("button, a, select")]
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => (e.textContent || "").trim())
      .filter(Boolean),
  );

  expect(ctl, `a stop in progress shows: ${ctl.join(" | ")}`).toContain("Take photo");
  expect(ctl, `a stop in progress shows: ${ctl.join(" | ")}`).toContain("Complete");
  expect(ctl, "Start is still offered on a visit that has already started").not.toContain("Start");
  // Still folded, not deleted — the same both-ends check as the scheduled card.
  expect(ctl).toContain("More options");
  expect(ctl, "the occasional actions leaked back onto a card").not.toContain("+ Add-on");
});
