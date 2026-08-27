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
import { execFileSync } from "node:child_process";
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
    const json = execFileSync(
      "plutil",
      ["-convert", "json", "-o", "-", join(root, "ios/App/App.xcodeproj/project.pbxproj")],
      { encoding: "utf8" },
    );
    const objects = JSON.parse(json).objects as Record<string, any>;
    const appConfigs = Object.values(objects).filter(
      (o) =>
        o?.isa === "XCBuildConfiguration" &&
        o?.buildSettings?.PRODUCT_BUNDLE_IDENTIFIER === "consulting.thenorth.houndstack",
    );
    expect(appConfigs.length, "no app build configurations found").toBeGreaterThan(0);
    for (const c of appConfigs) {
      expect(
        c.buildSettings.CODE_SIGN_ENTITLEMENTS,
        `a build configuration has no CODE_SIGN_ENTITLEMENTS`,
      ).toMatch(/App\.entitlements/);
    }
  });
});
