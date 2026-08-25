#!/usr/bin/env node
// What ships inside the iOS/Android binary.
//
// ── WHY A BLANKET STRING BAN WOULD BE WRONG ───────────────────────────────
//
// The obvious version of this check is "the native bundle must not contain
// app.houndstack.com". That would fail a CORRECT build and, if somebody made
// it pass, would produce an app that cannot do anything.
//
// A Capacitor bundle is served from capacitor://localhost. It has no server of
// its own, so server-function URLs are baked in as an ABSOLUTE origin at build
// time (vite.config.ts, NATIVE_API_ORIGIN). The origin being present is what
// makes the app work. This file therefore asserts it is PRESENT, and separately
// asserts it is never a NAVIGATION target — which is the thing that actually
// hurts: a WebView told to navigate to the web app leaves the native shell,
// and if it lands on a plan-purchase page it is also an App Review problem.
//
// Same distinction for the preview domains. `src/pwa/register.ts` names
// lovableproject.com and beta.lovable.dev in a BLOCKLIST, refusing to register
// a service worker there. `index.js` calls `window.__lovableEvents?.…`, an
// optional-chained injected global that is simply absent off-platform. Neither
// is a pointer at a preview host. What must never appear is one inside a URL,
// because that is a thing the app would fetch or navigate to.
//
// ── THE VACUOUS-PASS GUARD ────────────────────────────────────────────────
//
// Every assertion here has the form "this string does not appear", and all of
// them pass on an empty directory. That is the failure mode this repo keeps
// finding, so the first thing checked is that there is a real bundle with a
// bootable index.html in it. A scan that measured nothing must not be green.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const BUNDLE = join(ROOT, "dist-native", "client");
const IOS_CONFIG = join(ROOT, "ios", "App", "App", "capacitor.config.json");

const API_ORIGIN = process.env.NATIVE_API_ORIGIN || "https://app.houndstack.com";

