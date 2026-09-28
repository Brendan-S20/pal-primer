import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAutoSync, type SyncTrigger } from "@/lib/offline/auto-sync";

// Reported 2026-09-27: opening My Day with NOTHING queued toasted "Already
// syncing…".
//
// The review guessed the auto-sync effect ran twice. It did, but not because
// of its dependencies — the server-fn callers are useCallback-stable in
// @tanstack/react-start, so `runSync` never changed identity. It ran twice
// because the PAGE mounted twice: this app has no src/client.tsx, so it
// hydrates through TanStack Start's default client entry, which wraps the tree
// in <StrictMode>, and StrictMode mounts, unmounts and remounts every component
// in development to flush out effects that are unsafe to repeat. Each mount
// started a replay; the second met the first still reading IndexedDB; the page
// read `alreadyRunning` as a second press of the Sync button. A tab flicked
// away from and back during a long replay does the same thing in production.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

/** A window with the four members startAutoSync touches, on fake timers. */
function fakeWindow() {
  const events = new EventTarget();
  return {
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    setTimeout: ((fn: () => void, ms?: number) => setTimeout(fn, ms)) as Window["setTimeout"],
    clearTimeout: ((id?: number) => clearTimeout(id)) as Window["clearTimeout"],
    goOnline: () => events.dispatchEvent(new Event("online")),
  };
}

describe("one replay per real mount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("StrictMode's mount → unmount → mount starts ONE replay, not two", () => {
    const win = fakeWindow();
    const calls: SyncTrigger[] = [];
    const run = (t: SyncTrigger) => void calls.push(t);

    // Exactly what StrictMode does to an effect in development.
    const rehearsal = startAutoSync(run, win, () => false);
    rehearsal();
    const cleanup = startAutoSync(run, win, () => false);
    vi.runAllTimers();

    expect(calls).toEqual(["auto"]);
    cleanup();
  });

  it("…and leaves one `online` listener behind, not two", () => {
    const win = fakeWindow();
    const calls: SyncTrigger[] = [];
    const run = (t: SyncTrigger) => void calls.push(t);
    startAutoSync(run, win, () => false)();
    const cleanup = startAutoSync(run, win, () => false);
    vi.runAllTimers();
    calls.length = 0;

    win.goOnline();
    expect(calls).toEqual(["auto"]);

    cleanup();
    win.goOnline();
    expect(calls).toEqual(["auto"]);
  });

  it("does not replay into a dead zone, and asks when the replay would START", () => {
    const win = fakeWindow();
    const calls: SyncTrigger[] = [];
    let offline = false;
    const cleanup = startAutoSync(
      (t) => void calls.push(t),
      win,
      () => offline,
    );
    // The signal drops between mount and the timer firing.
    offline = true;
    vi.runAllTimers();
    expect(calls).toEqual([]);
    cleanup();
  });

  it("never claims to be a tap", () => {
    const win = fakeWindow();
    const calls: SyncTrigger[] = [];
    const cleanup = startAutoSync(
      (t) => void calls.push(t),
      win,
      () => false,
    );
    vi.runAllTimers();
    win.goOnline();
    expect(calls.every((t) => t === "auto")).toBe(true);
    cleanup();
  });
});

describe("My Day says 'Already syncing…' only to the person who pressed Sync", () => {
  const page = code(read("src/routes/_authenticated/my-day.tsx"));

  it("gates the toast on a tap", () => {
    const branch = /if \(res\.alreadyRunning\) \{[\s\S]*?return;\s*\}/.exec(page)?.[0] ?? "";
    expect(branch, "alreadyRunning branch not found").not.toBe("");
    expect(branch).toMatch(/if \(trigger === "tap"\) toast\.info\("Already syncing…"\)/);
  });

  it("the Sync button is the tap, and it is the only one", () => {
    expect(page.match(/runSync\("tap"\)/g)).toHaveLength(1);
    const button = page.slice(page.lastIndexOf("{online && pending > 0 && ("));
    expect(button.slice(0, 400)).toMatch(/runSync\("tap"\)/);
  });

  it("replays on mount through startAutoSync, whose cleanup cancels it", () => {
    expect(page).toMatch(
      /useEffect\(\(\) => startAutoSync\(runSync, window, isDefinitelyOffline\), \[runSync\]\)/,
    );
    // The old shape — replay straight from the effect body — is what the
    // rehearsal mount could not take back.
    expect(page).not.toMatch(/isDefinitelyOffline\(\)\) runSync\(/);
  });
});
