// The saved day must not leave the phone five minutes after the tech leaves
// My Day.
//
// React Query's default gcTime is five minutes: a query nobody is watching is
// removed from the cache that long after its last observer goes. read-cache.ts
// writes what is in the cache, and the removal itself schedules a write, so a
// tech who loaded the day, opened the Waste log and stayed there lost the day
// from the device with nothing failing. read-cache.ts now holds every
// allowlisted root in memory for READ_CACHE_MAX_AGE_MS
// (holdPersistedReadsInMemory).
//
// Driven the way a-failed-refresh-keeps-the-day-on-the-phone.test.ts drives
// it: the real module, a real QueryClient, an in-memory localStorage, fake
// timers, and a reload between launches.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { environmentManager, QueryObserver, type QueryClient } from "@tanstack/react-query";
import { readCacheStorageKey, READ_CACHE_MAX_AGE_MS } from "@/lib/offline/read-cache-policy";

const MINUTE = 60_000;
const FETCHED_AT = Date.parse("2026-10-09T13:00:00.000Z");
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const DAY_KEY = ["my-day", "2026-10-09", ""];
const DAY = { staff: { id: "s-1" }, visits: [{ id: "v1", gate_code: "4821" }] };
const STORE_KEY = readCacheStorageKey(USER_A);
/** The write throttle in read-cache.ts. */
const THROTTLE_MS = 1_000;

class MemStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  clear() {
    this.map.clear();
  }
}

/** One launch of the app over the same device storage. */
async function launch(store: MemStorage, userId = USER_A) {
  vi.resetModules();
  vi.stubGlobal("window", {
    name: "",
    localStorage: store,
    sessionStorage: new MemStorage(),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("localStorage", store);
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  });
  const readCache = await import("@/lib/offline/read-cache");
  const { QueryClient } = await import("@tanstack/react-query");
  // No gcTime here on purpose: React Query's own default is the one the app
  // runs with (router.tsx sets none), and it is the one that dropped the day.
  const client = new QueryClient({
    defaultOptions: { queries: { networkMode: "offlineFirst", retry: false } },
  });
  readCache.ensureReadCachePersistence(client, userId);
  return client;
}

/** My Day on screen, then the tech taps another tab. */
async function watchThenLeave(client: QueryClient) {
  const observer = new QueryObserver(client, { queryKey: DAY_KEY, queryFn: async () => DAY });
  const stop = observer.subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(client.getQueryData(DAY_KEY)).toEqual(DAY);
  stop();
}

// React Query decides "am I on a server" once, when it loads, from whether
// `window` exists -- and on a server it never garbage-collects (gcTime
// Infinity). Under vitest it loads before any window is stubbed, so without
// this every query here would live for ever and the five-minute drop this
// file is about could not happen. The app runs in a browser.
beforeAll(() => environmentManager.setIsServer(() => false));
afterAll(() => environmentManager.setIsServer(() => typeof window === "undefined"));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(FETCHED_AT);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the day survives the tech leaving My Day", () => {
  it("six minutes on another screen and a persist later, the day is still on the phone", async () => {
    const store = new MemStorage();
    const client = await launch(store);
    await watchThenLeave(client);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY)).toContain("4821");

    // Six minutes on the Waste log: past React Query's five-minute default.
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    expect(client.getQueryData(DAY_KEY), "garbage-collected from memory").toEqual(DAY);

    // Something else changes and the cache is written again.
    await client.fetchQuery({ queryKey: ["my-org"], queryFn: async () => ({ id: "org-1" }) });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY), "the persist dropped the day").toContain("4821");

    // And a reload, offline, has it.
    const reloaded = await launch(store);
    expect(reloaded.getQueryData(DAY_KEY)).toEqual(DAY);
  });

  it("a copy restored on an offline launch survives the tech opening another page first", async () => {
    const store = new MemStorage();
    const first = await launch(store);
    await first.fetchQuery({ queryKey: DAY_KEY, queryFn: async () => DAY });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    // Cold launch in a dead zone. Nothing ever observes the restored day.
    vi.setSystemTime(FETCHED_AT + 30 * MINUTE);
    const offline = await launch(store);
    expect(offline.getQueryData(DAY_KEY)).toEqual(DAY);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(offline.getQueryData(DAY_KEY)).toEqual(DAY);
    expect(store.getItem(STORE_KEY)).toContain("4821");
  });

  it("holds the allowlisted roots for the max age, and nothing else", async () => {
    const client = await launch(new MemStorage());
    const gc = (key: unknown[]) =>
      client.getQueryCache().build(client, { queryKey: key }).options.gcTime;
    expect(gc(DAY_KEY)).toBe(READ_CACHE_MAX_AGE_MS);
    expect(gc(["visit-stations", "v1"])).toBe(READ_CACHE_MAX_AGE_MS);
    expect(gc(["my-org"])).toBe(READ_CACHE_MAX_AGE_MS);
    // A query the device never keeps is left on React Query's default.
    expect(gc(["clients"])).toBeUndefined();
    expect(gc(["addon-services"])).toBeUndefined();
  });
});

describe("the limits still hold with the day held in memory", () => {
  it("a day held in memory past the max age is not written beside a fresh one", async () => {
    const store = new MemStorage();
    const client = await launch(store);
    await watchThenLeave(client);

    // Three days and a bit later the app is still open, and a NEW day loads.
    vi.setSystemTime(FETCHED_AT + READ_CACHE_MAX_AGE_MS + MINUTE);
    const tomorrow = ["my-day", "2026-10-12", ""];
    await client.fetchQuery({ queryKey: tomorrow, queryFn: async () => ({ visits: ["fresh"] }) });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    const written = store.getItem(STORE_KEY) ?? "";
    expect(written).toContain("fresh");
    // Written beside it, the old day would share the fresh day's savedAt and
    // come back on the next launch as if it were new.
    expect(written).not.toContain("4821");
  });

  it("another user signing in on the same tablet does not inherit the held day", async () => {
    const store = new MemStorage();
    const client = await launch(store);
    await watchThenLeave(client);
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    // Same module, same client: the in-app user switch ensureReadCachePersistence
    // handles by clearing the cache.
    const readCache = await import("@/lib/offline/read-cache");
    readCache.ensureReadCachePersistence(client, USER_B);
    expect(client.getQueryData(DAY_KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(readCacheStorageKey(USER_B)) ?? "").not.toContain("4821");
  });
});
