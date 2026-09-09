// The manifest was built, deployed, served, and never read.
//
// ── WHAT WAS MEASURED ──────────────────────────────────────────────────────
//
// Against the live site on 2026-09-09, while chasing the /sw.js 404:
//
//     /manifest.webmanifest   200
//     /push-handlers.js       200
//     /pwa-192.png            200
//     /favicon.svg            200
//     /sw.js                  404
//
// and the HTML at https://app.houndstack.com/auth carried exactly four link
// rels: stylesheet, icon, icon, apple-touch-icon. There was no
// `rel="manifest"` on the page, and no occurrence of the string "webmanifest"
// anywhere under src/.
//
// A manifest is only read because a document links it. So Chrome and Edge had
// no installability signal, "Install app" was never offered on any surface,
// and the file that describes the installed app -- its name, its icons, its
// start_url, the theme colour -- was reachable only by typing its URL.
//
// ── WHY IT WAS INVISIBLE ───────────────────────────────────────────────────
//
// vite-plugin-pwa does two things: it GENERATES manifest.webmanifest, and it
// INJECTS the link into index.html. This app is server-rendered and the web
// build emits no index.html at all, so the first half ran and the second half
// had nothing to run against. Nothing errored; the plugin did exactly what it
// is documented to do.
//
// The 200 was actively misleading. check-pwa-live.mjs listed the manifest as a
// COMPANION -- a control proving "other files from this build output ARE
// served, so the 404 is the worker specifically". That reading was correct and
// it is still correct. It just answers a different question from "is any of
// this reaching a browser", and a 200 looks like an answer to both.
//
// Two independent failures, then, either of which alone stops this being an
// installable PWA, and neither of which is visible from the other. Fixing the
// worker would not have made the app installable.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const rootRoute = read("src/routes/__root.tsx");
const viteConfig = read("vite.config.ts");
const live = read("scripts/check-pwa-live.mjs");

describe("the document points at the manifest", () => {
  it("declares rel=manifest in the root route's head", () => {
    // The root route, not a layout: every surface has to carry it, including
    // the client portal and /auth, which are outside the authenticated shell.
    expect(rootRoute).toMatch(/rel:\s*"manifest"/);
  });

  it("points at the file vite-plugin-pwa actually emits", () => {
    const href = rootRoute.match(/rel:\s*"manifest",\s*href:\s*"([^"]+)"/)?.[1];
    expect(href).toBe("/manifest.webmanifest");

    // If someone sets manifestFilename the emitted name changes and the link
    // above silently points at a 404 -- the same shape of fault as the one
    // this file exists for, one level down. Nothing in the repo sets it today;
    // this fails the moment something does, rather than at the next deploy.
    expect(viteConfig).not.toMatch(/manifestFilename/);
  });
});

describe("the tab colour and the installed window agree", () => {
  it("declares a theme-color meta matching manifest.theme_color", () => {
    const fromManifest = viteConfig.match(/theme_color:\s*"([^"]+)"/)?.[1];
    const fromMeta = rootRoute.match(/name:\s*"theme-color",\s*content:\s*"([^"]+)"/)?.[1];

    // Chrome takes the browser tab's colour from the meta and the installed
    // window's from the manifest. Two sources, one colour: they drift silently
    // because nothing renders both side by side.
    expect(fromManifest).toBeTruthy();
    expect(fromMeta).toBe(fromManifest);
  });
});

describe("and the live check asks the running site, not this file", () => {
  // A static test proves the link is in the source. It cannot prove the link
  // survived to the deployed HTML -- which is exactly the gap that let the
  // worker 404 for the life of the app while check:pwa stayed green.
  it("fetches a page and looks for the rel on it", () => {
    expect(live).toMatch(/rel=\["'\]manifest\["'\]/);
  });

  it("refuses to conclude anything from a page that did not render", () => {
    // Assertions of the form "nothing is wrong" all pass on a blank document,
    // so an absent link on an error page would read as an absent link on a
    // working one. Same guard the viewport sweep needed, same reason.
    expect(live).toMatch(/rendered/);
    expect(live).toMatch(/stylesheet/);
  });
});
