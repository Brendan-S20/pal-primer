// `npm run android:bump`: add one to VERSION_CODE in android/version.properties.
//
// Play refuses any bundle whose versionCode is not higher than every bundle it
// has already accepted, on any track. Run this before each upload and commit
// the result, so the number in git is the number on Play. VERSION_NAME (what a
// person reads in the listing) is left alone; edit it by hand when the release
// deserves a new name.
//
// Takes an optional path, which the test uses to bump a scratch copy. Line
// endings are left as found (a Windows checkout may have CRLF).
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file =
  process.argv[2] ?? fileURLToPath(new URL("../android/version.properties", import.meta.url));
const text = readFileSync(file, "utf8");
const m = text.match(/^VERSION_CODE=(\d+)/m);
if (!m) {
  console.error(`No VERSION_CODE=<number> line in ${file}`);
  process.exit(1);
}
const next = Number(m[1]) + 1;
writeFileSync(file, text.replace(/^VERSION_CODE=\d+/m, `VERSION_CODE=${next}`));
console.log(`Android versionCode ${m[1]} -> ${next} (${file}). Commit it with the release.`);
