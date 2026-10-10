// A failed refresh must not delete the saved day from the phone.
//
// Reported 2026-10-09: a tester loaded My Day online, turned the network off
// and reloaded, and got "Couldn't load this day, and no synced copy is saved
// on this device." The day HAD been saved. What removed it:
//
//   - read-cache.ts persisted only queries whose status was "success";
//   - a refetch that fails keeps the data but flips the status to "error"
//     (returning focus from DevTools was the refetch; My Day's staleTime is 0);
//   - the next throttled write skipped the day, found nothing else to write,
//     and removed the store;
//   - the reload, offline, then had `isError && !data`.
//
// These cases drive the real read-cache module with a real QueryClient and an
// in-memory localStorage, through a success, a failed refetch, a write and a
// reload, because the bug lived in the wiring between them and no predicate on
// its own would have shown it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import {
  readCacheStorageKey,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_VERSION,
} from "@/lib/offline/read-cache-policy";
import { asLastGoodCopy, hasLastGoodCopy, savedCopiesToKeep } from "@/lib/offline/last-good-copy";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
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

/** One launch of the app: a fresh module (so its "who is persisting" state
 *  starts empty, as after a reload) over the SAME device storage. */
async function launch(store: MemStorage) {
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
  // The production defaults that matter here (router.tsx): offlineFirst, and
  // no retry while the device is offline.
  const client = new QueryClient({
    defaultOptions: { queries: { networkMode: "offlineFirst", retry: false } },
  });
  readCache.ensureReadCachePersistence(client, USER_A);
  return client;
}

async function failToRefetch(client: QueryClient) {
  await client
    .fetchQuery({
      queryKey: DAY_KEY,
      queryFn: () => Promise.reject(new TypeError("Failed to fetch")),
      staleTime: 0,
    })
    .catch(() => {});
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(FETCHED_AT);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the saved day survives a failed refresh", () => {
  it("success, a failed refetch with the day on screen, a write, a reload: the day is back", async () => {
    const store = new MemStorage();
    const online = await launch(store);
    await online.fetchQuery({ queryKey: DAY_KEY, queryFn: async () => DAY });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY)).toContain("4821");

    // Twenty minutes on, signal is gone and focus comes back: the refetch fails.
    vi.setSystemTime(FETCHED_AT + 20 * MINUTE);
    await failToRefetch(online);
    // The state the bug needed — proof this test reproduces it, not a tidier one.
    const failed = online.getQueryState(DAY_KEY);
    expect(failed?.status).toBe("error");
    expect(failed?.data).toEqual(DAY);

    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    const written = store.getItem(STORE_KEY);
    expect(written, "the failed refetch removed the saved day").toContain("4821");
    // Written as the success it last was: an error on disk would come back on
    // the next launch looking like a fresh failure.
    expect(written).not.toContain('"status":"error"');

    // Reload, still offline.
    const reloaded = await launch(store);
    expect(reloaded.getQueryData(DAY_KEY)).toEqual(DAY);
    const restored = reloaded.getQueryState(DAY_KEY);
    expect(restored?.status).toBe("success");
    expect(restored?.error).toBeNull();
    // When it was FETCHED, not when the failure was written — this is the age
    // My Day's banner shows and the age the max-age rule measures.
    expect(restored?.dataUpdatedAt).toBe(FETCHED_AT);
  });

  it("a fetch that fails with nothing in memory leaves the copy on disk alone", async () => {
    const store = new MemStorage();
    const first = await launch(store);
    await first.fetchQuery({ queryKey: DAY_KEY, queryFn: async () => DAY });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);

    const second = await launch(store);
    // The in-memory copy is gone (as a reset or a cache clear leaves it) and
    // the fetch that would replace it fails.
    second.removeQueries({ queryKey: DAY_KEY });
    await failToRefetch(second);
    expect(second.getQueryState(DAY_KEY)?.status).toBe("error");
    expect(second.getQueryData(DAY_KEY)).toBeUndefined();
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY), "overwritten with nothing").toContain("4821");

    const third = await launch(store);
    expect(third.getQueryData(DAY_KEY)).toEqual(DAY);
  });
});

