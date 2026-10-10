// The offline queue replays on reconnect from whatever page is open.
//
// startAutoSync was started by My Day alone, so a tech who queued work in a
// dead zone and then opened the Waste log, Alerts or the More sheet had a
// queue that sat there until they went back to Today. It is now started once,
// by components/QueueSync.tsx in the `_authenticated` layout, and My Day's
// Sync button calls the same replay.
//
// The replay is driven here with no My Day anywhere in the module graph: the
// real startAutoSync, the real makeQueueReplay, and -- for the owner check --
// the real syncQueue over the real queue.ts on an in-memory IndexedDB.

import { fileURLToPath } from "node:url";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── An IndexedDB that lives in a Map ────────────────────────────────────────
const idb = vi.hoisted(() => ({ actions: new Map<string, any>(), photos: new Map<string, any>() }));
vi.mock("idb", () => ({
  openDB: async () => {
    const store = (name: string) => (name === "photos" ? idb.photos : idb.actions);
    return {
      getAllFromIndex: async (name: string) =>
        [...store(name).values()].sort((a, b) => a.ts - b.ts),
      getAll: async (name: string) => [...store(name).values()],
      get: async (name: string, id: string) => store(name).get(id),
      put: async (name: string, v: any) => void store(name).set(v.id, v),
      delete: async (name: string, id: string) => void store(name).delete(id),
    };
  },
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { startAutoSync, type SyncTrigger } from "@/lib/offline/auto-sync";
import { makeQueueReplay } from "@/lib/offline/queue-replay";
import { syncQueue, type SyncCallers, type SyncResult } from "@/lib/offline/sync";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

/** The four members startAutoSync touches, and a way to say "signal is back". */
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

function callers() {
  const ok = () => vi.fn(async () => ({}));
  return {
    startVisit: ok(),
    completeVisit: ok(),
    skipVisit: ok(),
    recordVisitPhoto: ok(),
    logStationService: ok(),
    clockIn: ok(),
    clockOut: ok(),
    recordFieldCollection: ok(),
    createExpense: ok(),
  } satisfies SyncCallers;
}

const empty: SyncResult = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  dropped: 0,
  deadLettered: 0,
  deadLetteredVisitIds: [],
  droppedVisitIds: [],
  alreadyRunning: false,
};

beforeEach(() => {
  idb.actions.clear();
  idb.photos.clear();
  // deleteAction announces the change to the page.
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconnecting replays the queue with no My Day mounted", () => {
  it("launched offline on another screen, signal returns: the queue goes out as the signed-in tech", async () => {
    const win = fakeWindow();
    const replay = vi.fn(async () => ({ ...empty, attempted: 1, succeeded: 1 }));
    const report = vi.fn();
    let offline = true;
    const run = makeQueueReplay({
      callers: callers(),
      resolveUserId: async () => USER_B,
      report,
      replay,
    });
    const stop = startAutoSync(run, win, () => offline);

    // The launch replay is skipped in a dead zone.
    await new Promise((r) => setTimeout(r, 5));
    expect(replay).not.toHaveBeenCalled();

    offline = false;
    win.goOnline();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    expect(replay).toHaveBeenCalledTimes(1);
    expect(replay.mock.calls[0]?.[1]).toBe(USER_B);
    expect(report.mock.calls[0]?.[1] satisfies SyncTrigger).toBe("auto");
    stop();
  });

  it("nobody resolvable on the device: nothing is replayed and nothing reported", async () => {
    const replay = vi.fn(async () => empty);
    const report = vi.fn();
    const run = makeQueueReplay({
      callers: callers(),
      resolveUserId: async () => {
        throw new Error("no identity");
      },
      report,
      replay,
    });
    await run("auto");
    expect(replay).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("another user's queued work is not replayed", async () => {
    // Tech A queued a start and a clock-in on the shared tablet and signed out
    // without signal; tech B is signed in now and has one collection queued.
    idb.actions.set("a1", { id: "a1", ts: 1, userId: USER_A, kind: "start", visitId: "va" });
    idb.actions.set("a2", { id: "a2", ts: 2, userId: USER_A, kind: "clock_in" });
    idb.actions.set("b1", {
      id: "b1",
      ts: 3,
      userId: USER_B,
      kind: "collection",
      visitId: "vb",
      amountCents: 4000,
      method: "cash",
      clientKey: "33333333-3333-4333-8333-333333333333",
    });

    const win = fakeWindow();
    const c = callers();
    const report = vi.fn();
    const run = makeQueueReplay({ callers: c, resolveUserId: async () => USER_B, report });
    let offline = true;
    const stop = startAutoSync(run, win, () => offline);
    // Past the launch replay, which a dead zone skips.
    await new Promise((r) => setTimeout(r, 5));
    offline = false;
    win.goOnline();
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(1));
    stop();

    expect(report.mock.calls[0]?.[0]).toMatchObject({ attempted: 1, succeeded: 1 });
    expect(c.recordFieldCollection).toHaveBeenCalledTimes(1);
    expect(c.startVisit).not.toHaveBeenCalled();
    expect(c.clockIn).not.toHaveBeenCalled();
    // A's work is still on the device, for A, untouched.
    expect([...idb.actions.keys()].sort()).toEqual(["a1", "a2"]);
  });

  it("is the real syncQueue by default", () => {
    // The seam exists for the test above; the app passes nothing.
    expect(code(read("src/lib/offline/queue-replay.ts"))).toMatch(
      /const replay = deps\.replay \?\? syncQueue;/,
    );
    expect(syncQueue).toBeTypeOf("function");
  });
});

describe("the replay is started once, by the signed-in layout", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(join(ROOT, dir)).flatMap((name) => {
      const rel = `${dir}/${name}`;
      if (statSync(join(ROOT, rel)).isDirectory()) return sourceFiles(rel);
      return /\.(ts|tsx)$/.test(name) ? [rel] : [];
    });
  }

  it("startAutoSync is called in exactly one place, and it is not My Day", () => {
    const callers = sourceFiles("src").filter((f) =>
      /\bstartAutoSync\(/.test(code(read(f)).replace(/export function startAutoSync\(/, "")),
    );
    expect(callers).toEqual(["src/components/QueueSync.tsx"]);
  });

  it("the `_authenticated` layout wraps every signed-in page in the provider", () => {
    const layout = code(read("src/routes/_authenticated/route.tsx"));
    expect(layout).toMatch(/component: SignedInApp,/);
    expect(layout).toMatch(
      /function SignedInApp\(\) \{\s*return \(\s*<QueueSyncProvider>\s*<AppShell \/>\s*<\/QueueSyncProvider>/,
    );
  });

  it("My Day only taps it and names the stops", () => {
    const page = code(read("src/routes/_authenticated/my-day.tsx"));
    expect(page).toMatch(/const \{ runSync, visitNames \} = useQueueSync\(\);/);
    expect(page).not.toMatch(/\bsyncQueue\b/);
    expect(page).not.toMatch(/\bstartAutoSync\b/);
  });

  it("the sign-out flush and the replay send with the same callers", () => {
    const signOut = code(read("src/hooks/useOfflineSignOut.tsx"));
    expect(signOut).toMatch(/const callers = useSyncCallers\(\);/);
    expect(signOut).toMatch(/flushThenClearAndSignOut\(\{\s*callers,/);
    expect(code(read("src/components/QueueSync.tsx"))).toMatch(
      /const callers = useSyncCallers\(\);/,
    );
  });
});
