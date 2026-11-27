// `postinstall`: the two changes this repo makes to installed Capacitor
// plugins. One makes a plugin that has not caught up with Capacitor 8
// resolvable by Swift Package Manager (below). The other stops
// @capacitor/geolocation asking the location daemon for anything while the app
// launches (patchGeolocationPlugin).
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
//
// @capacitor-community/apple-sign-in 7.1.0 is the newest release on npm, and
// there is no Capacitor 8 release of it. Its Package.swift says
//
//   .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "7.0.0")
//
// which SPM reads as 7.0.0..<8.0.0. ios/App/CapApp-SPM/Package.swift pins the
// same package `exact: "8.4.3"`, and every other plugin asks for 8.x, so the
// graph has no solution and nothing builds:
//
//   xcodebuild: error: Could not resolve package dependencies:
//     Failed to resolve dependencies Dependencies could not be resolved
//     because 'apple-sign-in' depends on 'capacitor-swift-pm' 7.0.0..<8.0.0
//     and 'status-bar' depends on 'capacitor-swift-pm' 8.0.0..<9.0.0.
//
// That is the first thing an Xcode Cloud archive does after ci_post_clone.sh,
// so with Sign in with Apple on main no TestFlight build could be produced.
//
// The plugin's Swift needs nothing else: it uses CAPPlugin + CAPBridgedPlugin,
// `pluginMethods`, `bridge.saveCall` / `savedCall(withID:)` / `releaseCall(_:)`
// and `call.resolve(_:)` / `call.reject(_:)`, all of which Capacitor 8.4.3
// still declares un-deprecated (node_modules/@capacitor/ios/Capacitor/
// Capacitor/CAPBridgeProtocol.swift, CAPPluginCall.swift). The only change is
// the version range.
//
// ── WHY A SCRIPT AND NOT patch-package ───────────────────────────────────
//
// One line in one file, and the interesting property is not "apply this diff"
// but "say so if the line has moved". A diff that no longer applies is the
// case patch-package handles worst. No dependency, and `node file.mjs` runs
// the same under sh and PowerShell (CLAUDE.md: CI runs on Windows too).
//
// ── WHY IT FAILS THE INSTALL WHEN IT CANNOT PATCH ────────────────────────
//
// Because the alternative is silent. If the plugin is upgraded and the line
// changes shape, a script that shrugs leaves the iOS build broken in a way
// nobody sees until Xcode Cloud fails. A file that already accepts Capacitor
// 8 (a future plugin release, or a second run of this script) is fine and
// reported; anything else stops `npm ci` with a message saying what to do.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SWIFT_PM = String.raw`\.package\(\s*url:\s*"https://github\.com/ionic-team/capacitor-swift-pm\.git"\s*,\s*from:\s*"`;

/** What Capacitor 7 plugins declare: `from: "7.x.y"`. */
const CAPACITOR_7 = new RegExp(`(${SWIFT_PM})7\\.\\d+\\.\\d+(")`);
/** Already resolvable alongside CapApp-SPM's exact 8.x pin. */
const CAPACITOR_8 = new RegExp(`${SWIFT_PM}8\\.\\d+\\.\\d+"`);

// ── GEOLOCATION: NOTHING AT LAUNCH ─────────────────────────────────────────
//
// @capacitor/geolocation 8.2.0 builds its CLLocationManager in load(), which
// Capacitor runs on the main thread inside SceneDelegate, before the web view
// has been asked to load anything. The library reads authorizationStatus in
// that constructor, and the read is a synchronous XPC call to locationd. For
// as long as locationd does not answer, the app is a frozen blank screen.
//
// Measured on the CI Mac (run 45828319213, iPhone 17e, iOS 26.5, after a
// simulator reboot): the main thread sat in that call for 329 s, 77 s and
// 108 s on three launches, and on a fourth had not returned 115 s in, when
// XCTest failed the test with "process main thread busy for 30.0s". `sample`
// of the first: GeolocationPlugin.load() → IONGLOCManagerWrapper.init →
// CLLocationManager.authorizationStatus → mach_msg. In every launch that
// returned, the page's loadRequest followed within 50 ms.
//
// Nothing needs location until the web app calls the plugin, so the manager is
// built on the first call that wants it. It is still built on the MAIN thread:
// plugin methods run on Capacitor's "bridge" queue, and a CLLocationManager
// delivers its delegate callbacks to the run loop of the thread that made it.
// A queue's thread has none, so built there, no permission answer or position
// would ever arrive.

const LOAD_TIME_PROPERTY = "    private var locationService: (any IONGLOCService)?\n";
const LOAD_TIME_CREATE = "        self.locationService = IONGLOCManagerWrapper()\n";
const FIRST_USE_MARK = "// HoundStack: built on first use, never in load()";
const FIRST_USE_PROPERTY = `    ${FIRST_USE_MARK} (scripts/patch-native-plugins.mjs).
    private var createdLocationService: (any IONGLOCService)?
    private var locationService: (any IONGLOCService)? {
        if Thread.isMainThread { return makeLocationServiceOnMain() }
        return DispatchQueue.main.sync { makeLocationServiceOnMain() }
    }
    private func makeLocationServiceOnMain() -> any IONGLOCService {
        if let service = createdLocationService { return service }
        let service = IONGLOCManagerWrapper()
        createdLocationService = service
        return service
    }
`;

