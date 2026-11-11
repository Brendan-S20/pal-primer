// A Release archive is signed with a DISTRIBUTION profile, and a distribution
// profile can only carry the capabilities Apple has approved for distribution.
//
// ── THE FAILURE THIS GUARDS ───────────────────────────────────────────────
//
// #757 (Tap to Pay, #579) added
// com.apple.developer.proximity-reader.payment.acceptance to App.entitlements,
// which every configuration signed with. Apple granted the Tap to Pay on
// iPhone entitlement for DEVELOPMENT only (case 23404969; distribution is a
// separate, later approval). Once #847 let the Xcode Cloud archive compile,
// it failed at export instead, on main 97693805, 8ddfcc2c and 41b87d70:
//
//     Exporting for App Store Distribution failed.
//     Exporting for Ad Hoc Distribution failed.
//
// Both are distribution profiles, and the archive itself built. No TestFlight
// build could ship.
//
// So Release now signs with App.Release.entitlements, which is App.entitlements
// minus every key on DEVELOPMENT_ONLY below, and the app is told which it is
// (HS_TAP_TO_PAY_ENTITLED -> Info.plist HSTapToPayEntitled ->
// window.__HS_TAP_TO_PAY_ENTITLED__) so a Release build hides the button.
//
// ── WHAT THIS CHECKS ──────────────────────────────────────────────────────
//
//   * Release's entitlements hold ONLY keys on APPROVED_FOR_DISTRIBUTION. A new
//     capability has to be added there on purpose, by someone who has checked
//     Apple approved it for distribution, before a Release build may ask for it.
//   * Release = Debug minus DEVELOPMENT_ONLY, value for value. Two files that
//     drift apart (a new associated domain added to one) are caught here.
//   * HS_TAP_TO_PAY_ENTITLED agrees with the file each configuration signs with.
//   * The flag reaches the page, and the button reads it.
//
// To re-enable Tap to Pay in Release once Apple approves distribution: see
// docs/tap-to-pay-release-entitlements.md.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const TAP_TO_PAY_KEY = "com.apple.developer.proximity-reader.payment.acceptance";

/** Entitlements Apple has approved for DISTRIBUTION on this app ID. */
const APPROVED_FOR_DISTRIBUTION = [
  "aps-environment",
  "com.apple.developer.associated-domains",
  "com.apple.developer.applesignin",
];

/** Granted for development only. Move a key from here to the list above, in
 *  the same change that adds it to App.Release.entitlements, once Apple
 *  approves it for distribution. */
const DEVELOPMENT_ONLY = [TAP_TO_PAY_KEY];

/** The app target's build configurations, by name. Same approach as
 *  sign-in-with-apple-without-a-browser.test.ts: scope to the
 *  XCBuildConfiguration section, balance braces, strip block comments. */
function appConfigurations(pbxproj: string): Record<string, Record<string, string>> {
  const from = pbxproj.indexOf("/* Begin XCBuildConfiguration section */");
  const to = pbxproj.indexOf("/* End XCBuildConfiguration section */");
  expect(from, "no XCBuildConfiguration section").toBeGreaterThan(-1);
  const section = pbxproj.slice(from, to);
  const out: Record<string, Record<string, string>> = {};
  const opener = /buildSettings = \{/g;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(section))) {
    let i = m.index + m[0].length;
    let depth = 1;
    while (i < section.length && depth > 0) {
      if (section[i] === "{") depth++;
      else if (section[i] === "}") depth--;
      i++;
    }
    const body = section.slice(m.index + m[0].length, i - 1).replace(/\/\*[\s\S]*?\*\//g, "");
    const settings: Record<string, string> = {};
    for (const line of body.split("\n")) {
      const kv = /^\s*([A-Za-z0-9_]+)\s*=\s*(.+?);\s*$/.exec(line);
      if (kv) settings[kv[1]] = kv[2].replace(/^"(.*)"$/, "$1");
    }
    const name = /^\s*name = ([A-Za-z]+);/m.exec(section.slice(i, i + 200))?.[1];
    if (settings.PRODUCT_BUNDLE_IDENTIFIER === "consulting.thenorth.houndstack" && name) {
      out[name] = settings;
    }
  }
  return out;
}

/** Top-level keys of an entitlements plist, each with its raw value XML. */
function entitlements(xml: string): Map<string, string> {
  const dict = /<plist[^>]*>\s*<dict>([\s\S]*)<\/dict>\s*<\/plist>/.exec(xml)?.[1];
  expect(dict, "not a plist with a top-level dict").toBeTruthy();
  const out = new Map<string, string>();
  const re =
    /<key>([^<]+)<\/key>\s*(<true\/>|<false\/>|<string>[^<]*<\/string>|<array>[\s\S]*?<\/array>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dict!))) out.set(m[1], m[2].replace(/\s+/g, ""));
  // Every <key> must have been read, or a value shape this does not know
  // would be skipped silently and the check would pass on nothing.
  expect(out.size, "an entitlement value this parser cannot read").toBe(
    (dict!.match(/<key>/g) ?? []).length,
  );
  return out;
}