describe("the limits still hold", () => {
  it("a copy past the max age is not kept by a failed refetch", async () => {
    const store = new MemStorage();
    const client = await launch(store);
    await client.fetchQuery({ queryKey: DAY_KEY, queryFn: async () => DAY });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY)).toContain("4821");

    vi.setSystemTime(FETCHED_AT + READ_CACHE_MAX_AGE_MS + MINUTE);
    await failToRefetch(client);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY)).toBeNull();
  });

  it("an expired store is still dropped on reload, even after a kept failure", async () => {
    const store = new MemStorage();
    const client = await launch(store);
    await client.fetchQuery({ queryKey: DAY_KEY, queryFn: async () => DAY });
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    vi.setSystemTime(FETCHED_AT + HOUR);
    await failToRefetch(client);
    await vi.advanceTimersByTimeAsync(THROTTLE_MS);
    expect(store.getItem(STORE_KEY)).toContain("4821");

    // The phone sits in a drawer past the max age, then opens offline.
    vi.setSystemTime(FETCHED_AT + READ_CACHE_MAX_AGE_MS + MINUTE);
    const reloaded = await launch(store);
    expect(reloaded.getQueryData(DAY_KEY)).toBeUndefined();
    expect(store.getItem(STORE_KEY)).toBeNull();
  });

  it("never carries another user's copy, or an expired one, into a write", () => {
    const entry = {
      queryKey: DAY_KEY,
      queryHash: JSON.stringify(DAY_KEY),
      state: { status: "success", data: DAY, dataUpdatedAt: FETCHED_AT },
    };
    const envelope = (userId: string) => ({
      version: READ_CACHE_VERSION,
      userId,
      savedAt: FETCHED_AT,
      state: { mutations: [], queries: [entry] },
    });
    const failedHashes = new Set([entry.queryHash]);
    const now = FETCHED_AT + HOUR;

    expect(savedCopiesToKeep(envelope(USER_A), { userId: USER_A, now, failedHashes })).toEqual([
      entry,
    ]);
    expect(savedCopiesToKeep(envelope(USER_B), { userId: USER_A, now, failedHashes })).toEqual([]);
    expect(
      savedCopiesToKeep(envelope(USER_A), {
        userId: USER_A,
        now: FETCHED_AT + READ_CACHE_MAX_AGE_MS + MINUTE,
        failedHashes,
      }),
    ).toEqual([]);
    // Only the queries that failed: an entry the cache dropped for any other
    // reason is not resurrected by this.
    expect(
      savedCopiesToKeep(envelope(USER_A), { userId: USER_A, now, failedHashes: new Set() }),
    ).toEqual([]);
    // And only an allowlisted root, whatever the old store says.
    const smuggled = { ...envelope(USER_A) };
    smuggled.state = {
      mutations: [],
      queries: [{ ...entry, queryKey: ["clients"], queryHash: '["clients"]' }],
    };
    expect(
      savedCopiesToKeep(smuggled, {
        userId: USER_A,
        now,
        failedHashes: new Set(['["clients"]']),
      }),
    ).toEqual([]);
  });

  it("keeps a failed refresh's data only while it has data and is in date", () => {
    const now = FETCHED_AT + HOUR;
    expect(
      hasLastGoodCopy({ status: "success", data: DAY, dataUpdatedAt: FETCHED_AT }, { now }),
    ).toBe(true);
    expect(
      hasLastGoodCopy({ status: "error", data: DAY, dataUpdatedAt: FETCHED_AT }, { now }),
    ).toBe(true);
    expect(hasLastGoodCopy({ status: "error", data: undefined, dataUpdatedAt: 0 }, { now })).toBe(
      false,
    );
    expect(hasLastGoodCopy({ status: "pending", data: undefined }, { now })).toBe(false);
    // Fetched in the future: an unmeasurable age is not a young one.
    expect(
      hasLastGoodCopy({ status: "error", data: DAY, dataUpdatedAt: now + MINUTE }, { now }),
    ).toBe(false);
    expect(
      hasLastGoodCopy(
        { status: "error", data: DAY, dataUpdatedAt: FETCHED_AT },
        { now: FETCHED_AT + READ_CACHE_MAX_AGE_MS + MINUTE },
      ),
    ).toBe(false);
  });

  it("takes the failure off and leaves the fetch time alone", () => {
    const copy = asLastGoodCopy({
      queryKey: DAY_KEY,
      state: {
        status: "error",
        fetchStatus: "fetching",
        data: DAY,
        dataUpdatedAt: FETCHED_AT,
        error: new TypeError("Failed to fetch"),
        fetchFailureCount: 1,
      },
    });
    expect(copy.state).toMatchObject({
      status: "success",
      fetchStatus: "idle",
      error: null,
      fetchFailureCount: 0,
      data: DAY,
      dataUpdatedAt: FETCHED_AT,
    });
  });
});

describe("My Day does not refetch on focus while offline", () => {
  it("gates the day query's focus refetch on the honest offline signal", () => {
    const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
    const src = readFileSync(join(root, "src/routes/_authenticated/my-day.tsx"), "utf8");
    const start = src.indexOf('queryKey: ["my-day", day, staffParam ?? ""]');
    expect(start, "the day query moved").toBeGreaterThan(-1);
    const options = src.slice(start, src.indexOf("});", start));
    expect(options).toMatch(/refetchOnWindowFocus:\s*\(\)\s*=>\s*!isDefinitelyOffline\(\)/);
  });
});
