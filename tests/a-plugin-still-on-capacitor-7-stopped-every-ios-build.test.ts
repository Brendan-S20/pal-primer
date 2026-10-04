// Sign in with Apple's plugin is still on Capacitor 7, and that stopped the
// iOS build before it compiled anything.
//
// @capacitor-community/apple-sign-in 7.1.0 — the newest on npm; there is no
// Capacitor 8 release — declares capacitor-swift-pm `from: "7.0.0"`, i.e.
// 7.0.0..<8.0.0. ios/App/CapApp-SPM/Package.swift pins it `exact: "8.4.1"`.
// Swift Package Manager cannot satisfy both, so `xcodebuild` fails at
// "Resolve Package Graph", and Xcode Cloud could not archive a TestFlight
// build. Found on 2026-10-04 while checking the push-notification branch.
//
// scripts/patch-native-plugins.mjs runs on `postinstall` and moves that one
// range to 8.x. What this file pins is the part that would otherwise rot
// quietly: that the patch still recognises the file it was written for, that
// it is idempotent, that it is actually wired into the install, and that a
// plugin upgrade which changes the line STOPS the install instead of letting
// it through unpatched.
import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
// @ts-expect-error -- a plain .mjs script with no type declarations
import { patchPackageSwift, patchNativePlugins, PLUGINS } from "../scripts/patch-native-plugins.mjs";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Byte-for-byte the Package.swift shipped in apple-sign-in 7.1.0. */
const ORIGINAL = read("tests/support/fixtures/apple-sign-in-7.1.0.Package.swift");

const DEP = '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: ';

describe("the fixture is the file the patch was written for", () => {
  it("declares Capacitor 7, which is the whole problem", () => {
    expect(ORIGINAL).toContain(`${DEP}"7.0.0")`);
  });

  it("is the version package.json installs", () => {
    expect(JSON.parse(read("package.json")).dependencies["@capacitor-community/apple-sign-in"]).toBe(
      "^7.1.0",
    );
  });

  it("CapApp-SPM pins capacitor-swift-pm to an exact 8.x, which 7.0.0..<8.0.0 cannot meet", () => {
    expect(read("ios/App/CapApp-SPM/Package.swift")).toMatch(
      /capacitor-swift-pm\.git", exact: "8\.\d+\.\d+"/,
    );
  });
});

describe("patchPackageSwift", () => {
  it("moves the range to 8.x and changes nothing else", () => {
    const { status, text } = patchPackageSwift(ORIGINAL);
    expect(status).toBe("patched");
    expect(text).toContain(`${DEP}"8.0.0")`);
    expect(text).not.toContain(`${DEP}"7.0.0")`);
    expect(text).toBe(ORIGINAL.replace(`${DEP}"7.0.0")`, `${DEP}"8.0.0")`));
  });

  it("is idempotent: a second run reports and leaves the file alone", () => {
    const once = patchPackageSwift(ORIGINAL).text;
    const twice = patchPackageSwift(once);
    expect(twice.status).toBe("already-capacitor-8");
    expect(twice.text).toBe(once);
  });

  it("accepts a future release that is already on Capacitor 8", () => {
    const future = ORIGINAL.replace('from: "7.0.0"', 'from: "8.1.0"');
    expect(patchPackageSwift(future).status).toBe("already-capacitor-8");
  });

  it("FAILS when an upgrade changes the line into something it does not recognise", () => {
    // An `exact:` pin, a range literal, a different URL — any of these could
    // be fine or broken, and only a person can tell. Guessing silently is how
    // the build broke the first time.
    for (const changed of [
      ORIGINAL.replace('from: "7.0.0"', 'exact: "7.2.0"'),
      ORIGINAL.replace('from: "7.0.0"', '"7.0.0"..<"9.0.0"'),
      ORIGINAL.replace("ionic-team/capacitor-swift-pm", "someone-else/capacitor-swift-pm"),
      ORIGINAL.replace('from: "7.0.0"', 'from: "9.0.0"'),
    ]) {
      expect(() => patchPackageSwift(changed, "apple-sign-in/Package.swift")).toThrow(
        /apple-sign-in\/Package\.swift: expected a capacitor-swift-pm dependency.*scripts\/patch-native-plugins\.mjs/s,
      );
    }
  });
});

