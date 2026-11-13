// Play filters a listing by <uses-feature>. A permission implies a feature
// (BLUETOOTH_CONNECT, merged in by Stripe Terminal, implies
// android.hardware.bluetooth), and an implied feature is REQUIRED unless the
// manifest says otherwise — so a Wi-Fi-only tablet, or a device without
// Bluetooth, could not install the app. Telephony and Bluetooth are declared
// optional, like the camera, location and NFC already are.
//
// Also pinned: the release bundle carries native debug symbols for Play
// Console, and minSdk stays 26, the Stripe Terminal floor (#757).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("android hygiene", () => {
  const manifest = read("android/app/src/main/AndroidManifest.xml");

  it.each(["telephony", "bluetooth", "camera", "location", "nfc"])(
    "android.hardware.%s is declared not required",
    (feature) => {
      const tag = manifest.match(
        new RegExp(`<uses-feature\\b[^>]*android:name="android\\.hardware\\.${feature}"[^>]*>`),
      );
      expect(tag, `no <uses-feature> for android.hardware.${feature}`).not.toBeNull();
      expect(tag![0]).toContain('android:required="false"');
    },
  );

  it("no <uses-feature> is required", () => {
    const tags = manifest.match(/<uses-feature\b[^>]*>/g) ?? [];
    for (const tag of tags) expect(tag).toContain('android:required="false"');
  });

  it("the release build type ships native debug symbols", () => {
    const gradle = read("android/app/build.gradle");
    const release = gradle.slice(gradle.indexOf("release {", gradle.indexOf("buildTypes")));
    expect(release).toMatch(/ndk\s*\{\s*debugSymbolLevel\s+'SYMBOL_TABLE'\s*\}/);
  });

  it("minSdk stays 26 (Stripe Terminal floor, #757)", () => {
    expect(read("android/variables.gradle")).toMatch(/minSdkVersion\s*=\s*26\b/);
  });
});
