// App Store Connect warned on build 1.0 (247), 2026-10-04:
//   90683: Missing purpose string in Info.plist ... should contain a
//   NSLocationAlwaysAndWhenInUseUsageDescription key.
// The Capacitor Geolocation plugin's binary references the "always" API, so
// Apple wants its purpose string even though HoundStack only ever asks for
// location while the app is open. A warning at upload can be a rejection at
// review. The string says what the app actually does, and this test keeps the
// app from ever starting to ask for background location without anyone
// noticing that the string would then be wrong.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const plist = readFileSync("ios/App/App/Info.plist", "utf8");
const purpose = (key: string) =>
  new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1] ?? null;

describe("location purpose strings", () => {
  it("has both the while-in-use string and the always string Apple asks for", () => {
    expect(purpose("NSLocationWhenInUseUsageDescription")).toBeTruthy();
    expect(purpose("NSLocationAlwaysAndWhenInUseUsageDescription")).toBeTruthy();
  });

  it("says, in the always string, that location is never used in the background", () => {
    expect(purpose("NSLocationAlwaysAndWhenInUseUsageDescription")).toMatch(/never tracks your location in the background/);
  });

  it("is true: no background location mode, and nothing asks for always-on location", () => {
    expect(plist).not.toMatch(/<string>location<\/string>/); // UIBackgroundModes: location
    const native = readFileSync("src/lib/native.ts", "utf8");
    expect(native).not.toMatch(/requestAlwaysAuthorization|backgroundLocation/);
  });
});
