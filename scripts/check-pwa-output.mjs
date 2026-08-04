#!/usr/bin/env node
// Does the built service worker actually work?
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// /sw.js 404'd in production for the entire life of the PWA, and it took three
// independent defects to do it: the worker was emitted to `dist/` while
// deployment ships `.output/public`; its precache manifest globbed a directory
// with no app assets in it; and the CacheFirst rule matched `/_build/`, a path
// this build has never produced.
//
// Every one of those is invisible from the source. vite.config.ts read
// correctly the whole time — the PWA block is perfectly sensible config that
// simply never met the files it was describing. Nothing in the test suite could
// see it, because the defect only exists in the build OUTPUT.
//
// So this asserts against the output, and it is deliberately not clever: it
// exists because I mismeasured this by hand. Checking the manifest with
// `grep '"url":'` returned zero on a minified file that writes `url:` without
// quotes, and I reported the manifest as empty when it held 324 entries. A
// number a human eyeballs once is a number that gets eyeballed wrong.
//
// Run after `npm run build`. Skips silently when there is no build to inspect,
// so it can sit in a CI chain that does not always build.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const OUT = ".output/public";
const SW = join(OUT, "sw.js");

if (!existsSync(OUT)) {
  console.log("✓ no build output to check (run `npm run build` first)");
  process.exit(0);
}

const problems = [];

// 1. The worker has to BE there. This is the defect that made the other two
//    moot for the life of the app.
if (!existsSync(SW)) {
  problems.push(
    `${SW} does not exist. VitePWA's outDir has drifted from the directory ` +
      `Nitro deploys, which is exactly how /sw.js came to 404 in production.`,
  );
}

if (existsSync(SW)) {
  const sw = readFileSync(SW, "utf8");

  // 2. The precache manifest must be populated, and roughly complete. Counting
  //    `url:"` rather than `"url":` because the output is minified — the exact
  //    mistake this check is here to stop being repeated by hand.
  const precached = [...sw.matchAll(/url:"([^"]+)"/g)].map((m) => m[1]);

  const cacheable = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else cacheable.push(relative(OUT, p));
    }
  };
  walk(OUT);
  // The worker cannot precache itself, and _headers is deploy config.
  const expected = cacheable.filter(
    (f) => f !== "sw.js" && !f.startsWith("workbox-") && f !== "_headers",
  );

  if (precached.length === 0) {
    problems.push(
      "the precache manifest is EMPTY. workbox globbed a directory with no app " +
        "assets in it, so the worker would install and cache nothing.",
    );
  } else if (precached.length < expected.length * 0.9) {
    problems.push(
      `the precache manifest covers ${precached.length} of ${expected.length} ` +
        `deployable files. A large shortfall usually means the glob ran before ` +
        `the output directory was fully populated.`,
    );
  }

  // 3. The runtime rules have to reference paths this build actually emits.
  //    The CacheFirst rule pointed at /_build/ for months; assets live under
  //    /assets/, so it matched nothing and cached nothing.
  const assetDirs = readdirSync(OUT).filter(
    (n) => statSync(join(OUT, n)).isDirectory() && n !== "_headers",
  );
  for (const dir of assetDirs) {
    const hashed = existsSync(join(OUT, dir))
      ? readdirSync(join(OUT, dir)).some((f) => /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(f))
      : false;
    if (hashed && !sw.includes(dir)) {
      problems.push(
        `the worker never mentions /${dir}/, which is where this build puts ` +
          `hashed assets. A runtime-caching rule aimed at a path that does not ` +
          `exist caches nothing, silently.`,
      );
    }
  }

  // 4. THE WORKER MUST NOT THROW ON ITS FIRST LINE.
  //
  //    `createHandlerBoundToURL(u)` throws when `u` is absent from the precache
  //    manifest, and the generated worker is ONE top-level comma sequence:
  //
  //      precacheAndRoute(...), cleanupOutdatedCaches(),
  //      registerRoute(new NavigationRoute(createHandlerBoundToURL(u))),
  //      registerRoute(navigate -> NetworkFirst),
  //      registerRoute(/assets/ -> CacheFirst)
  //
  //    so one bad `u` takes out every rule after it. This build is SSR and
  //    emits no HTML, so nothing named "/" or "index.html" is ever precached —
  //    and vite-plugin-pwa DEFAULTS navigateFallback to "index.html", meaning
  //    simply deleting the option reintroduces the fault with a different
  //    string. Checks 1–3 all passed throughout: the file existed, the manifest
  //    had entries, and /assets/ was mentioned. Nothing looked wrong.
  const boundUrls = [...sw.matchAll(/createHandlerBoundToURL\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1],
  );
  for (const u of boundUrls) {
    const normalized = u.replace(/^\//, "");
    const inManifest = precached.some((e) => e.replace(/^\//, "") === normalized);
    if (!inManifest) {
      problems.push(
        `the worker calls createHandlerBoundToURL(${JSON.stringify(u)}) but ` +
          `"${u}" is not in its precache manifest. That call THROWS at install ` +
          `time and aborts every registerRoute after it, so the app-shell and ` +
          `asset caches never register and the installed PWA will not open ` +
          `offline. This build emits no HTML — set workbox.navigateFallback to ` +
          `undefined explicitly (omitting it is not enough, the plugin defaults ` +
          `it to "index.html").`,
      );
    }
  }

  // 5. Both runtime caches must actually be registered. If check 4 ever fires,
  //    this is the consequence — assert it directly so the failure names the
  //    thing the user would notice rather than only the mechanism.
  for (const cacheName of ["app-shell", "static-assets"]) {
    if (!sw.includes(cacheName)) {
      problems.push(
        `the worker registers no "${cacheName}" runtime cache, so nothing it ` +
          `is meant to serve offline will be there.`,
      );
    }
  }
}

if (problems.length) {
  console.error("✗ the built service worker would not do what its config says:\n");
  for (const p of problems) console.error(`  - ${p}\n`);
  process.exit(1);
}

console.log("✓ service worker deployed, precache populated, runtime rules match real paths");
