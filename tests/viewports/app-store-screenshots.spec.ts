// App Store screenshots, from the app itself.
//
// ── WHY THIS IS A PLAYWRIGHT SPEC AND NOT A SIMULATOR SCRIPT ─────────────
//
// The alternative is booting a simulator, installing the binary, signing in
// and driving it with XCUITest. That produces authentic iOS chrome and it
// needs a signed build, a working account and a device that stays in the same
// state between runs -- three things that have each broken at least once this
// month.
//
// This reuses what already works. `every-signed-in-page-at-every-width` mints
// a session into localStorage, answers every request from a fixture, and
// fences the network so nothing reaches production. That is exactly the
// property App Store screenshots need: a real render of real UI with NO REAL
// CUSTOMER IN IT. HoundStack ships as a WebView, so this IS what the app
// draws; only the status bar is absent, and Apple does not require one.
//
// ── SIZES ────────────────────────────────────────────────────────────────
//
// Physical pixels are viewport x deviceScaleFactor, which is how these map to
// the dimensions App Store Connect asks for:
//
//   6.9" iPhone   430 x 932  @3  ->  1290 x 2796
//   6.5" iPhone   414 x 896  @3  ->  1242 x 2688
//   13"  iPad    1024 x 1366 @2  ->  2048 x 2732
//
// Two of those three are sizes rules.ts already sweeps for LAYOUT -- 430x932
// and 1024x1366. That list and this one are different things and must not be
// merged: APPLE_SIZES exists to find broken layouts and therefore includes
// landscape and a 320pt phone, neither of which App Store Connect accepts.
// Sharing the two entries that overlap is enough.
//
// Verify against App Store Connect before uploading: Apple changes the
// accepted set, and a rejected upload costs a review cycle.
//
// Run with: npx playwright test tests/viewports/app-store-screenshots.spec.ts
// Output:   ios/screenshots/<size>/<order>-<name>.png
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";

/** The sweep fixture pins `getTrialState` to `phase: "expired"`, ON PURPOSE:
 *  the layout sweep exists to measure the banner, so it ships the worst case.
 *
 *  For a screenshot that is exactly backwards. The first version of these shots
 *  gave the top third of every phone frame to "Your free trial has ended", with
 *  "Set up billing" underneath -- a paywall notice as the opening image of the
 *  store listing.
 *
 *  Registered AFTER installStubBackend, because Playwright matches handlers in
 *  reverse order of registration, so this wins over the fixture without
 *  touching it. The sweep keeps measuring the state it needs to measure. */
async function showAPayingCustomer(page: Page) {
  await page.route("**/_serverFn/**", async (route) => {
    const id = new URL(route.request().url()).pathname.split("/_serverFn/")[1] ?? "";
    let name = "";
    try {
      name = String(
        JSON.parse(Buffer.from(decodeURIComponent(id), "base64url").toString()).export ?? "",
      ).replace(/_createServerFn_handler$/, "");
    } catch {
      /* not a shape we recognise; let the fixture answer */
    }
    if (name === "getTrialState") {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        // { result: ... } is the envelope a TanStack Start server function
        // replies in, and the fixture uses it too. Returning the bare object
        // gives the client `undefined` and React Query logs "Query data cannot
        // be undefined" for ["trial","state"] -- which is not a crash, so the
        // page still renders and the screenshot still looks plausible.
        body: JSON.stringify({
          result: {
            phase: "paid",
            daysRemaining: null,
            endsOn: null,
            restricted: false,
            canManageBilling: true,
          },
        }),
      });
    }
    return route.fallback();
  });
}

const OUT = join(process.cwd(), "ios", "screenshots");

const SIZES = [
  { name: "6.9-inch-iphone", width: 430, height: 932, scale: 3 },
  { name: "6.5-inch-iphone", width: 414, height: 896, scale: 3 },
  { name: "13-inch-ipad", width: 1024, height: 1366, scale: 2 },
];

/** The story a reviewer reads top to bottom, in order.
 *
 *  Deliberately NOT one shot per feature. Five screenshots that say "this is
 *  the day, this is the round, this is the customer, this is the money" beat
 *  ten that say "there is also a settings page". */
const SHOTS: Array<{
  name: string;
  path: string;
  ready: (p: Page) => Promise<void>;
}> = [
  {
    name: "todays-work",
    path: "/dashboard",
    ready: async (p) => {
      await expect(p.getByText("Today's routes", { exact: false }).first()).toBeVisible({
        timeout: 20_000,
      });
    },
  },
  {
    name: "the-round",
    path: "/routes",
    ready: async (p) => {
      await expect(p.getByRole("button", { name: "Auto-routing" })).toBeVisible({
        timeout: 20_000,
      });
    },
  },
  {
    name: "auto-routing",
    path: "/routes",
    ready: async (p) => {
      const btn = p.getByRole("button", { name: "Auto-routing" });
      await expect(btn).toBeVisible({ timeout: 20_000 });
      await btn.click();
      // The panel is now three things: who, which days, Apply. Which is the
      // point of the screenshot.
      await expect(p.getByRole("dialog", { name: "Auto-routing" })).toBeVisible();
    },
  },
  {
    name: "the-customer",
    path: "/clients",
    ready: async (p) => {
      await expect(p.getByRole("heading", { name: "Clients", exact: true }).first()).toBeVisible({
        timeout: 20_000,
      });
    },
  },
  {
    name: "getting-paid",
    path: "/invoices",
    ready: async (p) => {
      await p.waitForLoadState("networkidle").catch(() => {});
    },
  },
];

for (const size of SIZES) {
  test.describe(`${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      isMobile: size.scale === 3,
    });

    for (const [i, shot] of SHOTS.entries()) {
      test(`${i + 1}. ${shot.name}`, async ({ page }) => {
        await installSignedInSession(page);
        await installStubBackend(page);
        await showAPayingCustomer(page);

        await page.goto(shot.path, { waitUntil: "domcontentloaded" });
        await shot.ready(page);

        // Animations settle, or the shot catches a panel halfway open.
        await page.waitForTimeout(600);

        const dir = join(OUT, size.name);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${String(i + 1).padStart(2, "0")}-${shot.name}.png`);
        await page.screenshot({ path: file });

        // A blank page satisfies "no error", and a screenshot of one is worse
        // than none because nobody looks until the review is rejected. The
        // ready() above already proved this page drew its own content; this
        // catches a file that came out empty anyway.
        const png = await page.screenshot();
        expect(png.byteLength, `${file} looks empty`).toBeGreaterThan(20_000);
      });
    }
  });
}