const configs = appConfigurations(read("ios/App/App.xcodeproj/project.pbxproj"));
const entitlementsOf = (config: string) => {
  const path = configs[config]?.CODE_SIGN_ENTITLEMENTS;
  expect(path, `${config} has no CODE_SIGN_ENTITLEMENTS`).toBeTruthy();
  const file = `ios/App/${path}`;
  expect(existsSync(join(root, file)), `${file} is missing`).toBe(true);
  return entitlements(read(file));
};

describe("a Release archive asks only for what a distribution profile can carry", () => {
  it("the app target has a Debug and a Release configuration", () => {
    expect(Object.keys(configs).sort()).toEqual(["Debug", "Release"]);
  });

  // No App scheme is committed, so Xcode Cloud archives with the scheme Xcode
  // generates, whose Archive action is Release. That is why Release is the
  // configuration held to the distribution list.

  it("Release's entitlements hold only keys approved for distribution", () => {
    const keys = [...entitlementsOf("Release").keys()];
    const unapproved = keys.filter((k) => !APPROVED_FOR_DISTRIBUTION.includes(k));
    expect(unapproved, "Release asks for an entitlement not approved for distribution").toEqual([]);
    expect(keys).not.toContain(TAP_TO_PAY_KEY);
  });

  it("Release is Debug minus the development-only keys, value for value", () => {
    const debug = entitlementsOf("Debug");
    const release = entitlementsOf("Release");
    const expected = new Map([...debug].filter(([k]) => !DEVELOPMENT_ONLY.includes(k)));
    expect(Object.fromEntries(release)).toEqual(Object.fromEntries(expected));
  });

  it("Debug still carries Tap to Pay, so a development build can tap", () => {
    expect(entitlementsOf("Debug").get(TAP_TO_PAY_KEY)).toBe("<true/>");
  });

  it("HS_TAP_TO_PAY_ENTITLED agrees with the file each configuration signs with", () => {
    for (const name of Object.keys(configs)) {
      const has = entitlementsOf(name).get(TAP_TO_PAY_KEY) === "<true/>";
      expect(configs[name].HS_TAP_TO_PAY_ENTITLED, `${name}: HS_TAP_TO_PAY_ENTITLED`).toBe(
        has ? "YES" : "NO",
      );
    }
  });
});

describe("the app knows which it is, and hides the button when it is not entitled", () => {
  it("Info.plist carries the build setting", () => {
    expect(read("ios/App/App/Info.plist")).toMatch(
      /<key>HSTapToPayEntitled<\/key>\s*<string>\$\(HS_TAP_TO_PAY_ENTITLED\)<\/string>/,
    );
  });

  it("the bridge hands it to the page before any page script runs", () => {
    const swift = read("ios/App/App/HSBridgeViewController.swift");
    expect(swift).toMatch(/forInfoDictionaryKey: "HSTapToPayEntitled"/);
    expect(swift).toMatch(/window\.__HS_TAP_TO_PAY_ENTITLED__ = /);
    expect(swift).toMatch(
      /source: Self\.tapToPayEntitledScript\(Self\.tapToPayEntitled\(\)\),\s*injectionTime: \.atDocumentStart/,
    );
  });

  it("the button returns nothing when the binary is not entitled", () => {
    const button = read("src/components/TapToPayButton.tsx");
    expect(button).toMatch(/if \(!tapToPayEntitled\(Capacitor\.getPlatform\(\)\)\) return null;/);
  });

  it("an iPhone without the flag, or with it false, is not entitled; Android is unaffected", async () => {
    const { tapToPayEntitled } = await import("@/lib/tap-to-pay-entitlement");
    expect(tapToPayEntitled("ios", undefined)).toBe(false);
    expect(tapToPayEntitled("ios", false)).toBe(false);
    expect(tapToPayEntitled("ios", "true")).toBe(false);
    expect(tapToPayEntitled("ios", true)).toBe(true);
    expect(tapToPayEntitled("android", undefined)).toBe(true);
  });
});

describe("a Mac measures what Xcode resolves, on every pull request that could change it", () => {
  const wf = read(".github/workflows/ios-release-entitlements.yml");
  const code = wf
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  it("runs on a pull request touching the entitlements, Info.plist or the project, drafts included", () => {
    for (const p of [
      "ios/App/App/*.entitlements",
      "ios/App/App/Info.plist",
      "ios/App/App.xcodeproj/project.pbxproj",
    ]) {
      expect(code).toContain(`"${p}"`);
    }
    // ios-launch.yml skips drafts; this one must not, or the question goes
    // unasked on exactly the draft that changes the answer.
    expect(code).not.toMatch(/pull_request\.draft/);
  });

  it("runs the check script, which asserts both directions", () => {
    expect(code).toMatch(/run: scripts\/ios-release-entitlements-check\.sh/);
    const script = read("scripts/ios-release-entitlements-check.sh");
    expect(script).toContain('KEY="com.apple.developer.proximity-reader.payment.acceptance"');
    expect(script).toMatch(
      /CONFIG" = Debug \]; then WANT_KEY=yes; WANT_FLAG=YES; else WANT_KEY=no; WANT_FLAG=NO/,
    );
    // Nothing measured must not read as a pass.
    expect(script).toMatch(/nothing was measured\."\s*\n\s*fail=1/);
  });
});
