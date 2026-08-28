#!/usr/bin/env node
// Does the DEPLOYED site actually serve the service worker?
//
// ── WHY THIS IS SEPARATE FROM check:pwa ──────────────────────────────────
//
// check-pwa-output.mjs reads `.output/public` and proves the BUILD emits a
// worker with a populated precache. It is a good check and it has been green
// throughout, because the build has been correct throughout.
//
// Production still answers 404 for /sw.js.
//
//     /manifest.webmanifest   200
//     /favicon.ico            200
//     /push-handlers.js       200
//     /sw.js                  404      <- registered on every page load
//
// So the app calls navigator.serviceWorker.register("/sw.js") on every visit,
// gets "A bad HTTP response code (404) was received when fetching the script",
// and there is no worker: no install prompt, no offline tolerance, and a
// console error on every page for every user.
//
// A check that reads a directory cannot see that. This one asks the site.
//
// Same failure shape the OAuth gate had twice: validating the artifact rather
// than the running thing. Exit code is 1 only when the origin ANSWERS and the
// worker is missing, so a flaky network cannot fail a build.
const ORIGIN = process.env.PWA_ORIGIN ?? "https://app.houndstack.com";

// Served by the same build output as sw.js. If these are missing too the
// problem is the deploy as a whole, which is a different conversation from
// "the worker specifically did not ship".
const COMPANIONS = ["/manifest.webmanifest", "/favicon.ico"];

async function status(path) {
  try {
    const res = await fetch(ORIGIN + path, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    return res.status;
  } catch (e) {
    return `unreachable (${e.message})`;
  }
}

const sw = await status("/sw.js");
const companions = Object.fromEntries(
  await Promise.all(COMPANIONS.map(async (p) => [p, await status(p)])),
);

console.log(`\n${ORIGIN}`);
console.log(`  /sw.js                 ${sw}`);
for (const [p, s] of Object.entries(companions)) console.log(`  ${p.padEnd(22)} ${s}`);
console.log("");

if (typeof sw !== "number") {
  console.log("? could not reach the origin; not treating that as a failure");
  process.exit(0);
}

if (sw === 200) {
  console.log("✓ the deployed site serves its service worker");
  process.exit(0);
}

const companionsOk = Object.values(companions).some((s) => s === 200);
console.error(
  `✗ /sw.js answers ${sw} on ${ORIGIN}.\n` +
    (companionsOk
      ? "  Other files from the same build output ARE served, so this is the worker\n" +
        "  specifically, not the deploy as a whole. The app registers /sw.js on every\n" +
        "  page load and gets a 404: no install prompt, no offline tolerance, and a\n" +
        "  console error for every visitor.\n"
      : "  Its companions are missing too, so the whole static output is unserved.\n") +
    "  check:pwa reads .output/public and cannot see this — it proves the build,\n" +
    "  not the deployment.",
);
process.exit(1);
