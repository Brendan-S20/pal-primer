// The action path knew there was no signal. Everything a tech could SEE did not.
//
// src/lib/offline/connectivity.ts exists because of one specific failure, and
// its own header states it:
//
//   "in a WKWebView `navigator.onLine` is not refreshed reliably while the app
//    is suspended, so a van that drove through a dead zone with the app
//    backgrounded can resume reporting `onLine === true` against no connection
//    at all. That is the exact moment this app most needs the honest answer,
//    because it is when a tech opens the phone to close out a stop."
//
// `isDefinitelyOffline()` ORs the native interface state in, and the ACTION
// path has asked it since day one. `useOnline()` — which every offline
// INDICATOR renders from — read `navigator.onLine` and nothing else. So in
// precisely that state the work was queued correctly and the tech was told
// nothing: no Offline banner, "Couldn't refresh" instead of "Offline", and on
// the add-on and DNA panels `cardOnline` said online, which SUPPRESSED the
// "this charge is not queued, bill it when you have signal" warning and left a
// live money button enabled.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/lib/i18n/locales/en";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("what the tech is told matches what the app is about to do", () => {
  const hook = strip(read("src/lib/offline/useOnline.ts"));

  it("asks the same question the action path asks", () => {
    expect(hook).toMatch(/!isDefinitelyOffline\(\)/);
    // And no longer has its own opinion.
    expect(hook).not.toMatch(/setOnline\(true\)/);
    expect(hook).not.toMatch(/setOnline\(false\)/);
  });

  it("hears the native answer when it changes", () => {
    // The value was write-only: current for every action, invisible to React.
    expect(hook).toMatch(/window\.addEventListener\(CONNECTIVITY_CHANGE, refresh\)/);
    expect(hook).toMatch(/window\.removeEventListener\(CONNECTIVITY_CHANGE, refresh\)/);
  });

  it("keeps the pending badge current on native too", () => {
    // Coming back on native fires no browser `online` event.
    const pending = hook.slice(hook.indexOf("export function usePendingCount"));
    expect(pending).toMatch(/window\.addEventListener\(CONNECTIVITY_CHANGE, refresh\)/);
    expect(pending).toMatch(/window\.removeEventListener\(CONNECTIVITY_CHANGE, refresh\)/);
  });
});

describe("the connectivity module says when it changes its mind", () => {
  const conn = strip(read("src/lib/offline/connectivity.ts"));

  it("broadcasts, rather than only being polled", () => {
    expect(conn).toMatch(/export const CONNECTIVITY_CHANGE = "offline-connectivity-change"/);
    expect(conn).toMatch(/window\.dispatchEvent\(new Event\(CONNECTIVITY_CHANGE\)\)/);
  });

  it("routes every write through the one setter", () => {
    // A direct assignment anywhere else is an update React never hears about,
    // which is the whole of the bug this fixes.
    const assignments = conn.match(/nativeConnected = /g) ?? [];
    expect(assignments).toHaveLength(1);
    expect(conn).toMatch(/function setNative\(v: boolean \| null\): void \{/);
  });

  it("says nothing when nothing changed", () => {
    // The listener fires on every network transition including no-ops; a
    // dispatch per event would re-render the whole field screen for nothing.
    expect(conn).toMatch(/if \(nativeConnected === v\) return;/);
  });

  it("still can only ever widen 'definitely offline', never narrow it", () => {
    // The safety argument in the module header. Untouched by this change and
    // worth pinning, because it is what makes editing offline-critical code
    // defensible at all.
    expect(conn).toMatch(/if \(input\.browserOnLine === false\) return true;/);
    expect(conn).toMatch(/if \(input\.nativeConnected === false\) return true;/);
    expect(conn).toMatch(/return false;/);
  });
});

describe("the field screen asks honestly everywhere", () => {
  const page = strip(read("src/routes/_authenticated/my-day.tsx"));

  it("logs a station on the honest answer, like every other action", () => {
    // This one read navigator.onLine raw, so on a resumed app in a dead zone
    // the request went out, hung, and cost the 8s deadline before queueing —
    // per station, on a wall of twenty bins.
    expect(page).not.toMatch(
      /online: typeof navigator === "undefined" \? true : navigator\.onLine/,
    );
    expect(page).toMatch(/online: !isDefinitelyOffline\(\)/);
  });

  it("does not auto-sync into a dead zone", () => {
    // The mount-time replay moved into lib/offline/auto-sync.ts on 2026-09-28
    // (StrictMode's rehearsal mount started a second replay and toasted
    // "Already syncing…"). The honest answer still gates it -- asked when the
    // replay would start -- and tests/already-syncing-with-nothing-to-sync
    // drives that gate rather than reading it.
    expect(page).toMatch(/startAutoSync\(runSync, window, isDefinitelyOffline\)/);
    const auto = strip(read("src/lib/offline/auto-sync.ts"));
    expect(auto).toMatch(/if \(!isOffline\(\)\) run\("auto"\)/);
  });
});

describe("two dead branches, now live", () => {
  it("fetches the skip time the card already knows how to render", () => {
    // 20260804110000 added `skipped_at` so a REPLAYED skip shows the time the
    // tech stood at the door rather than the time signal returned. The column
    // is written, the card renders it — and the query never selected it, so
    // the value was always undefined and the branch never ran.
    const fns = strip(read("src/lib/my-day.functions.ts"));
    expect(fns).toMatch(/completed_at, skipped_at, eta_start/);
    expect(strip(read("src/routes/_authenticated/my-day.tsx"))).toMatch(/visit\.skipped_at/);
  });

  it("lets a tech complete a visit the server has always accepted", () => {
    // complete_visit takes ('scheduled','in_progress','missed'). The button
    // took two of the three, so a visit auto-marked missed overnight had both
    // Start and Complete dead with nothing saying why.
    const page = strip(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/const missed = visit\.status === "missed"/);
    expect(page).toMatch(/\(!inProg && !scheduled && !missed\)/);
    // And says so, rather than silently enabling a button that was dead
    // yesterday.
    expect(page).toMatch(/t\("visit\.missedNote"\)/);
    expect(en.visit.missedNote).toMatch(/^Marked missed overnight/);
  });
});
