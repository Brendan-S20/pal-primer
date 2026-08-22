// The Android manifest has to declare what the app actually does.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// `npx cap add android` was run on 2026-08-22. The manifest it generates
// declares exactly one permission — INTERNET — and every Capacitor plugin
// manifest in `node_modules` is EMPTY. Checked, not assumed: they contain a
// bare `<manifest>` element and nothing else. Nothing merges the permissions
// in for you.
//
// So an app that ships nine plugins, three of which need a permission, gets a
// manifest that grants none of them. And the failure mode is the worst kind:
//
//   * CAMERA missing — completing a visit with a photo throws at the moment a
//     tech is standing in a yard trying to prove they were there.
//   * ACCESS_*_LOCATION missing — "locate me" on the route map fails.
//   * POST_NOTIFICATIONS missing — on Android 13+, registration SUCCEEDS,
//     delivery SUCCEEDS, and nothing is ever displayed. There is no error
//     anywhere. The app targets SDK 36, so this is not a future concern.
//
// None of it breaks the build. All of it breaks the product, on a device, in
// front of a customer.
//
// ── WHY A TEST AND NOT A NOTE IN THE README ───────────────────────────────
//
// Because `cap add` is re-runnable and upgrades touch generated projects, so
// this is a file that can be silently reverted by a tool that knows nothing
// about what the app needs. The same argument the iOS UITests project makes
// for living outside `ios/App`.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const MANIFEST = resolve(ROOT, "android/app/src/main/AndroidManifest.xml");

/** Plugin → the permissions it cannot work without. Keyed on the package name
 *  so adding a plugin that needs one and forgetting the manifest fails here. */
const NEEDS: Record<string, string[]> = {
  "@capacitor/camera": ["android.permission.CAMERA"],
  "@capacitor/geolocation": [
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.ACCESS_FINE_LOCATION",
  ],
  "@capacitor/push-notifications": ["android.permission.POST_NOTIFICATIONS"],
};

const androidExists = existsSync(MANIFEST);
const manifest = () => readFileSync(MANIFEST, "utf8");

describe.skipIf(!androidExists)("the Android manifest declares what the app does", () => {
  const installed = () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  };

  it("still has plugins that need permissions, so this file is not vacuous", () => {
    const deps = installed();
    const relevant = Object.keys(NEEDS).filter((p) => deps[p]);
    expect(relevant.length).toBeGreaterThan(0);
  });

  for (const [plugin, perms] of Object.entries(NEEDS)) {
    for (const perm of perms) {
      it(`${plugin} has ${perm.replace("android.permission.", "")}`, () => {
        const deps = installed();
        if (!deps[plugin]) return; // not installed, nothing to require
        expect(
          manifest().includes(`android:name="${perm}"`),
          `${plugin} is installed but the manifest does not declare ${perm}. ` +
            `The plugin's own AndroidManifest.xml is empty — it declares no ` +
            `permissions — so nothing will merge this in. On a device the ` +
            `feature fails at the moment it is used, with no build error.`,
        ).toBe(true);
      });
    }
  }

  it("does not back the signed-in session up to Google Drive", () => {
    // `allowBackup` defaults to true in the generated manifest. The WebView's
    // localStorage holds a Supabase access AND refresh token, so the default
    // copies a live session off the device and restores it onto the next one.
    expect(manifest()).toMatch(/android:allowBackup="false"/);
    expect(manifest()).toMatch(/android:dataExtractionRules="@xml\/data_extraction_rules"/);
    expect(existsSync(resolve(ROOT, "android/app/src/main/res/xml/data_extraction_rules.xml"))).toBe(
      true,
    );
  });

  it("wears its own colours rather than Capacitor's", () => {
    // styles.xml references @color/colorPrimary and friends. With no local
    // colors.xml those resolve against the @capacitor/android library's
    // defaults — Material indigo #3F51B5, pink accent #FF4081 — by resource
    // merging. Nothing fails; the app just wears the framework's palette
    // wherever the theme shows through, starting with the splash.
    const colors = resolve(ROOT, "android/app/src/main/res/values/colors.xml");
    expect(existsSync(colors), "no app-level colors.xml — the theme is Capacitor's").toBe(true);
    const src = readFileSync(colors, "utf8");
    for (const name of ["colorPrimary", "colorPrimaryDark", "colorAccent"]) {
      expect(src).toMatch(new RegExp(`name="${name}"`));
    }
    // The same cream as the iOS launch screen and the SplashScreen config, so
    // the boot sequence is one colour rather than three.
    expect(src.toLowerCase()).toContain("#fdfaf1");
  });
});