/** A preview host inside a URL. Bare hostnames in a blocklist are fine. */
const PREVIEW_URL = /(?:https?:)?\/\/[^"'`\s]*(?:lovable\.dev|lovableproject(?:-dev)?\.com|lovable\.app)/gi;

/** An absolute link into the web app's SaaS billing or checkout. */
const WEB_CHECKOUT_URL =
  /(?:https?:)?\/\/[^"'`\s]*houndstack[^"'`\s]*\/(?:settings\/billing|billing|checkout|upgrade|plans?)\b/gi;

// ── THE SAAS PURCHASE UI MUST NOT BE IN THE ARTIFACT ─────────────────────
//
// vite.config.ts swaps @/components/billing/PlanPicker for a store stub in the
// NATIVE_BUILD. For a long time it did not: the swap was expressed as a
// `resolve.alias`, and @lovable.dev/vite-tanstack-config sets
// `alias: { "@": cwd/src }` which prefix-matches first, so the specific entry
// never fired and the REAL plan picker -- plan catalog, Choose plan, Subscribe,
// confirmPayment -- shipped inside the binary. The runtime gate still hid it,
// so nothing was reachable; the build-time removal simply was not happening.
//
// The check that was meant to prove it looked for `stripeAppearance`, which is
// absent from the bundle for an unrelated reason. So it passed while the module
// shipped -- "passed" and "not checked" looking alike, which is the one thing
// this repo says must never happen.
//
// This asserts BOTH directions, because either alone can pass for the wrong
// reason: the stub's own marker must be PRESENT, and the real module's plan
// catalog query must be ABSENT.
const STUB_MARKER = "getPlatformStripe is not available in a store build";
const REAL_MARKER = "platform-plans";

const fail = [];
const note = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ── 0. there must be something to check ──────────────────────────────────
if (!existsSync(BUNDLE)) {
  console.error(`✗ no native bundle at ${relative(ROOT, BUNDLE)}`);
  console.error("  Run `npm run build:native` first. Every check below passes");
  console.error("  on an empty directory, so this is an error rather than a skip.");
  process.exit(1);
}
const files = walk(BUNDLE);
const index = join(BUNDLE, "index.html");
if (!existsSync(index)) {
  console.error("✗ the bundle has no index.html, so there is nothing a WebView could boot");
  process.exit(1);
}
const textFiles = files.filter((f) => /\.(js|html|css|json|webmanifest)$/.test(f));
if (textFiles.length < 5) {
  console.error(`✗ only ${textFiles.length} text files in the bundle: this is not a real build`);
  process.exit(1);
}
note.push(`${files.length} files, ${textFiles.length} scannable`);

// ── 1. the API origin must be THERE ──────────────────────────────────────
const originHost = API_ORIGIN.replace(/^https?:\/\//, "");
const hasOrigin = textFiles.some((f) => readFileSync(f, "utf8").includes(originHost));
if (!hasOrigin) {
  fail.push(
    `the API origin ${originHost} is absent from the bundle.\n` +
      "    A native build without it sends server functions to capacitor://localhost,\n" +
      "    which serves no API, so every call fails on a perfect network.\n" +
      "    Was this built with `npm run build:native` rather than `npm run build`?",
  );
} else {
  note.push(`API origin ${originHost} present`);
}

// ── 2. no preview domain as a URL ────────────────────────────────────────
for (const f of textFiles) {
  const src = readFileSync(f, "utf8");
  const hits = src.match(PREVIEW_URL);
  if (hits) {
    fail.push(
      `${relative(ROOT, f)} contains a preview-host URL: ${[...new Set(hits)].join(", ")}\n` +
        "    A binary that fetches or navigates to a preview domain depends on an\n" +
        "    environment nobody promises to keep alive.",
    );
  }
}

// ── 2b. the SaaS purchase UI is not in the artifact ─────────────────────
// Both directions, because either alone passes for the wrong reason. See the
// note beside STUB_MARKER.
{
  const all = textFiles.map((f) => readFileSync(f, "utf8"));
  const stubbed = all.some((src) => src.includes(STUB_MARKER));
  const real = textFiles.filter((f, i) => all[i].includes(REAL_MARKER));

  if (!stubbed) {
    fail.push(
      "the store stub for PlanPicker is not in the bundle\n" +
        "    Expected the marker from PlanPicker.native-stub.tsx. Its absence means\n" +
        "    the NATIVE_BUILD module swap did not happen, whatever the config says.",
    );
  } else {
    note.push("PlanPicker store stub present");
  }

  if (real.length) {
    fail.push(
      `the real PlanPicker is in the bundle: ${real.map((f) => relative(ROOT, f)).join(", ")}\n` +
        "    It queries the platform plan catalog, which is the SaaS purchase UI\n" +
        "    App Review must not find in the binary. The runtime gate hiding it is\n" +
        "    not the same claim as it not being there.",
    );
  } else {
    note.push("real PlanPicker absent from the bundle");
  }
}

// ── 3. the WebView must load the bundle, not a remote origin ─────────────
if (existsSync(IOS_CONFIG)) {
  const cfg = JSON.parse(readFileSync(IOS_CONFIG, "utf8"));
  const url = cfg?.server?.url;
  if (url) {
    fail.push(
      `ios capacitor.config.json sets server.url = ${url}\n` +
        "    That makes the WebView load a remote origin and ignore the bundle\n" +
        "    entirely, so the app cannot start without network. It is for dev\n" +
        "    live-reload only (CAP_SERVER_URL=...) and must never be committed.",
    );
  } else {
    note.push("ios server.url absent, WebView loads the bundle");
  }
} else {
  note.push("ios/ not synced, skipped the server.url check");
}

// ── 4. no absolute link into web SaaS billing ────────────────────────────
// Scanned from SOURCE, not the minified bundle: the question is what the code
// says, and a bundler may inline or split a string beyond recognition.
const SRC = join(ROOT, "src");
for (const f of walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f))) {
  const src = readFileSync(f, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  const hits = src.match(WEB_CHECKOUT_URL);
  if (hits) {
    fail.push(
      `${relative(ROOT, f)} links to web SaaS billing: ${[...new Set(hits)].join(", ")}\n` +
        "    In a native shell that navigates out of the app, and a plan-purchase\n" +
        "    page reached from inside the binary is what guideline 3.1.1 is about.\n" +
        "    Customer invoice and portal payment paths are deliberately NOT matched\n" +
        "    here: those are real-world services and stay.",
    );
  }
}

// ── report ───────────────────────────────────────────────────────────────
for (const n of note) console.log(`  · ${n}`);
if (fail.length === 0) {
  console.log("✓ native bundle ships the app itself, with no preview host and no web checkout");
  process.exit(0);
}
console.error(`\n✗ ${fail.length} problem(s) with what would ship inside the binary:\n`);
for (const f of fail) console.error(`  - ${f}\n`);
process.exit(1);
