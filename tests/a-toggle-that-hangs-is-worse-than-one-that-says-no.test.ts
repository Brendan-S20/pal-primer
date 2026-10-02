// The bell asked for permission, got it, and then span forever.
//
// ── THE BUG ────────────────────────────────────────────────────────────────
//
// `navigator.serviceWorker.ready` resolves when a worker takes control. With
// no worker registered it does NOT reject -- it never settles at all. Three
// places in PushToggle awaited it:
//
//   the mount effect   decides whether the bell starts filled
//   enable()           after Notification.requestPermission() has been granted
//   disable()          before unsubscribing
//
// Because the `try` never completed, the `finally { setBusy(false) }` never
// ran and the `catch` never fired. A user tapped the bell, the browser asked
// for notification permission, they GRANTED it, and the button then sat busy
// until the page was reloaded. No error, no toast, nothing in the console.
//
// It was live on /my-day and on both client-portal pages, so customers met it
// on a screen where the only available response is to give up.
//
// ── WHY IT WAS UNBOUNDED ───────────────────────────────────────────────────
//
// /sw.js answered 404 in production from 2026-08-19 to 2026-09-10: the worker
// was written to a directory the hosted build does not deploy (PWA_OUT_DIR in
// vite.config.ts). No worker meant `ready` never settled for anybody.
//
// That is fixed, so this is no longer the everyday path. The guard stays
// because the bug is a SHAPE rather than a consequence of that one fault: a
// worker can be absent because its scope never registered, because the browser
// evicted it, because someone cleared site data, or because a future change
// breaks the deploy again. None of those should end in a spinner.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";

const root = join(import.meta.dirname, "..");
const source = readFileSync(join(root, "src/components/PushToggle.tsx"), "utf8");

describe("waiting on a service worker is bounded", () => {
  it("never awaits navigator.serviceWorker.ready directly", () => {
    // Exactly one mention is allowed: the one inside the race.
    const direct = [...source.matchAll(/await\s+navigator\.serviceWorker\.ready/g)];
    expect(direct).toHaveLength(0);

    const chained = [...source.matchAll(/navigator\.serviceWorker\.ready\s*\n?\s*\./g)];
    expect(chained).toHaveLength(0);
  });

  it("routes every wait through the timeout helper", () => {
    // Three call sites: the mount effect, enable(), disable(). If a fourth
    // appears and skips the helper, the first assertion catches it.
    // enable() and disable() pass the message in the person's language.
    const viaHelper = [...source.matchAll(/serviceWorkerReady\((t\("push\.unavailable"\))?\)/g)];
    expect(viaHelper.length).toBeGreaterThanOrEqual(3);
  });

  it("races against a timer rather than hoping", () => {
    expect(source).toMatch(/Promise\.race/);
    expect(source).toMatch(/SW_READY_TIMEOUT_MS/);
    expect(source).toMatch(/setTimeout/);
  });

  it("clears the timer once the race is settled", () => {
    // Otherwise a pending rejection fires into a promise nobody holds, which
    // is an unhandled rejection in every browser that reports them.
    expect(source).toMatch(/clearTimeout/);
  });

  it("fails with a sentence the person can act on", () => {
    // The catch blocks surface `e.message` directly, so this string is what a
    // technician or a customer actually reads. "Service worker unavailable" is
    // a sentence for us; "reload the page and try again" is one for them.
    //
    // The helper rejects with the message it is handed, which enable() and
    // disable() take from lib/i18n (push.unavailable) so a tech reads it in
    // their language and a customer on the portal reads it in English. The
    // helper's own default is the same English sentence, for the mount-time
    // call that never shows it.
    expect(source).toMatch(/new Error\(unavailableMessage\)/);
    const fallback = source.match(/unavailableMessage = "([^"]+)"/)?.[1];
    expect(fallback).toBe(en.push.unavailable);
    for (const rejection of [en.push.unavailable, fallback!]) {
      expect(rejection.toLowerCase()).toMatch(/reload/);
      expect(rejection.toLowerCase()).not.toMatch(/service worker|registration|promise/);
    }
    expect(es.push.unavailable.toLowerCase()).toMatch(/recarga/);
  });
});