describe("the script, run the way npm runs it", () => {
  /** A throwaway repo root holding just the script and the plugin file. */
  function sandbox(packageSwift: string | null) {
    const dir = mkdtempSync(join(tmpdir(), "patch-native-plugins-"));
    mkdirSync(join(dir, "scripts"));
    cpSync(join(root, "scripts/patch-native-plugins.mjs"), join(dir, "scripts/patch-native-plugins.mjs"));
    if (packageSwift !== null) {
      const plugin = join(dir, "node_modules", PLUGINS[0].name);
      mkdirSync(plugin, { recursive: true });
      writeFileSync(join(plugin, "Package.swift"), packageSwift);
    }
    const run = (strict = "1") =>
      spawnSync(process.execPath, [join(dir, "scripts/patch-native-plugins.mjs")], {
        encoding: "utf8",
        env: { ...process.env, PATCH_NATIVE_PLUGINS_STRICT: strict },
      });
    const file = () => readFileSync(join(dir, "node_modules", PLUGINS[0].name, "Package.swift"), "utf8");
    return { dir, run, file, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("patches the 7.1.0 file in place and exits 0, twice", () => {
    const s = sandbox(ORIGINAL);
    try {
      const first = s.run();
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toMatch(/capacitor-swift-pm range set to from: "8\.0\.0"/);
      expect(s.file()).toContain(`${DEP}"8.0.0")`);
      const second = s.run();
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toMatch(/already accepts Capacitor 8/);
    } finally {
      s.done();
    }
  });

  it("exits non-zero, naming the file, when the line is not there", () => {
    const s = sandbox(ORIGINAL.replace('from: "7.0.0"', 'exact: "7.2.0"'));
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/FAILED: @capacitor-community\/apple-sign-in\/Package\.swift/);
      expect(r.stderr).toMatch(/Xcode Cloud/);
      expect(s.file(), "a refused file is left as it was").toContain('exact: "7.2.0"');
    } finally {
      s.done();
    }
  });

  it("exits non-zero when the plugin is not installed at all", () => {
    const s = sandbox(null);
    try {
      const r = s.run();
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/is not installed/);
    } finally {
      s.done();
    }
  });

  it("warns and exits 0 on an install that does not build iOS (Lovable's web build)", () => {
    const s = sandbox(ORIGINAL.replace('from: "7.0.0"', 'exact: "7.2.0"'));
    try {
      const r = s.run("0");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/FAILED: @capacitor-community\/apple-sign-in\/Package\.swift/);
      expect(r.stderr).toMatch(/does not build iOS/);
    } finally {
      s.done();
    }
  });

  it("patchNativePlugins reports per plugin", () => {
    const s = sandbox(ORIGINAL);
    try {
      expect(patchNativePlugins(s.dir, () => {})).toEqual([
        { name: "@capacitor-community/apple-sign-in", status: "patched" },
      ]);
    } finally {
      s.done();
    }
  });
});

describe("it is wired into every install, including Xcode Cloud's", () => {
  it("package.json runs it on postinstall, with no shell-only syntax", () => {
    const post = JSON.parse(read("package.json")).scripts.postinstall;
    expect(post).toBe("node scripts/patch-native-plugins.mjs");
  });

  it("Xcode Cloud's ci_post_clone.sh installs with scripts enabled", () => {
    // `npm ci --ignore-scripts` would skip postinstall and bring the failure
    // straight back, in the one place it is not visible locally. The repo-root
    // copy is a forwarder to this one.
    expect(read("ci_scripts/ci_post_clone.sh")).toMatch(/exec .*ios\/App\/ci_scripts\/ci_post_clone\.sh/);
    const sh = read("ios/App/ci_scripts/ci_post_clone.sh");
    expect(sh).toMatch(/^npm ci$/m);
    expect(sh).not.toMatch(/ignore-scripts/);
  });

  it("the installed plugin in this checkout is patched", () => {
    // True after any `npm ci` / `npm install` here. A red here on a fresh
    // clone means postinstall did not run.
    expect(read(`node_modules/${PLUGINS[0].name}/Package.swift`)).toMatch(
      /capacitor-swift-pm\.git", from: "8\.\d+\.\d+"/,
    );
  });
});
