// #652 (F-27): a reassign held for Undo was lost if the page was reloaded or
// the app was killed inside the window. Walk: lost on reload. Shipped native
// bundle: lost on an Android force-stop at 1.29 s and an iOS terminate at
// about 0.5 s. The only copy was a closure in memory, rescued only by a
// `pagehide` listener that a killed WKWebView never fires.
//
// Each case here models one of those exits on a fake page: a window and
// document that dispatch events, and a localStorage that outlives the module.
// A "reload" is vi.resetModules() and a fresh import: everything in memory is
// gone, storage is not, exactly as on a phone.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const durable = (userId = USER) => ({
  kind: "reassign",
  userId,
  payload: { visitId: "v1", staffId: "s2", ifStillFrom: "s1" },
});

let store: Map<string, string>;
let docListeners: Map<string, Array<() => void>>;
let winListeners: Map<string, Array<() => void>>;
let visibility: "visible" | "hidden";

function fakePage() {
  docListeners = new Map();
  winListeners = new Map();
  visibility = "visible";
  const on = (m: Map<string, Array<() => void>>) => (t: string, f: () => void) =>
    m.set(t, [...(m.get(t) ?? []), f]);
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  vi.stubGlobal("window", { addEventListener: on(winListeners), localStorage });
  vi.stubGlobal("document", {
    addEventListener: on(docListeners),
    get visibilityState() {
      return visibility;
    },
  });
}

const fire = (m: Map<string, Array<() => void>>, t: string) => m.get(t)?.forEach((f) => f());

/** A page load: fresh module state, same storage, and none of the last
 *  page's timers (a killed process runs nothing). */
async function load() {
  // clearAllTimers also rewinds the fake clock; time itself carries on.
  const t = Date.now();
  vi.clearAllTimers();
  vi.setSystemTime(t);
  vi.resetModules();
  fakePage();
  return import("@/lib/undo-window");
}

beforeEach(() => {
  store = new Map();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a held reassign and the page going away", () => {
  it("is sent the moment the app is backgrounded (visibilitychange), not only on pagehide", async () => {
    const { holdForUndo } = await load();
    const send = vi.fn(async () => {});
    holdForUndo(send, { durable: durable() });
    vi.advanceTimersByTime(1_000);
    visibility = "hidden";
    fire(docListeners, "visibilitychange");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reload at 1 s: the next page sends it once the window has closed", async () => {
    const first = await load();
    const lostWithThePage = vi.fn(async () => {});
    first.holdForUndo(lostWithThePage, { durable: durable() });
    vi.advanceTimersByTime(1_000);

    // Killed: no event, no timer, nothing in memory survives.
    const next = await load();
    const reassign = vi.fn(async () => ({ ok: true }));
    const replay = next.replayHeldChanges(USER, { reassign });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(reassign).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(replay).resolves.toBe(1);
    expect(reassign).toHaveBeenCalledWith({ visitId: "v1", staffId: "s2", ifStillFrom: "s1" });
    expect(lostWithThePage).not.toHaveBeenCalled();

    // And only once: a second start finds nothing left.
    const again = await load();
    await expect(again.replayHeldChanges(USER, { reassign })).resolves.toBe(0);
    expect(reassign).toHaveBeenCalledTimes(1);
  });

  it("a pick made before the user is known is still written once the lookup answers", async () => {
    const first = await load();
    let answer!: (id: string | null) => void;
    const lookup = new Promise<string | null>((r) => (answer = r));
    first.holdForUndo(async () => {}, { durable: { ...durable(), userId: lookup } });
    answer(USER);
    await vi.advanceTimersByTimeAsync(500);

    const next = await load();
    const reassign = vi.fn(async () => ({}));
    const replay = next.replayHeldChanges(USER, { reassign });
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(replay).resolves.toBe(1);
  });

  it("killed long after the window: sent at once on the next start", async () => {
    const first = await load();
    first.holdForUndo(async () => {}, { durable: durable() });
    vi.setSystemTime(Date.now() + 60_000);
    const next = await load();
    const reassign = vi.fn(async () => ({}));
    await expect(next.replayHeldChanges(USER, { reassign })).resolves.toBe(1);
  });

  it("Undo inside the window still cancels it, and leaves nothing to replay", async () => {
    const first = await load();
    const send = vi.fn(async () => {});
    const held = first.holdForUndo(send, { durable: durable() });
    vi.advanceTimersByTime(1_000);
    expect(held.undo()).toBe(true);
    await expect(held.done).resolves.toBe(false);

    const next = await load();
    const reassign = vi.fn(async () => ({}));
    const replay = next.replayHeldChanges(USER, { reassign });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(replay).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(reassign).not.toHaveBeenCalled();
  });

  it("a change that reached the server is not sent again", async () => {
    const first = await load();
    const held = first.holdForUndo(async () => {}, { durable: durable() });
    vi.advanceTimersByTime(5_000);
    await expect(held.done).resolves.toBe(true);
    const next = await load();
    const reassign = vi.fn(async () => ({}));
    await expect(next.replayHeldChanges(USER, { reassign })).resolves.toBe(0);
  });

  it("is replayed only for the person who held it (a shared tablet)", async () => {
    const first = await load();
    first.holdForUndo(async () => {}, { durable: durable(OTHER) });
    vi.setSystemTime(Date.now() + 10_000);
    const next = await load();
    const reassign = vi.fn(async () => ({}));
    await expect(next.replayHeldChanges(USER, { reassign })).resolves.toBe(0);
    expect(reassign).not.toHaveBeenCalled();
  });

  it("is dropped, not sent, after a day", async () => {
    const first = await load();
    first.holdForUndo(async () => {}, { durable: durable() });
    vi.setSystemTime(Date.now() + first.REPLAY_MAX_AGE_MS + 10_000);
    const next = await load();
    const reassign = vi.fn(async () => ({}));
    await expect(next.replayHeldChanges(USER, { reassign })).resolves.toBe(0);
  });
});

describe("the wiring", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the drawer writes the held reassign to the device, guarded by the tech it had", () => {
    const src = read("src/components/VisitDetailDrawer.tsx");
    expect(src).toMatch(/holdForUndo\(send,\s*\{\s*durable/);
    expect(src).toMatch(/ifStillFrom:\s*v\?\.assigned_staff_id/);
  });

  it("the signed-in shell replays what a previous page left behind", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    expect(src).toMatch(/replayHeldChanges\(userId/);
    expect(src).toMatch(/\[REASSIGN_HELD_KIND\]/);
  });

  it("reassignVisit leaves a visit alone when it no longer has the tech the replay expects", () => {
    const src = read("src/lib/visits.functions.ts");
    const at = src.indexOf("export const reassignVisit");
    const body = src.slice(at, src.indexOf("export const reorderRoute", at));
    expect(body).toMatch(/ifStillFrom/);
    expect(body.indexOf("ifStillFrom !== undefined")).toBeLessThan(
      body.indexOf('rpc("reassign_visit"'),
    );
  });
});
