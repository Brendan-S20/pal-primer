// iOS 27 would not launch an app that had not adopted scenes.
//
// ── WHAT HAPPENED ─────────────────────────────────────────────────────────
//
// #570. Built with Xcode 27.1, the app stopped on every launch on iOS 27.1,
// three of three, with SIGTRAP in
// _UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption. Info.plist
// had UIMainStoryboardFile and no UIApplicationSceneManifest: the shape
// Capacitor's iOS template still generates, in which the app delegate owns
// the window. iOS 13 introduced scenes; iOS 27 is where not having one is
// fatal.
//
// ── WHY A TEST, WHEN THE FIX IS A FEW FILES ───────────────────────────────
//
// Because the files belong partly to Capacitor. `npx cap add ios` writes the
// template back, and the template has no scene. And because adopting scenes
// silently MOVES work: once a scene connects, UIKit stops calling the app
// delegate for URL opens, Universal Links and becoming active. Code left in
// AppDelegate for those compiles, reads as handling them, and never runs. The
// lock-screen Navigate hand-off and the OAuth return both live on that path.
//
// What is pinned, and nothing about how it is written beyond that:
//   - Info.plist declares a scene and no longer names a main storyboard
//   - AppDelegate names SceneDelegate in code too, and keeps the push token
//   - AppDelegate holds no URL, activity or became-active handler any more
//   - SceneDelegate takes links both ways, cold and warm, and only after the
//     bridge exists
//   - SceneDelegate.swift is compiled into the app target
//   - CI launches the app, so the next fault of this kind is seen in a run
//     rather than by the App Store reviewer

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const plist = read("ios/App/App/Info.plist");
const appDelegate = codeOnly(read("ios/App/App/AppDelegate.swift"));
const sceneDelegate = codeOnly(read("ios/App/App/SceneDelegate.swift"));

describe("the app adopts the scene lifecycle", () => {
  it("declares a scene manifest whose delegate is SceneDelegate", () => {
    expect(plist).toMatch(/<key>UIApplicationSceneManifest<\/key>/);
    expect(plist).toMatch(/<key>UIApplicationSupportsMultipleScenes<\/key>\s*<false\/>/);
    expect(plist).toMatch(/<key>UIWindowSceneSessionRoleApplication<\/key>/);
    expect(plist).toMatch(
      /<key>UISceneDelegateClassName<\/key>\s*<string>\$\(PRODUCT_MODULE_NAME\)\.SceneDelegate<\/string>/,
    );
  });

  it("no longer names a main storyboard for the app delegate to load", () => {
    // Both together is what a half-reverted regeneration looks like.
    expect(plist).not.toMatch(/<key>UIMainStoryboardFile<\/key>/);
  });

  it("names the delegate class in code, so it is found through Swift", () => {
    expect(appDelegate).toMatch(
      /configurationForConnecting connectingSceneSession: UISceneSession/,
    );
    expect(appDelegate).toMatch(/configuration\.delegateClass = SceneDelegate\.self/);
  });

  it("keeps the APNs token on the app delegate, the only place iOS sends it", () => {
    expect(appDelegate).toMatch(/didRegisterForRemoteNotificationsWithDeviceToken/);
    expect(appDelegate).toMatch(/didFailToRegisterForRemoteNotificationsWithError/);
  });

  it("leaves no handler on the app delegate that a scene app is never sent", () => {
    expect(appDelegate).not.toMatch(/open url: URL/);
    expect(appDelegate).not.toMatch(/continue userActivity: NSUserActivity/);
    expect(appDelegate).not.toMatch(/func applicationDidBecomeActive/);
    expect(appDelegate).not.toMatch(/ApplicationDelegateProxy/);
  });
});

