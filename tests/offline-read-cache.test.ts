import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeReadFreshness,
  formatCacheAge,
  isOfflineAuthFailure,
  isPersistableQueryKey,
  isRestorableEnvelope,
  readCacheStorageKey,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_TRUST_HORIZON_MS,
  READ_CACHE_VERSION,
  selectPersistableQueries,
  shouldPersistReads,
} from "@/lib/offline/read-cache-policy";

// Offline READS (Mobile Phase 3). Writes already survived a dead zone; reads
// did not, so a narrow slice of the React Query cache is now written to the
// device. Every case below is one where the WRONG answer still looks fine on a
// developer's laptop and only shows up as a leak, or as a tech driving
// yesterday's route, in the field.
const NOW = Date.parse("2026-07-31T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

describe("what may be written to a device", () => {
  it("persists the day's route, the org, and visit stations", () => {
    expect(isPersistableQueryKey(["my-day", "2026-07-31", ""])).toBe(true);
    expect(isPersistableQueryKey(["my-org"])).toBe(true);
    expect(isPersistableQueryKey(["visit-stations", "visit-1"])).toBe(true);
  });

  it("refuses office and platform data — a lost phone must not carry it", () => {
    // These all resolve fine on screen; the only thing wrong with persisting
    // them is that they end up on a device that gets left in a truck.
    for (const key of [
      ["clients"],
      ["client", "abc"],
      ["invoices", { status: "open" }],
      ["reports", "revenue"],
      ["platform-metrics"],
      ["addon-services"],
    ]) {
      expect(isPersistableQueryKey(key), JSON.stringify(key)).toBe(false);
    }
  });

  it("matches the ROOT segment only, never an argument that happens to say my-day", () => {
    // A key like ["audit-log", "my-day"] would pass a naive `key.includes`
    // check and quietly smuggle an unrelated payload onto the device.
    expect(isPersistableQueryKey(["audit-log", "my-day"])).toBe(false);
    expect(isPersistableQueryKey(["my-day-exports"])).toBe(false);
  });

  it("rejects malformed keys instead of throwing during a cache write", () => {
    expect(isPersistableQueryKey([])).toBe(false);
    expect(isPersistableQueryKey("my-day")).toBe(false);
    expect(isPersistableQueryKey(undefined)).toBe(false);
    expect(isPersistableQueryKey([{ scope: "my-day" }])).toBe(false);
  });
});

describe("scoping the store to one user", () => {
  it("gives two techs on the same tablet different keys", () => {
    expect(readCacheStorageKey(USER_A)).not.toBe(readCacheStorageKey(USER_B));
    expect(readCacheStorageKey(USER_A)).toContain(USER_A);
  });

  it("refuses another user's envelope even when it is found at this user's key", () => {
    // The shared-crew-tablet case. A stale key, a hand-edited store or a
    // version left behind by an older build must never resolve to someone
    // else's addresses — so the user id INSIDE the envelope is what decides.
    const envelope = {
      version: READ_CACHE_VERSION,
      userId: USER_B,
      savedAt: NOW - 60_000,
      state: { mutations: [], queries: [] },
    };
    expect(isRestorableEnvelope(envelope, { userId: USER_A, now: NOW })).toBe(false);
    expect(isRestorableEnvelope(envelope, { userId: USER_B, now: NOW })).toBe(true);
  });

  it("will not persist anything without a user id", () => {
    expect(shouldPersistReads({ userId: null, impersonating: false })).toBe(false);
    expect(shouldPersistReads({ userId: "", impersonating: false })).toBe(false);
    expect(shouldPersistReads({ userId: USER_A, impersonating: false })).toBe(true);
  });
});

describe("impersonation", () => {
  it("never persists, even for a perfectly valid user id", () => {
    // A platform admin impersonating a tenant is looking at that tenant's real
    // customer addresses and gate codes. Writing them to the admin's own laptop
    // outlives the impersonation window by the life of the laptop.
    expect(shouldPersistReads({ userId: USER_A, impersonating: true })).toBe(false);
  });
});

describe("bounding the store", () => {
  const envelope = (savedAt: number) => ({
    version: READ_CACHE_VERSION,
    userId: USER_A,
    savedAt,
    state: { mutations: [], queries: [] },
  });

  it("drops a store older than the max age instead of showing ancient days", () => {
    // A device that spent a week in a drawer: the data still parses, still
    // renders, and is entirely wrong.
    expect(
      isRestorableEnvelope(envelope(NOW - READ_CACHE_MAX_AGE_MS - 1), { userId: USER_A, now: NOW }),
    ).toBe(false);
    expect(
      isRestorableEnvelope(envelope(NOW - READ_CACHE_MAX_AGE_MS), { userId: USER_A, now: NOW }),
    ).toBe(true);
  });

  it("rejects a store written by a different envelope version", () => {
    // Feeding an old shape to hydrate() produces a half-populated cache that
    // looks like data rather than an error.
    expect(
      isRestorableEnvelope(
        { ...envelope(NOW), version: READ_CACHE_VERSION - 1 },
        { userId: USER_A, now: NOW },
      ),
    ).toBe(false);
  });

  it("rejects a truncated or non-object store", () => {
    expect(isRestorableEnvelope(null, { userId: USER_A, now: NOW })).toBe(false);
    expect(isRestorableEnvelope("{}", { userId: USER_A, now: NOW })).toBe(false);
    expect(
      isRestorableEnvelope(
        { ...envelope(NOW), state: { mutations: [] } },
        { userId: USER_A, now: NOW },
      ),
    ).toBe(false);
  });

  it("keeps the freshest days when the byte budget runs out", () => {
    // Eviction order is the whole point: dropping whichever entry the cache
    // enumerated last could silently evict TODAY and keep last Tuesday.
    const q = (key: unknown[], dataUpdatedAt: number) => ({
      queryKey: key,
      state: { dataUpdatedAt },
    });
    const kept = selectPersistableQueries(
      [
        q(["my-day", "2026-07-25"], NOW - 6 * 24 * HOUR),
        q(["my-day", "2026-07-31"], NOW),
        q(["my-day", "2026-07-30"], NOW - 24 * HOUR),
      ],
      { maxBytes: 20, sizeOf: () => 10 },
    );
    expect(kept.map((k) => (k.queryKey as string[])[1])).toEqual(["2026-07-31", "2026-07-30"]);
  });

  it("skips one oversized day rather than losing the smaller ones behind it", () => {
    const q = (key: unknown[], dataUpdatedAt: number, bytes: number) => ({
      queryKey: key,
      state: { dataUpdatedAt },
      bytes,
    });
    const kept = selectPersistableQueries(
      [
        q(["my-day", "huge"], NOW, 5_000),
        q(["my-day", "small"], NOW - HOUR, 10),
        q(["clients"], NOW, 10),
      ],
      { maxBytes: 100, sizeOf: (entry) => entry.bytes },
    );
    // The huge day is skipped, the small one survives, and the ineligible key
    // never enters the budget at all.
    expect(kept.map((k) => (k.queryKey as string[])[1])).toEqual(["small"]);
  });
});

describe("telling the tech the data is old", () => {
  const base = {
    hasData: true,
    isError: false,
    online: true,
    now: NOW,
    sessionStartedAt: NOW - 5_000,
  };

  it("calls a fetch from this session live", () => {
    expect(describeReadFreshness({ ...base, dataUpdatedAt: NOW - 1_000 })).toEqual({
      status: "live",
    });
  });

  it("calls a copy restored from disk cached, even with a working connection", () => {
    // The dangerous case: the app relaunched with a signal, the refetch has not
    // landed yet, and yesterday's route is on screen looking exactly like
    // today's. It is cached until a fetch actually succeeds.
    const f = describeReadFreshness({ ...base, dataUpdatedAt: NOW - 9 * HOUR });
    expect(f).toMatchObject({ status: "cached", fetchedAt: NOW - 9 * HOUR, ageMs: 9 * HOUR });
  });

  it("calls data cached when the refresh failed, even though it was fetched this session", () => {
    // Fetched at launch, then the tech drove into a dead zone and the refetch
    // failed. What is on screen is no longer known to be current.
    expect(
      describeReadFreshness({ ...base, dataUpdatedAt: NOW - 1_000, isError: true }),
    ).toMatchObject({ status: "cached" });
  });

  it("calls data cached whenever the device is offline", () => {
    expect(
      describeReadFreshness({ ...base, dataUpdatedAt: NOW - 1_000, online: false }),
    ).toMatchObject({ status: "cached" });
  });

  it("says nothing when there is no data — the caller owns that screen", () => {
    expect(describeReadFreshness({ ...base, hasData: false, dataUpdatedAt: 0 })).toBeNull();
  });

  it("escalates past the trust horizon, not before it", () => {
    // Below the horizon the banner is informational; above it, the route has
    // probably been re-sequenced and following it means wrong houses.
    const justInside = describeReadFreshness({
      ...base,
      online: false,
      dataUpdatedAt: NOW - READ_CACHE_TRUST_HORIZON_MS,
    });
    const justOutside = describeReadFreshness({
      ...base,
      online: false,
      dataUpdatedAt: NOW - READ_CACHE_TRUST_HORIZON_MS - 1,
    });
    expect(justInside).toMatchObject({ beyondTrustHorizon: false });
    expect(justOutside).toMatchObject({ beyondTrustHorizon: true });
  });

  it("rounds the age down so the copy never sounds fresher than it is", () => {
    expect(formatCacheAge(30_000)).toBe("just now");
    expect(formatCacheAge(59 * 60_000 + 59_000)).toBe("59 min ago");
    expect(formatCacheAge(HOUR)).toBe("1 hr ago");
    expect(formatCacheAge(23 * HOUR + 59 * 60_000)).toBe("23 hr ago");
    expect(formatCacheAge(25 * HOUR)).toBe("1 day ago");
    // A negative age means the device clock moved backward since the fetch.
    // This used to assert "just now" — the most reassuring thing the banner
    // could possibly say about data whose age is unknown, and the assertion
    // that made the misreport look intentional.
    expect(formatCacheAge(-5)).toBe("at an unknown time");
  });
});

describe("staying signed in when the network is gone", () => {
  it("treats a network failure as offline, not as a signed-out user", () => {
    // getUser() is a network call. Reading its failure as "not signed in" is
    // what used to redirect a tech in a dead zone to a sign-in form they had
    // no way to submit.
    expect(
      isOfflineAuthFailure({ name: "AuthRetryableFetchError", status: 0 }, { online: false }),
    ).toBe(true);
    expect(isOfflineAuthFailure(new TypeError("Failed to fetch"), { online: true })).toBe(true);
    expect(isOfflineAuthFailure({ message: "Network request failed" }, { online: true })).toBe(
      true,
    );
  });

  it("treats an answer from the auth server as a real rejection, offline flag or not", () => {
    // A revoked or invalid session must sign the user out even if the device
    // claims to be offline — otherwise "offline" becomes a way to keep a dead
    // session alive.
    expect(isOfflineAuthFailure({ status: 401, message: "invalid claim" }, { online: false })).toBe(
      false,
    );
    expect(isOfflineAuthFailure({ status: 403, message: "forbidden" }, { online: false })).toBe(
      false,
    );
  });

  it("does not invent an offline failure from an unrecognized error while online", () => {
    expect(isOfflineAuthFailure({ message: "something odd" }, { online: true })).toBe(false);
    expect(isOfflineAuthFailure(null, { online: false })).toBe(false);
  });
});

// The rules above are decisions; this block exercises the actual store, because
// the two guarantees that matter most — a second tech gets NOTHING, and an
// impersonation tab writes NOTHING — are properties of the wiring, not of a
// predicate. localStorage, window and document are faked so the module under
// test can run outside a browser.
describe("the store on a shared device", () => {
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

  const MY_DAY_KEY = ["my-day", "2026-07-31", ""];

  // `existing` models a SECOND TAB on the same device: same localStorage, its
  // own window.name. Without it there is no way to express "the impersonation
  // tab and the admin's own tab share a store", which is the whole point of the
  // guard in clearPersistedReadCaches.
  async function bootstrap(windowName: string, existing?: MemStorage) {
    vi.resetModules();
    const store = existing ?? new MemStorage();
    vi.stubGlobal("window", {
      name: windowName,
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
    return { store, readCache, QueryClient };
  }

  it("writes the route but not the client directory, and hands it back to the same user only", async () => {
    const { store, readCache, QueryClient } = await bootstrap("");

    const techA = new QueryClient();
    techA.setQueryData(MY_DAY_KEY, { visits: [{ id: "v1", gate_code: "4821" }] });
    techA.setQueryData(["clients"], [{ id: "c1", display_name: "Rivera" }]);
    readCache.ensureReadCachePersistence(techA, USER_A);

    const written = store.getItem(readCacheStorageKey(USER_A)) ?? "";
    expect(written).toContain("4821"); // the day is on the device…
    expect(written).not.toContain("Rivera"); // …the client directory is not

    // Tech B picks up the same tablet: a fresh client, same storage, and their
    // screen must stay empty rather than showing A's houses.
    const techB = new QueryClient();
    readCache.ensureReadCachePersistence(techB, USER_B);
    expect(techB.getQueryData(MY_DAY_KEY)).toBeUndefined();

    // Tech A signs back in on the same tablet and their day is still there.
    const techAAgain = new QueryClient();
    readCache.ensureReadCachePersistence(techAAgain, USER_A);
    expect(techAAgain.getQueryData(MY_DAY_KEY)).toMatchObject({
      visits: [{ id: "v1", gate_code: "4821" }],
    });
  });

  it("erases every user's store on sign-out, not just the one signing out", async () => {
    const { store, readCache, QueryClient } = await bootstrap("");
    const techA = new QueryClient();
    techA.setQueryData(MY_DAY_KEY, { visits: [{ id: "v1" }] });
    readCache.ensureReadCachePersistence(techA, USER_A);
    expect(store.length).toBeGreaterThan(0);

    readCache.clearPersistedReadCaches();
    expect(store.length).toBe(0);

    // And the offline identity pointer goes with it, so the expired-token
    // fallback can no longer resolve to the tech who just signed out.
    expect(readCache.readLastUser()).toBeNull();
  });

  it("does not let an impersonation tab wipe the admin's own cache", async () => {
    // The admin is signed in as themselves in one tab and impersonating a
    // tenant in another; both share localStorage. Ending the impersonated
    // session must not take the admin's own saved day with it — and the
    // impersonation tab never wrote a store, so it has nothing of its own to
    // clear either way.
    //
    // Found by mutation: deleting the isImpersonationTab() guard in
    // clearPersistedReadCaches left every existing test passing.
    const { store, readCache, QueryClient } = await bootstrap("");
    const admin = new QueryClient();
    admin.setQueryData(MY_DAY_KEY, { visits: [{ id: "own-day" }] });
    readCache.ensureReadCachePersistence(admin, USER_A);
    const before = store.length;
    expect(before).toBeGreaterThan(0);

    const impersonating = await bootstrap("hs-impersonation:abc", store);
    impersonating.readCache.clearPersistedReadCaches();

    expect(store.length).toBe(before);
  });

  it("writes nothing at all from an impersonation tab", async () => {
    // window.name carries the impersonation prefix (integrations/supabase/client
    // stamps it when the admin console opens the tab). A tenant's gate codes
    // must not reach the admin's own laptop.
    const { store, readCache, QueryClient } = await bootstrap("hs-impersonation:abc-123");
    const adminAsTenant = new QueryClient();
    adminAsTenant.setQueryData(MY_DAY_KEY, { visits: [{ id: "v1", gate_code: "4821" }] });
    readCache.ensureReadCachePersistence(adminAsTenant, USER_A);
    expect(store.length).toBe(0);
  });

  it("does not hand a restored day to an impersonation tab either", async () => {
    // Same device, admin's own session cached earlier, then an impersonation
    // tab opens: it must not read what the non-impersonating session wrote.
    const { store, readCache, QueryClient } = await bootstrap("");
    const own = new QueryClient();
    own.setQueryData(MY_DAY_KEY, { visits: [{ id: "v1" }] });
    readCache.ensureReadCachePersistence(own, USER_A);
    const persisted = store.getItem(readCacheStorageKey(USER_A));
    expect(persisted).toBeTruthy();

    const impersonating = await bootstrap("hs-impersonation:abc-123");
    impersonating.store.setItem(readCacheStorageKey(USER_A), persisted!);
    const tab = new impersonating.QueryClient();
    impersonating.readCache.ensureReadCachePersistence(tab, USER_A);
    expect(tab.getQueryData(MY_DAY_KEY)).toBeUndefined();
    // …and it leaves the store it found alone, rather than clearing a cache
    // that belongs to the admin's own, still-signed-in identity.
    expect(impersonating.store.getItem(readCacheStorageKey(USER_A))).toBe(persisted);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
});

// ── three ways the device could lie about how old its copy was ─────────────
//
// All three shipped in v1.7 and all three failed OPEN: the stale copy looked
// current, which is the exact outcome the freshness banner exists to prevent.

describe("a backward clock never makes stale data look fresh", () => {
  const base = {
    hasData: true,
    isError: false,
    online: false,
    sessionStartedAt: 10_000_000,
  };

  it("refuses to call a future-dated fetch 'live'", () => {
    // restoredFromDisk is `fetchedAt < sessionStartedAt`, measured against the
    // same skewed clock — so a restored copy could satisfy it and the whole
    // function returned {status:"live"}, rendering no banner at all.
    const r = describeReadFreshness({
      ...base,
      online: true,
      dataUpdatedAt: 20_000_000, // "fetched" after now
      now: 15_000_000,
    });
    expect(r?.status).toBe("cached");
  });

  it("marks an unmeasurable age as beyond the trust horizon, not within it", () => {
    const r = describeReadFreshness({ ...base, dataUpdatedAt: 20_000_000, now: 15_000_000 });
    expect(r?.status).toBe("cached");
    if (r?.status !== "cached") throw new Error("unreachable");
    expect(r.clockSuspect).toBe(true);
    // The subtraction went negative, so `> horizon` was false and the red
    // "this route may have changed" escalation never fired.
    expect(r.beyondTrustHorizon).toBe(true);
  });

  it("still reports an ordinary age normally", () => {
    const r = describeReadFreshness({ ...base, dataUpdatedAt: 9_000_000, now: 15_000_000 });
    if (r?.status !== "cached") throw new Error("unreachable");
    expect(r.clockSuspect).toBe(false);
    expect(r.ageMs).toBe(6_000_000);
  });
});

describe("a store written under a fast clock still expires", () => {
  it("refuses an envelope claiming to be from the future", () => {
    // now - savedAt goes negative, so the max-age check passed trivially and
    // the store could never be aged out.
    const envelope = {
      version: READ_CACHE_VERSION,
      userId: "u1",
      savedAt: 20_000_000,
      state: { mutations: [], queries: [] },
    };
    expect(isRestorableEnvelope(envelope, { userId: "u1", now: 15_000_000 })).toBe(false);
  });

  it("still accepts a normal, recent envelope", () => {
    const envelope = {
      version: READ_CACHE_VERSION,
      userId: "u1",
      savedAt: 14_999_000,
      state: { mutations: [], queries: [] },
    };
    expect(isRestorableEnvelope(envelope, { userId: "u1", now: 15_000_000 })).toBe(true);
  });
});
