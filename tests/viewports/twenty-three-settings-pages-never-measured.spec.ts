/**
 * Twenty-three settings pages, three of them ever measured.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `every-signed-in-page-at-every-width.spec.ts` covers `/settings/users`,
 * `/settings/online-signup` and `/settings/scheduling`. There are twenty-three
 * settings routes. Sweeping the other twenty at 430px turned up 23 controls
 * under Apple's 44pt floor on six pages:
 *
 *   accounting        3 buttons at 36px, 1 checkbox at 20px
 *   addons            2 selects at 40px
 *   ai-receptionist   2 checkboxes at 20px
 *   deep-clean       12 month buttons at 34px
 *   preferences       1 timezone select at 40px
 *   promotions        2 tab buttons at 28px
 *
 * Five of those were not really six pages' worth of bugs. `ui/select.tsx` and
 * `ui/checkbox.tsx` carry the floor and a test pins them — but this app has 97
 * raw `<select>` elements across 36 files and 30 raw checkboxes across 19, and
 * none of them is that component. The fix is one base-layer rule in
 * styles.css, which reaches the pages nobody has opened yet as well as these.
 * The seventeen buttons were bespoke and were sized in place.
 *
 * ── WHY THIS SWEEPS INSTEAD OF LISTING SURFACES ───────────────────────────
 *
 * The signed-in sweep asks each surface for a proof locator and a fixture
 * string, on the argument that a page rendering an empty state has no layout
 * to measure. That argument is right for a data page and wrong for a settings
 * form: the form IS the content, it renders with no rows at all, and a
 * `<select>` is exactly 40px tall whether or not anything came back. So these
 * enumerate from the route files themselves, and a page added tomorrow is
 * measured tomorrow with nothing to remember.
 *
 * The guard those surfaces exist to provide is still here, in one place: the
 * settings shell's own heading and section nav, which `/auth` does not draw.
 * A sweep that measured the login page twenty-three times would be green and
 * worthless.
 */
import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  measurePageOverflow,
  findControlsOffTheSide,
  findSilentlyClippedText,
  findControlsUnder44px,
} from "./rules";

/**
 * `/settings/payments` is a deliberate redirect to `/payments` — it keeps old
 * bookmarks and in-flight Stripe onboarding return URLs working, and it never
 * draws the settings shell. Measured on its own page, not here.
 */
const REDIRECTS = new Set(["payments"]);

const PAGES = readdirSync(join(import.meta.dirname, "../../src/routes/_authenticated"))
  .filter((f) => /^settings\.[a-z-]+\.tsx$/.test(f))
  .map((f) => f.slice("settings.".length, -".tsx".length))
  .filter((p) => p !== "index" && !REDIRECTS.has(p))
  .sort();

/** 430 is the iPhone the owner actually holds; 360 is the narrow end the
 *  working agreement names as a real phone rather than an edge case. */
for (const width of [360, 430]) {
  test.describe(`settings at ${width}px`, () => {
    test.use({ viewport: { width, height: 932 }, isMobile: true, deviceScaleFactor: 2 });

    test("finds the pages at all, so a green run means checked", () => {
      // A rename of the route-file convention would leave this sweeping
      // nothing, and every assertion below passes on an empty list.
      expect(PAGES.length).toBeGreaterThanOrEqual(20);
      expect(PAGES).toContain("preferences");
    });

    for (const page_ of PAGES) {
      test(`/settings/${page_}`, async ({ page }) => {
        await installSignedInSession(page);
        await installStubBackend(page);
        await page.goto(`/settings/${page_}`, { waitUntil: "domcontentloaded" });
        // The settings shell, which /auth and /no-workspace do not draw.
        await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible({
          timeout: 30_000,
        });
        await page.waitForTimeout(900);

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `/settings/${page_} @${width}: page scrolls sideways`).toBeLessThanOrEqual(
          innerW + 1,
        );
        expect(await findControlsOffTheSide(page), `/settings/${page_} @${width}`).toEqual([]);
        expect(await findSilentlyClippedText(page), `/settings/${page_} @${width}`).toEqual([]);
        expect(await findControlsUnder44px(page), `/settings/${page_} @${width}`).toEqual([]);
      });
    }
  });
}