describe("SceneDelegate builds the window and takes the links", () => {
  it("builds the window from Main.storyboard on its window scene", () => {
    expect(sceneDelegate).toMatch(/class SceneDelegate: UIResponder, UIWindowSceneDelegate/);
    expect(sceneDelegate).toMatch(/UIStoryboard\(name: "Main", bundle: nil\)/);
    expect(sceneDelegate).toMatch(/UIWindow\(windowScene: windowScene\)/);
    expect(sceneDelegate).toMatch(/makeKeyAndVisible\(\)/);
  });

  it("forwards a launch link only once the bridge and its plugins exist", () => {
    // The App plugin listens from load(); a URL posted before the view loads
    // reaches nobody, and the cold-start link is lost without an error.
    const connect = sceneDelegate.slice(sceneDelegate.indexOf("willConnectTo session"));
    const loaded = connect.indexOf("loadViewIfNeeded()");
    expect(loaded).toBeGreaterThan(-1);
    expect(connect.indexOf("connectionOptions.urlContexts")).toBeGreaterThan(loaded);
    expect(connect.indexOf("connectionOptions.userActivities")).toBeGreaterThan(loaded);
  });

  it("takes a link while running, and a Universal Link", () => {
    expect(sceneDelegate).toMatch(/openURLContexts URLContexts: Set<UIOpenURLContext>/);
    expect(sceneDelegate).toMatch(
      /func scene\(_ scene: UIScene, continue userActivity: NSUserActivity\)/,
    );
    expect(sceneDelegate).toMatch(
      /ApplicationDelegateProxy\.shared\.application\(UIApplication\.shared, continue: userActivity/,
    );
  });

  it("is compiled into the app target", () => {
    const pbx = read("ios/App/App.xcodeproj/project.pbxproj");
    const ref = /(\w{24}) \/\* SceneDelegate\.swift \*\/ = \{isa = PBXFileReference/.exec(pbx)?.[1];
    expect(ref, "no file reference for SceneDelegate.swift").toBeTruthy();
    const build = new RegExp(
      `(\\w{24}) /\\* SceneDelegate\\.swift in Sources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref}`,
    ).exec(pbx)?.[1];
    expect(build, "SceneDelegate.swift is referenced but not built").toBeTruthy();
    const sources = pbx.slice(pbx.indexOf("/* Begin PBXSourcesBuildPhase section */"));
    expect(sources).toContain(`${build} /* SceneDelegate.swift in Sources */`);
  });
});

describe("CI launches the app", () => {
  it("runs the cold-launch UI test on a simulator", () => {
    const wf = read(".github/workflows/ios-launch.yml");
    expect(wf).toMatch(/run: scripts\/ios-launch-smoke\.sh/);
    expect(wf).toMatch(/schedule:/);
    const script = read("scripts/ios-launch-smoke.sh");
    expect(script).toMatch(/-only-testing:"HoundStackUITests\/\$1"/);
    // A fresh simulator's first launches took over a minute to paint on the
    // CI Mac; the timed checks run only after the warm-up has painted.
    const warm = script.indexOf("attempt_class ColdLaunchWarmUp warmup");
    expect(warm).toBeGreaterThan(-1);
    expect(warm).toBeLessThan(script.indexOf("attempt_class ColdLaunch launches"));
    // A retry is only for a launch the simulator never started: the
    // message AND no HoundStack process from request to tear-down.
    // The messages and the proof live in scripts/ios-launch-never-started.mjs;
    // tests/the-launch-check-blames-the-simulator-only-with-proof.test.ts
    // runs it on logs from the CI Mac (#726).
    const check = script.slice(script.indexOf("never_started() {"));
    expect(check).toMatch(/node "\$ROOT\/scripts\/ios-launch-never-started\.mjs"/);
    const classifier = read("scripts/ios-launch-never-started.mjs");
    expect(classifier).toMatch(/"Timed out attempting to launch app",\s*"kAXErrorServerNotFound",/);
    expect(classifier).toMatch(/proven: started === 0/);
    expect(read("ios/UITests/UITests.xcodeproj/project.pbxproj")).toMatch(
      /ColdLaunch\.swift in Sources \*\/,/,
    );
    // Says so when the newest runtime is not the one #570 was about.
    expect(script).toMatch(/This run did not exercise iOS 27/);
  });

  it("launches on iOS 26.x too, on a phone and an iPad (#620)", () => {
    const script = read("scripts/ios-launch-smoke.sh");
    // The picker adds the newest 26.x runtime's iPhone and iPad.
    expect(script).toMatch(
      /r26 = next\(\(r for r in rts if r\["version"\]\.split\("\."\)\[0\] == "26"\)/,
    );
    expect(script).toMatch(/take\(r26, .*phones26/);
    expect(script).toMatch(/take\(r26, .*pads26/);
    // And a run without both fails rather than reading green.
    expect(script).toMatch(/This run did not exercise iOS 26 on both an iPhone and an iPad/);
    expect(script).toMatch(/\[ -z "\$\{NO_IOS26:-\}" \] \|\| failed=1/);
    // The same device on two runtimes must not share a result file.
    expect(script).toMatch(/slug=\$\(echo "\$name-iOS-\$runtime_version"/);
  });

  it("can launch one exact runtime and device by hand, with no fallback (#726)", () => {
    // Apple's 1.0 (375) review crash was on an iPad Air 11-inch (M3) on
    // iPadOS 27.2. The automatic picks choose an "iPad (…)" model, so the
    // reviewer's device is only reachable by naming it.
    const wf = read(".github/workflows/ios-launch.yml");
    expect(wf).toMatch(/SMOKE_PIN_RUNTIME: \$\{\{ inputs\.pin_runtime \}\}/);
    expect(wf).toMatch(/SMOKE_PIN_DEVICE_TYPE: \$\{\{ inputs\.pin_device_type \}\}/);
    const script = read("scripts/ios-launch-smoke.sh");
    expect(script).toMatch(
      /sys\.exit\("pinned runtime " \+ pin_rt \+ " is not installed and available"\)/,
    );
    expect(script).toMatch(
      /sys\.exit\("pinned runtime " \+ pin_rt \+ " does not support " \+ pin_type\)/,
    );
    // Pinned output is exactly one device, then the picker stops.
    const pinned = script.slice(script.indexOf("if pin_rt or pin_type:"));
    expect(pinned.indexOf("sys.exit(0)")).toBeLessThan(pinned.indexOf("newest = rts[0]"));
    // The 26.x requirement is waived only for a pinned run.
    expect(script).toMatch(/if \[ -z "\$PINNED" \] && \{ ! echo "\$IOS26_LINES"/);
  });
});

describe("the page needs nothing from the app before its first paint", () => {
  // On the CI Mac, some launches parked the web content process in
  // native-bridge.js's synchronous prompt() for minutes: the app never
  // handled it, and the screen stayed blank. HSBridgeViewController answers
  // the two config questions in the page instead.
  const vc = codeOnly(read("ios/App/App/HSBridgeViewController.swift"));
  const bridgeJs = read("node_modules/@capacitor/ios/Capacitor/Capacitor/assets/native-bridge.js");

  it("answers both prompts native-bridge.js makes at document start", () => {
    for (const type of ["CapacitorCookies.isEnabled", "CapacitorHttp"]) {
      expect(bridgeJs, `native-bridge.js no longer prompts for ${type}`).toContain(
        `type: '${type}'`,
      );
      expect(vc).toContain(`"${type}": "\\(`);
    }
    expect(vc).toMatch(/getPluginConfig\("CapacitorCookies"\)\.getBoolean\("enabled", false\)/);
    expect(vc).toMatch(/getPluginConfig\("CapacitorHttp"\)\.getBoolean\("enabled", false\)/);
    // Anything else still reaches the app.
    expect(vc).toMatch(/return nativePrompt\.apply\(window, arguments\)/);
  });

  it("adds its script before Capacitor adds native-bridge.js", () => {
    const override = vc.slice(vc.indexOf("override func webView(with frame: CGRect"));
    const add = override.indexOf("userContentController.addUserScript(");
    expect(add).toBeGreaterThan(-1);
    expect(add).toBeLessThan(
      override.indexOf("return super.webView(with: frame, configuration: configuration)"),
    );
    expect(override).toMatch(/injectionTime: \.atDocumentStart, forMainFrameOnly: true/);
  });
});
