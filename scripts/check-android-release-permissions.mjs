#!/usr/bin/env node
// Refuses a release build whose MERGED manifest asks for photo or storage access.
//
// Google Play allows READ_MEDIA_IMAGES and READ_MEDIA_VIDEO only for apps whose
// core purpose is broad gallery access. Visit photos, receipts and avatars are
// one-off picks, which the system chooser serves with no permission. Play
// flagged READ_MEDIA_IMAGES on 2026-10-23 (#533), and its policy says the
// permission has to be gone from every version code, testing tracks included.
//
// The source manifest is pinned by
// tests/an-android-app-that-could-not-use-the-camera.test.ts. This checks the
// other half, which only a build can show: what the plugins and their
// transitive libraries merged in. A tools:node="remove" in the source manifest
// strips a merged entry, so a hit here means a new library added one that
// nothing removes.
//
// Usage:
//   node scripts/check-android-release-permissions.mjs [dir-or-manifest ...]
//
// With no argument it searches android/app/build/intermediates for the
// release variant's merged manifest. It fails when it finds none, because a
// check that read nothing would otherwise pass.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toPosix } from "./posix-path.mjs";

export const FORBIDDEN = [
  "android.permission.READ_MEDIA_IMAGES",
  "android.permission.READ_MEDIA_VIDEO",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.WRITE_EXTERNAL_STORAGE",
];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = join(ROOT, "android", "app", "build", "intermediates");

/** Every AndroidManifest.xml under `dir` from a merged release manifest. */
export function findReleaseManifests(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "AndroidManifest.xml") {
        const posix = toPosix(p);
        if (/merged_manifests?\//.test(posix) && /\/release\//.test(posix)) out.push(p);
      }
    }
  };
  walk(dir);
  return out;
}

/** The forbidden permissions `xml` requests, in any uses-permission form. */
export function forbiddenIn(xml) {
  const tags = xml.match(/<uses-permission(?:-sdk-23)?\b[^>]*>/g) ?? [];
  return FORBIDDEN.filter((perm) =>
    tags.some((tag) => tag.includes(`android:name="${perm}"`) && !/tools:node="remove"/.test(tag)),
  );
}

function main(args) {
  const targets = args.length ? args.map((a) => resolve(a)) : [DEFAULT_DIR];
  const manifests = [];
  for (const t of targets) {
    if (!existsSync(t)) {
      console.error(`::error::${t} does not exist; build the release variant first`);
      return 1;
    }
    if (statSync(t).isDirectory()) manifests.push(...findReleaseManifests(t));
    else manifests.push(t);
  }
  if (manifests.length === 0) {
    console.error(
      "::error::no merged release AndroidManifest.xml found; nothing was checked, so this is not a pass",
    );
    return 1;
  }
  let failed = false;
  for (const m of manifests) {
    const hits = forbiddenIn(readFileSync(m, "utf8"));
    if (hits.length) {
      failed = true;
      console.error(
        `::error file=${toPosix(m)}::requests ${hits.join(", ")}. Google Play rejects this for an ` +
          `app whose core purpose is not the gallery (#533). Add a tools:node="remove" entry for it ` +
          `in android/app/src/main/AndroidManifest.xml.`,
      );
    } else {
      console.log(`ok: ${toPosix(m)} requests no photo or storage permission`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
