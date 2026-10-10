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
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
// The five shots, shared with play-store-screenshots.spec.ts, and the guard
// that refuses a frame which is not its page (see the top of that file).
import { STORE_SHOTS, openStoreShot } from "./fixtures/store-shots";

const OUT = join(process.cwd(), "ios", "screenshots");

const SIZES = [
  { name: "6.9-inch-iphone", width: 430, height: 932, scale: 3 },
  { name: "6.5-inch-iphone", width: 414, height: 896, scale: 3 },
  { name: "13-inch-ipad", width: 1024, height: 1366, scale: 2 },
];

for (const size of SIZES) {
  test.describe(`${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      isMobile: size.scale === 3,
      // Every one of these is a touch device. The app sizes controls by input
      // (`touch:`), not width, so a mouse-emulated iPad photographs the desktop
      // control sizes no iPad user ever sees.
      hasTouch: true,
    });

    for (const [i, shot] of STORE_SHOTS.entries()) {
      test(`${i + 1}. ${shot.name}`, async ({ page }) => {
        await openStoreShot(page, shot, `${shot.name} at ${size.name}`);

        const dir = join(OUT, size.name);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${String(i + 1).padStart(2, "0")}-${shot.name}.png`);
        const png = await page.screenshot({ path: file });

        // openStoreShot() proved this is the page with its data on it; this
        // catches a file that came out empty anyway, and a size App Store
        // Connect would refuse.
        expect(png.byteLength, `${file} looks empty`).toBeGreaterThan(20_000);
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${file} dimensions`).toEqual([
          size.width * size.scale,
          size.height * size.scale,
        ]);
      });
    }
  });
}
