/**
 * Forty-three routes, twenty-two of them ever measured.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `every-signed-in-page-at-every-width.spec.ts` measures a hand-written list
 * of twenty-two surfaces. It is a good list and it is the only list, so a
 * route that nobody remembered to add has never been opened under
 * measurement. Sweeping the rest at 430px found 34 controls under Apple's
 * 44pt floor on nine pages:
 *
 *   settings/accounting        3 buttons at 36px, 1 checkbox at 20px
 *   settings/addons            2 selects at 40px
 *   settings/ai-receptionist   2 checkboxes at 20px
 *   settings/deep-clean       12 month buttons at 34px
 *   settings/preferences       1 timezone select at 40px
 *   settings/promotions        2 tab buttons at 28px
 *   analytics                  3 range buttons at 24px
 *   concerns                   4 status filters at 38px
 *   review                     4 status filters at 24px
 *
 * Five of those were not nine pages' worth of bugs. `ui/select.tsx` and
 * `ui/checkbox.tsx` carry the floor and a test pins them — but this app has 97
 * raw `<select>` elements across 36 files and 30 raw checkboxes across 19, and
 * none of them is that component. The fix is one base-layer rule in
 * styles.css, which reaches the pages nobody has opened yet as well as these.
 * The rest were bespoke and were sized in place.
 *
 * `concerns` is the one worth reading twice: it already carried
 * `max-md:px-4 max-md:py-2`, so somebody had noticed and fixed it — by WIDTH.
 * Every iPad is 744px or wider and all of it is touch, so the fix switched
 * itself off on the device that needed it most, and even below 768 it landed
 * at 38px. That is the exact bug `src/styles.css` documents above its `touch:`
 * variant, still shipping in the app three months later.
 *
 * ── WHY THIS ENUMERATES INSTEAD OF LISTING ────────────────────────────────
 *
 * A list is the thing that failed. So these come from the route files
 * themselves, and a page added tomorrow is measured tomorrow with nothing to
 * remember.
 *
 * The signed-in sweep asks each surface for a proof locator and a fixture
 * string, on the argument that a page rendering an empty state has no layout
 * to measure. That argument is right for a data page and wrong for a form: the
 * form IS the content, it renders with no rows at all, and a `<select>` is
 * exactly 40px tall whether or not anything came back. So the guard here is
 * one thing every authenticated route draws and `/auth` does not — the app
 * shell's own search box — rather than per-page fixture data. A sweep that
 * measured the login page forty times would be green and worthless, and this
 * cannot be that.
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
 * Routes that resolve to somewhere else, and so have no layout of their own.
 * Each is a deliberate redirect kept for old bookmarks or in-flight OAuth and
 * Stripe return URLs; the page they land on is measured under its own name.
 */
const REDIRECTS = new Set([
  "settings",
  "settings/payments",
  "ai-tools",
  "billing",
  // Forwards to settings/online-signup since the two public forms became one.
  "settings/lead-form",
  // Forwards to settings/zones since Zones & pricing moved inside Settings (#864).
  "zones",
]);

/**
 * Already covered by `every-signed-in-page-at-every-width.spec.ts`, which
 * measures them with fixture data and a per-page proof. Re-measuring them here
 * would be slower and weaker, not safer.
 */
const SWEPT = new Set([
  "dashboard",
  "clients",
  "invoices",
  "my-day",
  "zones",
  "notifications",
  "profile",
  "routes",
  "settings/users",
  "settings/online-signup",
  "settings/scheduling",
  // Measured there with a list of every status in it; here it would draw
  // the empty state. "quotes/new" is NOT on this list: it is a form, which
  // is the case this sweep exists for.
  "quotes",
  // Likewise: the list is measured there with a campaign of every status.
  // "campaigns/new" stays here, for the same reason as "quotes/new".
  "campaigns",
  // NOT "leads" or "reports", although both are surfaces there since
  // 2026-09-28. That sweep does not emulate a mobile browser and this one
  // does, and mobile emulation is the configuration that hid them: a page
  // wider than the phone zooms the phone out, and until that date the rule
  // compared the page against the zoomed-out width. They are measured here
  // too so the fix to that rule is proved on the pages that found it.
]);

