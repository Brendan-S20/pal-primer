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
// than the running thing. Exit code is 1 only when the origin ANSWERS and
// something is missing, so a flaky network cannot fail a build.
//
// ── AND THE SECOND HALF: IS THE APP INSTALLABLE AT ALL ───────────────────
//
// /manifest.webmanifest was in the COMPANIONS list below purely as a control:
// "other files from the same build output are served, so this is the worker
// specifically". It was answering 200 the whole time, and that reading was
// correct as far as it went.
//
// What nobody checked is whether anything POINTS at it. Nothing did. The link
// that references a webmanifest is injected into index.html by vite-plugin-pwa
// and this app server-renders every page, so the file was generated, deployed,
// served, and never read by a browser. A manifest reached only by typing its
// URL is not an install prompt.
//
// So the two halves of "this is a PWA" failed independently and for unrelated
// reasons, and each one is invisible from the other. Both are asked here, and
// both are asked of the running site rather than the build, because that is
// the whole reason this file exists.
const ORIGIN = process.env.PWA_ORIGIN ?? "https://app.houndstack.com";

// Served by the same build output as sw.js. If these are missing too the
// problem is the deploy as a whole, which is a different conversation from
// "the worker specifically did not ship".
const COMPANIONS = ["/manifest.webmanifest", "/favicon.ico"];

// The signed-out landing page. NOT "/", which redirects, and not a signed-in
// route, which would need a session: the manifest link lives on the root route
// so every page carries it, and this is the one any visitor can reach.
const PAGE = "/auth";

async function get(path) {
  try {
    const res = await fetch(ORIGIN + path, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, res };
  } catch (e) {
    return { status: `unreachable (${e.message})`, res: null };
  }
}

async function status(path) {
  return (await get(path)).status;
}

const sw = await status("/sw.js");
const companions = Object.fromEntries(
  await Promise.all(COMPANIONS.map(async (p) => [p, await status(p)])),
);

// Does the served HTML actually reference the manifest? Matching on the rel
// rather than on the href, because a link pointing at the wrong file is a
// different fault with a different fix, and the href is reported either way.
const page = await get(PAGE);
const html = page.res ? await page.res.text() : "";
const manifestHref = html.match(/<link[^>]+rel=["']manifest["'][^>]*>/i)?.[0];
const linkedHref = manifestHref?.match(/href=["']([^"']+)["']/i)?.[1] ?? null;

console.log(`\n${ORIGIN}`);
console.log(`  /sw.js                 ${sw}`);
for (const [p, s] of Object.entries(companions)) console.log(`  ${p.padEnd(22)} ${s}`);
console.log(`  ${PAGE.padEnd(22)} ${page.status}`);
console.log(`  rel="manifest" in HTML ${linkedHref ?? (page.res ? "MISSING" : "not checked")}`);
console.log("");

if (typeof sw !== "number" || typeof page.status !== "number") {
  console.log("? could not reach the origin; not treating that as a failure");
  process.exit(0);
}

const problems = [];
const companionsOk = Object.values(companions).some((s) => s === 200);

if (sw !== 200) {
  problems.push(
    `/sw.js answers ${sw}.\n` +
      (companionsOk
        ? "    Other files from the same build output ARE served, so this is the worker\n" +
          "    specifically, not the deploy as a whole. The app registers /sw.js on every\n" +
          "    page load and gets a 404: no offline tolerance, and a console error for\n" +
          "    every visitor."
        : "    Its companions are missing too, so the whole static output is unserved."),
  );
}

// A 200 on the page is not enough to trust this: a page that failed to render
// has no links either, and "nothing is wrong" passes on a blank document. So
// require a marker only a rendered page carries before believing the absence.
const rendered = /<link[^>]+rel=["']stylesheet["']/i.test(html);
if (!rendered) {
  problems.push(
    `${PAGE} answered ${page.status} but rendered no stylesheet link, so it did not\n` +
      "    render. Nothing below can be concluded from a page that is not there.",
  );
} else if (!linkedHref) {
  problems.push(
    'the served HTML carries no <link rel="manifest">.\n' +
      "    /manifest.webmanifest is deployed and answers 200, but a manifest no\n" +
      "    document points at is never fetched, so the browser has no installability\n" +
      "    signal and no install prompt is ever offered. vite-plugin-pwa injects this\n" +
      "    link into index.html, which a server-rendered app never emits; it belongs\n" +
      "    in the root route's head (src/routes/__root.tsx).",
  );
} else if (companions["/manifest.webmanifest"] !== 200) {
  problems.push(
    `the HTML links ${linkedHref} but /manifest.webmanifest answers ` +
      `${companions["/manifest.webmanifest"]}, so the link resolves to nothing.`,
  );
}

if (problems.length === 0) {
  console.log("✓ the deployed site serves its service worker and links its manifest");
  process.exit(0);
}

console.error(`✗ ${ORIGIN} is not serving a working PWA:\n`);
for (const p of problems) console.error(`  - ${p}\n`);
console.error(
  "  check:pwa reads .output/public and cannot see any of this: it proves the\n" +
    "  build, not the deployment.",
);
process.exit(1);
