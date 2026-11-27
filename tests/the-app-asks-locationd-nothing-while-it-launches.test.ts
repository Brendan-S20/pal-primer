// The app froze on a blank screen while it launched, waiting for locationd.
//
// Run 45828319213 (iPhone 17e, iOS 26.5): @capacitor/geolocation built its
// CLLocationManager in load(), on the main thread, before the page was
// requested, and the synchronous authorizationStatus read inside it did not
// return for 77 to 329 s. scripts/patch-native-plugins.mjs moves the manager
// to the first plugin call that wants it; its comment has the measurements.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- a plain .mjs script with no type declarations
import { patchGeolocationPlugin, PLUGINS } from "../scripts/patch-native-plugins.mjs";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Byte-for-byte the GeolocationPlugin.swift shipped in @capacitor/geolocation 8.2.0. */
const ORIGINAL = read("tests/support/fixtures/capacitor-geolocation-8.2.0.GeolocationPlugin.swift");
const GEO = PLUGINS.find((p: { name: string }) => p.name === "@capacitor/geolocation");

/** The text of `override public func load()`, to its closing brace. */
const loadBody = (swift: string) => {
  const from = swift.indexOf("override public func load()");
  return swift.slice(from, swift.indexOf("\n    }\n", from));
};

describe("the location manager is not built while the app launches", () => {
  it("the shipped plugin builds it in load(), which is the whole problem", () => {
    expect(loadBody(ORIGINAL)).toContain("IONGLOCManagerWrapper()");
  });

  it("patched, load() neither builds nor reads it", () => {
    const { status, text } = patchGeolocationPlugin(ORIGINAL);
    expect(status).toBe("patched");
    expect(loadBody(text)).not.toMatch(/IONGLOC|locationService|CLLocationManager/i);
    // One constructor call in the whole file: the first-use one.
    expect(text.match(/IONGLOCManagerWrapper\(\)/g)).toHaveLength(1);
  });

  it("builds it on the main thread, because plugin methods run on the bridge queue", () => {
    const { text } = patchGeolocationPlugin(ORIGINAL);
    expect(text).toContain("if Thread.isMainThread { return makeLocationServiceOnMain() }");
    expect(text).toContain("return DispatchQueue.main.sync { makeLocationServiceOnMain() }");
  });

  it("is idempotent", () => {
    const once = patchGeolocationPlugin(ORIGINAL).text;
    expect(patchGeolocationPlugin(once)).toEqual({ status: "already-patched", text: once });
  });

  it("FAILS the install when an upgrade changes either line", () => {
    for (const changed of [
      ORIGINAL.replace("self.locationService = IONGLOCManagerWrapper()", "self.setUp()"),
      ORIGINAL.replace("private var locationService:", "private var service:"),
    ]) {
      expect(() => patchGeolocationPlugin(changed, "geolocation/Plugin.swift")).toThrow(
        /geolocation\/Plugin\.swift: expected the locationService property.*scripts\/patch-native-plugins\.mjs/s,
      );
    }
  });

  it("the installed plugin in this checkout is patched", () => {
    // True after any `npm ci` / `npm install` here.
    const installed = read(`node_modules/${GEO.name}/${GEO.file}`);
    expect(patchGeolocationPlugin(installed).status).toBe("already-patched");
    expect(loadBody(installed)).not.toContain("IONGLOCManagerWrapper");
  });
});
