// Tap to Pay on iPhone is not offered on an iPad.
//
// #726: Apple reviewed HoundStack 1.0 on an iPad Air 11-inch (M4). Tap to
// Pay on iPhone does not exist on iPad, but TapToPayEducationPlugin only
// asked "iOS 18 or later?", which every iPad on iPadOS 18+ answers yes to.
// So the plugin now checks the device idiom FIRST, in both methods, before
// anything from ProximityReader is touched: isAvailable resolves
// { available: false } and show rejects. The iPhone path keeps its
// ProximityReader and iOS 18 checks.
//
// Static, like tests/ios-27-would-not-launch-an-app-without-a-scene.test.ts:
// the Swift is read, comments removed, and its shape pinned. Whether it
// behaves on a device is for the Mac run.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const swift = codeOnly(read("ios/App/App/TapToPay/TapToPayEducationPlugin.swift"));

/** The body of `@objc func <name>(...)`, up to the next @objc func or the end. */
function method(name: string): string {
  const start = swift.indexOf(`@objc func ${name}(`);
  expect(start, `no @objc func ${name}`).toBeGreaterThan(-1);
  const next = swift.indexOf("@objc func ", start + 1);
  return swift.slice(start, next === -1 ? undefined : next);
}

describe("TapToPayEducationPlugin on an iPad", () => {
  it("decides 'iPad' from the device idiom", () => {
    expect(swift).toMatch(/UIDevice\.current\.userInterfaceIdiom == \.pad/);
  });

  it("isAvailable answers false on an iPad before any iOS 18 or ProximityReader check", () => {
    const body = method("isAvailable");
    const guard = body.search(
      /if TapToPayEducationPlugin\.isPad \{\s*call\.resolve\(\["available": false\]\)\s*return\s*\}/,
    );
    expect(guard, "isAvailable has no iPad guard that resolves available: false").toBeGreaterThan(
      -1,
    );
    expect(guard).toBeLessThan(body.indexOf("#if canImport(ProximityReader)"));
    expect(guard).toBeLessThan(body.indexOf("#available(iOS 18.0, *)"));
  });

  it("show rejects on an iPad before anything is presented", () => {
    const body = method("show");
    const guard = body.search(
      /if TapToPayEducationPlugin\.isPad \{\s*call\.reject\("[^"]+"\)\s*return\s*\}/,
    );
    expect(guard, "show has no iPad guard that rejects").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf("#if canImport(ProximityReader)"));
    expect(guard).toBeLessThan(body.indexOf("ProximityReaderDiscovery()"));
  });

  it("keeps the iPhone path's ProximityReader and iOS 18 checks", () => {
    for (const name of ["isAvailable", "show"]) {
      const body = method(name);
      expect(body).toMatch(/#if canImport\(ProximityReader\)/);
      expect(body).toMatch(/if #available\(iOS 18\.0, \*\)/);
    }
    expect(method("isAvailable")).toMatch(/call\.resolve\(\["available": true\]\)/);
  });

  it("the JS helper returns the native answer and turns a rejection into false", () => {
    const ts = read("src/lib/tap-to-pay-education-native.ts");
    expect(ts).toMatch(/return \(await native\(\)\.isAvailable\(\)\)\.available;/);
    const show = ts.slice(ts.indexOf("export async function showAppleEducation"));
    expect(show).toMatch(/return \(await native\(\)\.show\(\)\)\.shown;/);
    expect(show).toMatch(/catch \{\s*return false;\s*\}/);
  });
});
