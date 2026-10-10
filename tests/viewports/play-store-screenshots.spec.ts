// Google Play screenshots, from the app itself.
//
// The Android counterpart to app-store-screenshots.spec.ts, and built the same
// way for the same reason: a signed-in session minted into localStorage, every
// request answered by the fixture, the network fenced, so the images are a
// real render of real UI with no real customer in them. HoundStack on Android
// is the same bundle in a WebView, so this IS what the app draws.
//
// Same five shots, in the same order, from fixtures/store-shots.ts: the two
// listings should tell one story.
//
// ── SIZES ────────────────────────────────────────────────────────────────
//
// Play's rules (verify in Play Console before uploading; they change):
// PNG or JPEG, 9:16 or 16:9, each side 320-3840px for phones and at least
// 1080px for tablets, the long side at most twice the short. A phone image of
// at least 1080px on its short side is what makes the listing eligible for
// Play's promotional placements, so the phone set is exactly 1080 x 1920.
//
//   phone         360 x 640  @3  ->  1080 x 1920
//   7" tablet     603 x 1072 @2  ->  1206 x 2144   (600dp is a 7" tablet)
//   10" tablet    810 x 1440 @2  ->  1620 x 2880   (800dp is a 10" tablet)
//
// All three are exactly 9:16. Touch is ON for every size: Android tablets are
// touch devices, and this app sizes its controls by input (`touch:`), not by
// width, so a mouse-emulated tablet would photograph the desktop control
// sizes a tablet user never sees.
//
// ── NOT A TEST, AND NOT IN CI ────────────────────────────────────────────
//
// A deliverable generator, exempt in the-sweeps-are-not-the-whole-suite for
// the same reason as the App Store spec. Run it on demand:
//
//   npm run screenshots:play
//
// Output: android/screenshots/<size>/<order>-<name>.png (gitignored).
import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { STORE_SHOTS, openStoreShot } from "./fixtures/store-shots";

const OUT = join(process.cwd(), "android", "screenshots");

const SIZES = [
  { name: "phone", width: 360, height: 640, scale: 3, mobile: true },
  { name: "7-inch-tablet", width: 603, height: 1072, scale: 2, mobile: false },
  { name: "10-inch-tablet", width: 810, height: 1440, scale: 2, mobile: false },
];

for (const size of SIZES) {
  test.describe(`${size.name}`, () => {
    test.use({
      viewport: { width: size.width, height: size.height },
      deviceScaleFactor: size.scale,
      isMobile: size.mobile,
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
        // catches a file that came out empty anyway, and a size Play would
        // refuse.
        expect(png.byteLength, `${file} looks empty`).toBeGreaterThan(20_000);
        const w = png.readUInt32BE(16);
        const h = png.readUInt32BE(20);
        expect([w, h], `${file} is ${w}x${h}`).toEqual([
          size.width * size.scale,
          size.height * size.scale,
        ]);
        expect(h / w, "9:16").toBeCloseTo(16 / 9, 2);
      });
    }
  });
}
