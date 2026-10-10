import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Verified in v1.11 and deferred: the offline queue had no retry cap, and the
// sync loop `break`s at the first failure so it does not hammer a broken
// network. Together those mean ONE permanently-failing action blocks every
// action queued behind it for the rest of the tech's day, with nothing on
// screen to explain why nothing is syncing.
//
// The fix has to hold two things apart that look identical from inside the
// loop: a tech in a dead zone (retry forever — losing their work because the
// yard has no signal is the opposite of the point) and a server that will
// never accept this action (give up, so the queue moves).

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code — a rule this repo has had to learn twice. */
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

describe("the queue counts refusals", () => {
  const src = read("src/lib/offline/queue.ts");

  it("carries an attempt count on every action", () => {
    expect(src).toMatch(/attempts\?:\s*number/);
  });

  it("has a writer that increments it and reports the new total", () => {
    // The count is useless if nothing writes it, and the loop needs the value
    // back to decide — reading it separately would race with its own write.
    expect(src).toMatch(/export async function recordAttempt\([\s\S]{0,60}Promise<number>/);
    const fn = /export async function recordAttempt\([\s\S]*?\n\}/.exec(code(src))?.[0] ?? "";
    expect(fn, "recordAttempt not found").not.toBe("");
    // It must ADD to what is already stored — resetting to 1 each time means
    // the cap is never reached and the queue blocks forever.
    expect(fn).toMatch(/\(existing\.attempts \?\? 0\) \+ 1/);
    expect(fn).toMatch(/db\.put\("actions"/);
    expect(fn).toMatch(/return attempts;/);
  });

  it("keeps existing queued work across the schema bump", () => {
    // v1→v2 deliberately DROPPED rows, because a row with no owner replays as
    // the wrong person. Adding a counter is not that: a missing count means
    // zero. Dropping a tech's queued day to add a field would be a worse bug
    // than the one being fixed, so v3 must not delete either store.
    const v3 = /oldVersion < 3[\s\S]{0,400}/.exec(code(src))?.[0] ?? "";
    expect(v3).not.toMatch(/deleteObjectStore/);
    expect(src).toMatch(/openDB<OfflineDB>\("scoop-offline",\s*3/);
  });
});

describe("the sync loop gives up only on a reachable server", () => {
  const src = read("src/lib/offline/sync.ts");
  const body = code(src);

  it("has a finite cap", () => {
    expect(src).toMatch(/export const MAX_ATTEMPTS = \d+/);
    const n = Number(/MAX_ATTEMPTS = (\d+)/.exec(src)![1]);
    // Low enough to unblock a day, high enough to survive a flaky afternoon.
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(10);
  });

  it("does not count a failure that happened offline", () => {
    // The whole distinction. Without this, a tech working a dead zone burns
    // five attempts on their first completion and loses it.
    //
    // This asserted `navigator.onLine` by name until the iOS pass, and that
    // was pinning the MECHANISM rather than the property. The mechanism moved:
    // in a WKWebView `navigator.onLine` is not refreshed reliably while the
    // app is suspended, so the check now composes it with the native interface
    // state (src/lib/offline/connectivity.ts). What this test cares about is
    // unchanged and is what it now says: the loop consults a
    // definitely-offline signal, and only counts an attempt when it was not
    // offline.
    expect(body).toMatch(/isDefinitelyOffline\(\)/);
    expect(body).toMatch(/if \(online/);
  });

  it("does not count a failure it could not even ask about", () => {
    // QA-P4 strengthened this. `navigator.onLine` can be true while nothing is
    // reachable, so the ONLINE check alone still let five cycles in a dead
    // zone burn an action's whole budget and discard a tech's work — the
    // residual risk the module's own comment used to state and accept.
    //
    // A transport failure or a timeout is not evidence that an action will
    // never succeed. It is evidence that we could not ask.
    expect(body).toMatch(/if \(online && !isTransportFailure\(e\)\)/);
  });

  it("puts a deadline on the replay itself", () => {
    // Without one, a replay against a network that reports itself up but
    // answers nothing hangs for ever — and `running` is only cleared in the
    // `finally`, so the whole sync loop wedges for the rest of the session
    // and every later call returns zeros. The queue fills and never drains,
    // which is the same outcome for the tech as never queueing at all.
    expect(body).toMatch(/withDeadline\(runOne\(action, callers\), REPLAY_DEADLINE_MS/);
    expect(src).toMatch(/export const REPLAY_DEADLINE_MS = \d[\d_]*/);
  });

  it("continues past the action it gave up on rather than breaking", () => {
    // `break` here is what made one bad action block the whole queue. The
    // dead-letter path must fall through to the next item.
    const deadPath = /if \(attempts >= MAX_ATTEMPTS\)[\s\S]*?\n\s*\}/.exec(body)?.[0] ?? "";
    expect(deadPath, "no dead-letter branch found").not.toBe("");
    expect(deadPath).toMatch(/continue;/);
    expect(deadPath).not.toMatch(/\bbreak;/);
  });

  it("frees the photo bytes when it gives up on a photo", () => {
    // Otherwise the blob outlives the action that pointed at it and nothing
    // will ever delete it — the unbounded-photo-storage problem, made worse.
    const deadPath = /if \(attempts >= MAX_ATTEMPTS\)[\s\S]*?\n\s*\}/.exec(body)![0];
    expect(deadPath).toMatch(/deletePhoto\(action\.photoId\)/);
  });

  it("reports the loss in its own counter, never folded into success", () => {
    expect(src).toMatch(/deadLettered: number/);
    // Every early return must carry the field, or a caller reads undefined and
    // the toast never fires.
    // Matched across newlines: the early return was reformatted onto several
    // lines when `alreadyRunning` was added, and a single-line-only pattern
    // silently found NOTHING to check rather than failing on the field it
    // guards — a guard that passes by matching zero things is the failure this
    // repo keeps finding elsewhere.
    const returns = src.match(/\{\s*attempted: 0[\s\S]*?\}/g) ?? [];
    expect(returns.length).toBeGreaterThan(0);
    for (const r of returns) expect(r).toMatch(/deadLettered: 0/);
  });
});

describe("the tech is told", () => {
  // The replay's toasts live in the signed-in layout's provider since
  // 2026-10-09, so the tech is told from whatever page is open.
  const src = read("src/components/QueueSync.tsx");

  it("surfaces discarded work as an error, separately from a sync", () => {
    // A dead-letter nothing surfaces is the same bug wearing a different hat:
    // the work is gone and the tech believes it synced. The v1.11 finding was
    // explicitly "no UI to inspect or clear it".
    expect(src).toMatch(/res\.deadLettered > 0/);
    const branch = /if \(res\.deadLettered > 0\)[\s\S]*?\n\s{4}\}/.exec(src)?.[0] ?? "";
    expect(branch).toMatch(/toast\.error/);
    // Not a two-second toast for permanently lost work.
    expect(branch).toMatch(/duration/);
  });
});
