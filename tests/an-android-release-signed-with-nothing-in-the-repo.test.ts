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
//     moves it up by exactly one;
//   * .github/workflows/android-release.yml, which builds the bundle from CI,
//     takes the key and the Play credential from secrets only, puts the key
//     outside the checkout and deletes it, refuses an unsigned bundle,
//     numbers its builds run_number + 100, keeps the bundle 14 days as
//     houndstack-<versionName>-<versionCode>.aab, and uploads to Play only
//     when the optional PLAY_SERVICE_ACCOUNT_JSON is set.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const gradle = () => read("android/app/build.gradle");

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};
const releaseRaw = () => read(".github/workflows/android-release.yml");
const releaseWorkflow = () =>
  load(releaseRaw()) as {
    on: Record<string, unknown>;
    jobs: Record<string, { "runs-on": string; steps: Step[] }>;
  };
const releaseSteps = () => Object.values(releaseWorkflow().jobs).flatMap((j) => j.steps);

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

describe("the CI release workflow signs with nothing in the repo", () => {
  it("finds the workflow and its steps at all, so a green run means checked", () => {
    // Every assertion below is "no step does X", and all of them pass on a
    // workflow this parser read as empty.
    expect(releaseSteps().length).toBeGreaterThanOrEqual(10);
    expect(releaseSteps().filter((s) => s.run).length).toBeGreaterThanOrEqual(5);
  });

  it("reads the four signing values and the optional Play credential from secrets", () => {
    const raw = releaseRaw();
    for (const secret of [
      "ANDROID_KEYSTORE_BASE64",
      "ANDROID_KEYSTORE_PASSWORD",
      "ANDROID_KEY_ALIAS",
      "ANDROID_KEY_PASSWORD",
      "PLAY_SERVICE_ACCOUNT_JSON",
    ]) {
      expect(raw).toContain(`secrets.${secret}`);
    }
  });

  it("contains no literal keystore or password", () => {
    // Every env or input that carries a credential is exactly a secret
    // reference, and nothing else.
    const credential = /PASSWORD|ALIAS|_BASE64|SERVICE_ACCOUNT|serviceAccountJson/;
    for (const step of releaseSteps()) {
      for (const [key, value] of Object.entries({ ...step.env, ...step.with })) {
        if (!credential.test(key)) continue;
        expect(String(value), `${step.name ?? step.uses}: ${key}`).toMatch(
          /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/,
        );
      }
    }
    expect(releaseRaw()).not.toMatch(/(storePassword|keyPassword)\s*[=:]/);
  });

  it("decodes the key into RUNNER_TEMP, outside the checkout, and always deletes it", () => {
    const steps = releaseSteps();
    const decode = steps.find((s) => /base64 -d/.test(s.run ?? ""));
    expect(decode?.run).toMatch(/base64 -d > "\$RUNNER_TEMP\/upload\.jks"/);
    const build = steps.find((s) => /bundleRelease/.test(s.run ?? ""));
    expect(build?.env?.ANDROID_KEYSTORE_PATH).toBe("${{ runner.temp }}/upload.jks");
    const remove = steps.find((s) => /rm -f "\$RUNNER_TEMP\/upload\.jks"/.test(s.run ?? ""));
    expect(remove?.if).toBe("always()");
  });

  it("refuses an unsigned bundle by reading jarsigner's text, not its exit code", () => {
    const verify = releaseSteps().find((s) => /jarsigner"?\s+-verify/.test(s.run ?? ""));
    expect(verify?.run).toMatch(/jar verified/);
    expect(verify?.run).toMatch(/exit 1/);
  });

  it("never traces its shell, which would print the secrets it handles", () => {
    for (const step of releaseSteps()) {
      expect(step.run ?? "", step.name ?? step.uses).not.toMatch(/set -[a-z]*x|set -o xtrace/);
    }
  });

  it("never pastes an input into a script", () => {
    // `${{ inputs.x }}` in a run block is substituted into the script text
    // before bash reads it, so an input could become a command. They go
    // through env instead.
    for (const step of releaseSteps()) {
      expect(step.run ?? "", step.name ?? step.uses).not.toMatch(/\$\{\{\s*inputs\./);
    }
  });

  it("does not run on push until the manual path has been proven", () => {
    expect(Object.keys(releaseWorkflow().on)).toEqual(["workflow_dispatch"]);
    expect(releaseRaw()).toMatch(/^\s*#\s*push:/m);
  });

  it("numbers a build run_number + 100 unless told otherwise", () => {
    const pick = releaseSteps().find((s) => /RUN_NUMBER/.test(s.run ?? ""));
    expect(pick?.env?.RUN_NUMBER).toBe("${{ github.run_number }}");
    expect(pick?.run).toMatch(/\$\(\(\s*RUN_NUMBER\s*\+\s*100\s*\)\)/);
    expect(pick?.run).toMatch(/ANDROID_VERSION_CODE=.*GITHUB_ENV/);
  });
});

describe("the signed bundle is the product, and the Play upload is optional", () => {
  const bundleName =
    "houndstack-${{ steps.version.outputs.name }}-${{ steps.version.outputs.code }}.aab";
  const bundlePath = `android/app/build/outputs/bundle/release/${bundleName}`;

  it("copies the bundle to houndstack-<versionName>-<versionCode>.aab", () => {
    const rename = releaseSteps().find((s) => /\bcp\b.*app-release\.aab/.test(s.run ?? ""));
    expect(rename?.run).toContain("houndstack-${VERSION_NAME}-${VERSION_CODE}.aab");
    expect(rename?.env?.VERSION_NAME).toBe("${{ steps.version.outputs.name }}");
    expect(rename?.env?.VERSION_CODE).toBe("${{ steps.version.outputs.code }}");
  });

  it("keeps it 14 days as an artifact of the same name", () => {
    const artifact = releaseSteps().find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(artifact?.with?.name).toBe(bundleName);
    expect(artifact?.with?.path).toBe(bundlePath);
    expect(artifact?.with?.["retention-days"]).toBe(14);
    expect(artifact?.with?.["if-no-files-found"]).toBe("error");
    // The artifact comes before the upload, so a refused upload still leaves it.
    const steps = releaseSteps();
    const play = steps.findIndex((s) => s.uses?.startsWith("r0adkll/upload-google-play@"));
    expect(steps.indexOf(artifact!)).toBeLessThan(play);
  });

  it("turns 'is PLAY_SERVICE_ACCOUNT_JSON set' into an output, without printing it", () => {
    const flag = releaseSteps().find((s) => /play_upload=/.test(s.run ?? ""));
    expect(flag?.id).toBeTruthy();
    expect(flag?.env?.PLAY_SERVICE_ACCOUNT_JSON).toBe("${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}");
    expect(flag?.run).toMatch(/\[ -n "\$\{?PLAY_SERVICE_ACCOUNT_JSON/);
    expect(flag?.run).toMatch(/play_upload=true" >> "\$GITHUB_OUTPUT"/);
    expect(flag?.run).toMatch(/play_upload=false" >> "\$GITHUB_OUTPUT"/);
    // Tested for emptiness only: no line prints or pipes the value.
    for (const line of (flag?.run ?? "").split(/\r?\n/)) {
      if (/\[ -n /.test(line)) continue;
      expect(line).not.toMatch(/\$\{?PLAY_SERVICE_ACCOUNT_JSON/);
    }
  });

  it("uploads to Play only when that output says so", () => {
    const flag = releaseSteps().find((s) => /play_upload=/.test(s.run ?? ""));
    const play = releaseSteps().find((s) => s.uses?.startsWith("r0adkll/upload-google-play@"));
    expect(play?.if).toBe(`steps.${flag?.id}.outputs.play_upload == 'true'`);
    expect(play?.with?.releaseFiles).toBe(bundlePath);
    // The secret reaches only the flag step and the upload it gates.
    const users = releaseSteps().filter((s) =>
      JSON.stringify(s).includes("secrets.PLAY_SERVICE_ACCOUNT_JSON"),
    );
    expect(users).toEqual([flag, play]);
  });

  it("does not fail when PLAY_SERVICE_ACCOUNT_JSON is absent", () => {
    // The required-secret check names the four signing secrets and not this
    // one, and the flag step has no way to fail the run.
    const check = releaseSteps().find(
      (s) => /is not set/.test(s.run ?? "") && /exit 1/.test(s.run ?? ""),
    );
    expect(check?.run).toContain("ANDROID_KEYSTORE_BASE64");
    for (const step of releaseSteps()) {
      if (!/exit 1/.test(step.run ?? "")) continue;
      expect(step.run, step.name ?? step.uses).not.toContain("PLAY_SERVICE_ACCOUNT_JSON");
    }
    const flag = releaseSteps().find((s) => /play_upload=/.test(s.run ?? ""));
    expect(flag?.run).not.toMatch(/exit [1-9]/);
  });

  it("says, when the upload is skipped, that the bundle must be uploaded by hand", () => {
    const flag = releaseSteps().find((s) => /play_upload=/.test(s.run ?? ""));
    const notice = releaseSteps().find((s) => /::notice/.test(s.run ?? ""));
    expect(notice?.if).toBe(`steps.${flag?.id}.outputs.play_upload != 'true'`);
    expect(notice?.run).toMatch(/artifacts/);
    expect(notice?.run).toMatch(/Play Console/);
  });

  it("writes versionName, versionCode, artifact and Play upload to the step summary", () => {
    const summary = releaseSteps().find((s) => /GITHUB_STEP_SUMMARY/.test(s.run ?? ""));
    expect(summary?.run).toMatch(/\$VERSION_NAME/);
    expect(summary?.run).toMatch(/\$VERSION_CODE/);
    expect(summary?.run).toContain("houndstack-${VERSION_NAME}-${VERSION_CODE}.aab");
    expect(summary?.run).toMatch(/Play upload/);
    expect(summary?.env?.PLAY_UPLOAD).toMatch(/outputs\.play_upload/);
  });
});