/**
 * Every leaf route under `_authenticated`, derived from the filenames.
 *
 * Dropped: `route.tsx` (the layout, not a page), `index.tsx` (the segment
 * root), and anything with a `$param`, which needs an id this sweep has no
 * business inventing — `/clients/:id` is measured by name elsewhere.
 */
const PAGES = readdirSync(join(import.meta.dirname, "../../src/routes/_authenticated"))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => f.slice(0, -".tsx".length))
  .filter((f) => f !== "route" && f !== "index" && !f.includes("$"))
  .map((f) => f.replace(/\.index$/, "").replace(/\./g, "/"))
  .filter((p) => p && !REDIRECTS.has(p) && !SWEPT.has(p))
  // `messages.tsx` + `messages.index.tsx` and `settings.tsx` +
  // `settings.index.tsx` are a layout and its index; both name the same URL.
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();

/** 430 is the iPhone the owner actually holds; 360 is the narrow end the
 *  working agreement names as a real phone rather than an edge case. */
for (const width of [360, 430]) {
  test.describe(`the unlisted routes at ${width}px`, () => {
    test.use({ viewport: { width, height: 932 }, isMobile: true, deviceScaleFactor: 2 });

    test("finds the pages at all, so a green run means checked", () => {
      // A rename of the route-file convention would leave this sweeping
      // nothing, and every assertion below passes on an empty list.
      expect(PAGES.length).toBeGreaterThanOrEqual(35);
      expect(PAGES).toContain("settings/preferences");
      expect(PAGES).toContain("concerns");
      // And the exclusions are exclusions, not a way to quietly drop a page
      // that started failing.
      expect(PAGES).not.toContain("route");
      expect(PAGES).not.toContain("dashboard");
    });

    for (const page_ of PAGES) {
      test(`/${page_}`, async ({ page }) => {
        await installSignedInSession(page);
        await installStubBackend(page);
        await page.goto(`/${page_}`, { waitUntil: "domcontentloaded" });
        // ── PROOF THIS IS NOT THE LOGIN PAGE ──────────────────────────
        //
        // The mobile tab bar. Drawn on every authenticated route at these two
        // widths and on neither /auth nor /no-workspace, whose only <nav> is
        // a legal footer. Without a guard of this shape the sweep would
        // happily measure the sign-in screen forty times and report green —
        // the failure `every-signed-in-page-at-every-width.spec.ts` was
        // written around, and the reason each of its surfaces carries a
        // proof locator.
        //
        // Width-dependent, and that is fine because this file only runs at
        // 360 and 430; above `md` the bar is replaced by the sidebar. If a
        // wider width is ever added here, this needs a second locator, not a
        // longer timeout.
        await expect(page.getByRole("navigation").filter({ hasText: "Home" }).first()).toBeVisible({
          timeout: 30_000,
        });
        // And the route resolved to itself rather than bouncing to one of
        // those two, or to any of the redirect stubs.
        expect(new URL(page.url()).pathname, `/${page_} redirected`).toBe(`/${page_}`);
        await page.waitForTimeout(900);
        // ── AND NOT THE ERROR BOUNDARY ────────────────────────────────
        //
        // The router's `RouteError` renders INSIDE the shell, so the tab bar
        // above is still on screen when a page has thrown. Until 2026-09-28
        // /reports did exactly that on every run — `getReports` had no stub,
        // answered null, and the page threw on its first property read — and
        // this sweep measured a heading and two buttons, which fit on any
        // phone, and called the page green. The page itself was 786px wide on
        // a 360px phone. `every-signed-in-page-at-every-width.spec.ts` guards
        // on the same string for the same reason.
        const threw = await page.evaluate(() =>
          document.body.innerText.includes("Something went wrong"),
        );
        expect(threw, `/${page_} rendered the router's error boundary, not the page`).toBe(false);

        const { scrollW, innerW } = await measurePageOverflow(page);
        expect(scrollW, `/${page_} @${width}: page scrolls sideways`).toBeLessThanOrEqual(
          innerW + 1,
        );
        expect(await findControlsOffTheSide(page), `/${page_} @${width}`).toEqual([]);
        expect(await findSilentlyClippedText(page), `/${page_} @${width}`).toEqual([]);
        expect(await findControlsUnder44px(page), `/${page_} @${width}`).toEqual([]);
      });
    }
  });
}
