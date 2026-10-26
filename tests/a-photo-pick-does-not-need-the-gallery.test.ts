// A release bundle never asks for photo or storage access.
//
// Play flagged READ_MEDIA_IMAGES on 2026-10-23 (#533). Its Photo and video
// permissions policy reserves READ_MEDIA_IMAGES and READ_MEDIA_VIDEO for apps
// whose core purpose is broad gallery access, and a visit photo, a receipt and
// an avatar are one-off picks. Every one of them is an <input type="file">,
// which Capacitor's BridgeWebChromeClient opens as the system chooser
// (ACTION_GET_CONTENT, the photo picker on Android 13+), and that returns one
// content:// URI with a read grant and needs no permission at all.
//
// The source manifest is pinned by an-android-app-that-could-not-use-the-camera.
// This file pins the release half: scripts/check-android-release-permissions.mjs
// reads the MERGED release manifest, where a plugin or transitive library
// would add one, and android-release.yml runs it before the bundle can become
// an artifact or reach Play.

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { FORBIDDEN, forbiddenIn } from "../scripts/check-android-release-permissions.mjs";

const root = join(import.meta.dirname, "..");
const SCRIPT = join(root, "scripts/check-android-release-permissions.mjs");

const manifest = (perms: string[]) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n` +
  perms.map((p) => `    <uses-permission android:name="${p}" />\n`).join("") +
  `</manifest>\n`;

/** A fake build tree with a merged release manifest, the way AGP 8 lays it out. */
function buildTree(xml: string) {
  const dir = mkdtempSync(join(tmpdir(), "merged-manifest-"));
  const at = join(dir, "merged_manifest", "release", "processReleaseMainManifest");
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "AndroidManifest.xml"), xml);
  return dir;
}

function run(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, dir], { encoding: "utf8", stdio: "pipe" });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

describe("the merged release manifest check", () => {
  it("names all four permissions Play objects to", () => {
    expect(FORBIDDEN).toEqual([
      "android.permission.READ_MEDIA_IMAGES",
      "android.permission.READ_MEDIA_VIDEO",
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ]);
  });

  for (const perm of [
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_MEDIA_VIDEO",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
  ]) {
    it(`fails a bundle that requests ${perm.replace("android.permission.", "")}`, () => {
      const r = run(buildTree(manifest(["android.permission.CAMERA", perm])));
      expect(r.code).toBe(1);
      expect(r.out).toContain(perm);
    });
  }

  it("catches the maxSdkVersion and uses-permission-sdk-23 forms too", () => {
    expect(
      forbiddenIn(
        `<uses-permission\n  android:name="android.permission.READ_EXTERNAL_STORAGE"\n  android:maxSdkVersion="32" />`,
      ),
    ).toEqual(["android.permission.READ_EXTERNAL_STORAGE"]);
    expect(
      forbiddenIn(`<uses-permission-sdk-23 android:name="android.permission.READ_MEDIA_IMAGES" />`),
    ).toEqual(["android.permission.READ_MEDIA_IMAGES"]);
  });

  it("passes a bundle with only the permissions the app uses", () => {
    const r = run(
      buildTree(
        manifest([
          "android.permission.INTERNET",
          "android.permission.CAMERA",
          "android.permission.ACCESS_FINE_LOCATION",
          "android.permission.POST_NOTIFICATIONS",
        ]),
      ),
    );
    expect(r.code, r.out).toBe(0);
  });

  it("refuses to pass when it found no manifest to read", () => {
    const r = run(mkdtempSync(join(tmpdir(), "no-manifest-")));
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/nothing was checked/);
  });

  it("passes the source manifest, whose four entries are all removals", () => {
    const src = readFileSync(join(root, "android/app/src/main/AndroidManifest.xml"), "utf8");
    expect(forbiddenIn(src)).toEqual([]);
  });
});

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: unknown;
};

describe("android-release.yml runs the check before the bundle leaves the runner", () => {
  const steps = () => {
    const wf = load(readFileSync(join(root, ".github/workflows/android-release.yml"), "utf8")) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    return Object.values(wf.jobs).flatMap((j) => j.steps);
  };

  it("after bundleRelease, before the artifact and the Play upload, unconditionally", () => {
    const s = steps();
    const check = s.findIndex((x) => /check-android-release-permissions\.mjs/.test(x.run ?? ""));
    const build = s.findIndex((x) => /bundleRelease/.test(x.run ?? ""));
    const artifact = s.findIndex((x) => x.uses?.startsWith("actions/upload-artifact@"));
    const play = s.findIndex((x) => x.uses?.startsWith("r0adkll/upload-google-play@"));
    expect(check, "no step runs the check").toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(check).toBeLessThan(artifact);
    expect(check).toBeLessThan(play);
    expect(s[check].if).toBeUndefined();
    expect(s[check]["continue-on-error"]).toBeUndefined();
  });
});
