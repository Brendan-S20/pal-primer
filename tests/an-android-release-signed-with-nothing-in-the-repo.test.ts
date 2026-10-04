// The Android release build: signed from outside the repo, and numbered on
// purpose.
//
// Play accepts only a signed .aab, and only one whose versionCode is higher
// than every bundle it has seen. Both are easy to get wrong in ways a build
// does not report: a password typed into build.gradle builds perfectly, and a
// versionCode nobody bumped builds perfectly and is refused at upload.
//
// What this pins, statically:
//   * build.gradle reads the upload key from keystore.properties or env vars
//     and applies it ONLY when present, so debug and CI builds keep working;
//   * no password, keystore or keystore.properties is tracked, and the ignore
//     rules that keep them out exist;
//   * the version comes from android/version.properties, and the bump script
//     moves it up by exactly one.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const gradle = () => read("android/app/build.gradle");

describe("release signing is wired without a secret", () => {
  it("reads all four values from env or keystore.properties", () => {
    const g = gradle();
    for (const env of [
      "ANDROID_KEYSTORE_PATH",
      "ANDROID_KEYSTORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
    ]) {
      expect(g).toContain(`'${env}'`);
    }
    expect(g).toContain("rootProject.file('keystore.properties')");
  });

  it("applies the release signingConfig only when it is complete", () => {
    const g = gradle();
    expect(g).toMatch(/if \(hasReleaseSigning\) \{\s*release \{/);
    expect(g).toMatch(/if \(hasReleaseSigning\) \{\s*signingConfig signingConfigs\.release/);
    // Unconditional would break assembleDebug on every machine without a key.
    const unguarded = g
      .split(/\r?\n/)
      .filter((l) => /^\s*signingConfig signingConfigs\.release\s*$/.test(l));
    expect(unguarded.length).toBe(1);
    expect(g).toMatch(/if \(hasReleaseSigning\) \{\s*signingConfig signingConfigs\.release\s*\}/);
  });

  it("contains no literal password", () => {
    expect(gradle()).not.toMatch(/(storePassword|keyPassword)\s+["']/);
  });

  it("keeps keys and their passwords out of git", () => {
    const ignore = read(".gitignore").split(/\r?\n/);
    for (const rule of ["keystore.properties", "*.jks", "*.keystore"]) {
      expect(ignore).toContain(rule);
    }
    const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split(
      /\r?\n/,
    );
    const leaked = tracked.filter(
      (f) => /\.(jks|keystore)$/.test(f) || /(^|\/)keystore\.properties$/.test(f),
    );
    expect(leaked).toEqual([]);
  });

  it("ships a template with no values filled in", () => {
    const t = read("android/keystore.properties.example");
    expect(t).toMatch(/^storePassword=\s*$/m);
    expect(t).toMatch(/^keyPassword=\s*$/m);
  });
});

describe("the version number is explicit and only goes up", () => {
  it("is read from android/version.properties, with an env override", () => {
    const g = gradle();
    expect(g).toContain("versionCode appVersionCode");
    expect(g).toContain("versionName appVersionName");
    expect(g).toContain("rootProject.file('version.properties')");
    expect(g).toContain("ANDROID_VERSION_CODE");
    expect(read("android/version.properties")).toMatch(/^VERSION_CODE=\d+\s*$/m);
  });

  it("bumps by exactly one and leaves the rest of the file alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "android-bump-"));
    const file = join(dir, "version.properties");
    writeFileSync(file, "# keep me\nVERSION_CODE=41\nVERSION_NAME=1.2\n");
    const out = execFileSync("node", [join(root, "scripts/android-bump-version.mjs"), file], {
      encoding: "utf8",
    });
    expect(readFileSync(file, "utf8")).toBe("# keep me\nVERSION_CODE=42\nVERSION_NAME=1.2\n");
    expect(out).toContain("42");
  });

  it("keeps a Windows line ending where it found one", () => {
    const dir = mkdtempSync(join(tmpdir(), "android-bump-"));
    const file = join(dir, "version.properties");
    writeFileSync(file, "VERSION_CODE=9\r\nVERSION_NAME=1.0\r\n");
    execFileSync("node", [join(root, "scripts/android-bump-version.mjs"), file]);
    expect(readFileSync(file, "utf8")).toBe("VERSION_CODE=10\r\nVERSION_NAME=1.0\r\n");
  });

  it("has npm scripts for the bump and the bundle", () => {
    const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;
    expect(scripts["android:bump"]).toContain("scripts/android-bump-version.mjs");
    expect(scripts["android:bundle"]).toMatch(/build:native.*cap sync android.*bundleRelease/);
  });
});
