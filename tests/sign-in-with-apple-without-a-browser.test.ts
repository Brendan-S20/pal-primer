// Apple does not need a browser, and the other two do.
//
// ── THE REPORT ───────────────────────────────────────────────────────────
//
// "it opens up a window instead of doing it in the application; I think
// that's lame."
//
// Half fixable. Google refuses OAuth inside an embedded WebView
// (`disallowed_useragent`) and Facebook is no better, so those two must leave
// the app -- that is not a design choice, it is the provider's rule.
//
// Apple is different in kind. ASAuthorization is a system sheet: Face ID, two
// taps, no Safari, no redirect to come back from. The sheet returns an identity
// token and Supabase exchanges it directly, so there is no URL hand-back at all.
//
// ── WHAT THIS COSTS, AND WHY IT IS ON ITS OWN BRANCH ─────────────────────
//
// An entitlement. `com.apple.developer.applesignin` has to be in an
// entitlements file AND named by CODE_SIGN_ENTITLEMENTS in every build
// configuration, and this project had no entitlements file at all. If the
// provisioning profile does not carry the capability the build fails at
// signing, which is not something a unit test can see -- hence a device build
// before this reaches main.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const native = read("src/lib/native-oauth.ts");
const auth = read("src/routes/auth.tsx");

describe("Apple signs in without leaving the app", () => {
  it("uses the system sheet, not the browser", () => {
    expect(native).toMatch(/@capacitor-community\/apple-sign-in/);
    expect(native).toMatch(/signInWithIdToken/);
  });

  it("and Google and Facebook still go out to the browser", () => {
    // Not a preference. Removing this would ship a Google button that cannot
    // work, which is the state the app shipped in for weeks.
    expect(native).toMatch(/@capacitor\/browser/);
    expect(auth).toMatch(/provider === "apple"/);
  });

  it("hashes the nonce for Apple and keeps the raw one for Supabase", () => {
    // THE subtle one. Apple binds the token to SHA-256(nonce); Supabase wants
    // the string that hashes to it. Send the same value to both and the sheet
    // still appears and the token still comes back -- Supabase then rejects it
    // with a message about the nonce that reads like a library bug.
    const fn = native.slice(native.indexOf("export async function nativeAppleSignIn"));
    expect(fn).toMatch(/crypto\.subtle\.digest\("SHA-256"/);
    expect(fn).toMatch(/nonce: hashed/);
    expect(fn).toMatch(/nonce: raw/);
    // And they must not be the same value.
    expect(fn).not.toMatch(/nonce: raw[\s\S]{0,200}?nonce: raw/);
  });
});

/** Every XCBuildConfiguration's buildSettings, as flat key/value maps.
 *
 *  A pbxproj is an OpenStep plist, which is why the original reached for
 *  plutil. Only one question is being asked of it, so a full plist parser is
 *  not needed: scope to the XCBuildConfiguration section, balance the braces
 *  of each `buildSettings = { ... }`, and read `KEY = value;` lines out of it.
 *  Block comments are stripped first so a commented-out setting cannot be
 *  mistaken for a live one. */
function buildConfigurations(pbxproj: string): Array<Record<string, string>> {
  const from = pbxproj.indexOf("/* Begin XCBuildConfiguration section */");
  const to = pbxproj.indexOf("/* End XCBuildConfiguration section */");
  if (from === -1 || to === -1) return [];
  const section = pbxproj.slice(from, to);
  const out: Array<Record<string, string>> = [];
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
    out.push(settings);
  }
  return out;
}

describe("the entitlement the sheet cannot work without", () => {
  const entitlements = "ios/App/App/App.entitlements";

  it("exists and asks for Sign in with Apple", () => {
    expect(existsSync(join(root, entitlements)), `${entitlements} is missing`).toBe(true);
    expect(read(entitlements)).toMatch(/com\.apple\.developer\.applesignin/);
  });

  it("is named by EVERY build configuration, not just one", () => {
    // Setting it on Release only builds fine and fails on device in Debug,
    // which is the slowest possible way to find out. Parsed rather than
    // grepped: project.pbxproj is a plist, and a grep cannot tell a build
    // setting from a comment.
    // Parsed in JS rather than shelled out to `plutil`.
    //
    // plutil is macOS-only, so this test threw `spawnSync plutil ENOENT` on
    // every non-Mac. CI did not notice because it runs on a self-hosted Mac —
    // but ci.yml documents deleting the CI_RUNNER variable as a one-click
    // switch back to ubuntu-latest, and that switch would have turned this
    // red for a reason that has nothing to do with the code.
    //
    // The reason for parsing rather than grepping still holds and is kept:
    // scoping to the XCBuildConfiguration section and balancing braces means a
    // comment or another object's settings cannot be read as a build setting.
    const appConfigs = buildConfigurations(read("ios/App/App.xcodeproj/project.pbxproj")).filter(
      (c) => c.PRODUCT_BUNDLE_IDENTIFIER === "consulting.thenorth.houndstack",
    );
    expect(appConfigs.length, "no app build configurations found").toBeGreaterThan(0);
    // Debug and Release name different files since Tap to Pay was kept out of
    // Release (App.Release.entitlements), so each named file is read and must
    // ask for Sign in with Apple itself.
    for (const c of appConfigs) {
      expect(
        c.CODE_SIGN_ENTITLEMENTS,
        `a build configuration has no CODE_SIGN_ENTITLEMENTS`,
      ).toMatch(/^App\/App(\.[A-Za-z]+)?\.entitlements$/);
      expect(read(`ios/App/${c.CODE_SIGN_ENTITLEMENTS}`)).toMatch(
        /com\.apple\.developer\.applesignin/,
      );
    }
  });
});