/**
 * Move GeolocationPlugin.swift's location manager from load() to first use.
 * Pure, so it can be tested on a fixture.
 *
 * @returns {{ status: "patched" | "already-patched", text: string }}
 * @throws when the file is neither patched nor the shape this was written for
 */
export function patchGeolocationPlugin(text, label = "GeolocationPlugin.swift") {
  if (text.includes(FIRST_USE_MARK)) return { status: "already-patched", text };
  const once = (line) => text.split(line).length === 2;
  if (!once(LOAD_TIME_PROPERTY) || !once(LOAD_TIME_CREATE)) {
    throw new Error(
      `${label}: expected the locationService property and its creation in load(), once each, ` +
        `and did not find them. The plugin has probably been upgraded. Check that it creates no ` +
        `CLLocationManager while the app launches, then update or remove its entry in ` +
        `scripts/patch-native-plugins.mjs.`,
    );
  }
  return {
    status: "patched",
    text: text.replace(LOAD_TIME_CREATE, "").replace(LOAD_TIME_PROPERTY, () => FIRST_USE_PROPERTY),
  };
}

export const PLUGINS = [
  {
    name: "@capacitor-community/apple-sign-in",
    file: "Package.swift",
    patch: patchPackageSwift,
    patched: 'capacitor-swift-pm range set to from: "8.0.0"',
    unchanged: "already accepts Capacitor 8, nothing to do",
  },
  {
    name: "@capacitor/geolocation",
    file: "ios/Sources/GeolocationPlugin/GeolocationPlugin.swift",
    patch: patchGeolocationPlugin,
    patched: "location manager moved from load() to first use",
    unchanged: "already creates its location manager on first use, nothing to do",
  },
];

/**
 * Rewrite one Package.swift so its capacitor-swift-pm range is 8.0.0..<9.0.0.
 * Pure, so it can be tested on a fixture.
 *
 * @returns {{ status: "patched" | "already-capacitor-8", text: string }}
 * @throws when the file neither has the Capacitor 7 line nor already accepts 8
 */
export function patchPackageSwift(text, label = "Package.swift") {
  if (CAPACITOR_8.test(text)) return { status: "already-capacitor-8", text };
  if (!CAPACITOR_7.test(text)) {
    throw new Error(
      `${label}: expected a capacitor-swift-pm dependency declared \`from: "7.x.y"\` ` +
        `(or one already on 8.x) and found neither. The plugin has probably been upgraded. ` +
        `Check that its Package.swift resolves alongside ios/App/CapApp-SPM/Package.swift ` +
        `(capacitor-swift-pm exact 8.x), then update or remove its entry in ` +
        `scripts/patch-native-plugins.mjs.`,
    );
  }
  return { status: "patched", text: text.replace(CAPACITOR_7, "$18.0.0$2") };
}

/** Patch every listed plugin under `root/node_modules`. Throws on the first
 *  one that cannot be patched; a missing plugin is an error too, because a
 *  removed dependency should take its entry here with it. */
export function patchNativePlugins(root, log = console.log) {
  const results = [];
  for (const p of PLUGINS) {
    const path = join(root, "node_modules", p.name, p.file);
    if (!existsSync(path)) {
      throw new Error(
        `${p.name}/${p.file} is not installed. If the dependency was removed, remove its entry ` +
          `from scripts/patch-native-plugins.mjs too.`,
      );
    }
    const before = readFileSync(path, "utf8");
    const { status, text } = p.patch(before, `${p.name}/${p.file}`);
    if (status === "patched") writeFileSync(path, text);
    log(`[patch-native-plugins] ${p.name}: ${status === "patched" ? p.patched : p.unchanged}`);
    results.push({ name: p.name, status });
  }
  return results;
}

/** Run as a script rather than imported by a test. Compared by REAL path:
 *  import.meta.url is resolved through symlinks and argv[1] is not, so on a
 *  macOS temp dir (/var → /private/var) or a symlinked checkout a plain string
 *  comparison says "imported" and the script silently does nothing — exit 0,
 *  file unpatched, which is the one outcome this script exists to prevent. */
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    patchNativePlugins(root);
  } catch (e) {
    console.error(`\n[patch-native-plugins] FAILED: ${e instanceof Error ? e.message : e}\n`);
    console.error(
      "Without these patches the iOS project does not resolve (Xcode Cloud cannot archive) or the " +
        "app waits on locationd while it launches. See the comments in this script and " +
        "docs/ios-build.md › Capacitor 8 and a plugin that is still on 7.\n",
    );
    // Loud where an iOS build depends on it: a Mac (local Xcode, Xcode Cloud)
    // and GitHub Actions. Anywhere else — Lovable's web build runs bun's
    // postinstall too — the web bundle does not need the patch, and failing
    // the install there would block a publish over a file it never reads.
    // PATCH_NATIVE_PLUGINS_STRICT=1|0 overrides, so the tests can pin both.
    const override = process.env.PATCH_NATIVE_PLUGINS_STRICT;
    const iosBuildDependsOnIt = override
      ? override === "1"
      : process.platform === "darwin" ||
        process.env.GITHUB_ACTIONS === "true" ||
        Boolean(process.env.CI_XCODE_CLOUD);
    if (iosBuildDependsOnIt) process.exit(1);
    console.error("[patch-native-plugins] continuing: this install does not build iOS.\n");
  }
}
