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
    expect(purpose("NSLocationAlwaysAndWhenInUseUsageDescription")).toMatch(
      /never asks for location in the background or when the app is closed/,
    );
  });

  // Live tracking sends a high accuracy fix that the server stores unrounded
  // and uses to alert the office to a late arrival (#489). Only the
  // customer's view is rounded, so neither string may call it approximate.
  it("does not call the location approximate", () => {
    expect(purpose("NSLocationWhenInUseUsageDescription")).not.toMatch(/approximate/i);
    expect(purpose("NSLocationAlwaysAndWhenInUseUsageDescription")).not.toMatch(/approximate/i);
  });

  it("says, in the while-in-use string, that the location reaches HoundStack and the office", () => {
    const whenInUse = purpose("NSLocationWhenInUseUsageDescription");
    expect(whenInUse).toMatch(/is sent to HoundStack/);
    expect(whenInUse).toMatch(/your office knows if you will be late/);
  });

  it("is true: no background location mode, and nothing asks for always-on location", () => {
    expect(plist).not.toMatch(/<string>location<\/string>/); // UIBackgroundModes: location
    const native = readFileSync("src/lib/native.ts", "utf8");
    expect(native).not.toMatch(/requestAlwaysAuthorization|backgroundLocation/);
  });
});
