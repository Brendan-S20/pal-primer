// What the read cache keeps when a refresh FAILS.
//
// ── A FAILED REFRESH USED TO DELETE THE DAY FROM THE PHONE ──────────────────
//
// read-cache.ts wrote only queries whose status was "success". A refetch that
// fails does not throw the data away: React Query keeps `data` and flips the
// query's status to "error". So the sequence a tech produces every time they
// lose signal with My Day open —
//
//   1. the day loads (success, persisted)
//   2. signal goes; something refetches (window focus, a pull, Retry) and it
//      fails — status "error", data still on screen
//   3. the next persist (the 1s throttle, or pagehide) skips the day, finds
//      nothing else to write, and REMOVES the store
//   4. the app is reopened, still offline: "Couldn't load this day, and no
//      synced copy is saved on this device."
//
// — deleted the one copy that existed precisely for step 4. A tester reproduced
// it by loading My Day, turning the network off in DevTools and reloading:
// returning focus from DevTools was the refetch in step 2.
//
// The rules below: a query that HAS data keeps it on the device through a
// failed refresh, written as the success it last was (an error object would
// otherwise come back on the next launch looking like a fresh failure); and a
// query that failed with NO data in memory leaves the copy already on disk
// alone instead of overwriting it with nothing. Neither rule touches the age
// or ownership limits in read-cache-policy.ts: the copy keeps the time it was
// actually FETCHED, so it ages out on exactly the schedule it always did.

import {
  isPersistableQueryKey,
  isRestorableEnvelope,
  READ_CACHE_MAX_AGE_MS,
} from "./read-cache-policy";

interface QueryStateLike {
  status?: unknown;
  data?: unknown;
  dataUpdatedAt?: unknown;
}

function fetchedWithin(state: QueryStateLike, now: number, maxAgeMs: number): boolean {
  const at = state.dataUpdatedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return false;
  // A fetch time in the future is an unmeasurable age, not a young one — the
  // same reasoning as isRestorableEnvelope's guard against a fast clock.
  if (at > now) return false;
  return now - at <= maxAgeMs;
}

/**
 * Whether a query's state holds a copy worth writing to the device.
 *
 * "success" is what it always was. "error" WITH data is a refresh that failed
 * on top of a good copy, and that copy is kept — for as long as the store's own
 * max age would keep it, and not a moment longer.
 */
export function hasLastGoodCopy(
  state: QueryStateLike | null | undefined,
  args: { now: number; maxAgeMs?: number },
): boolean {
  if (!state) return false;
  if (state.status === "success") return true;
  if (state.status !== "error" || state.data === undefined) return false;
  return fetchedWithin(state, args.now, args.maxAgeMs ?? READ_CACHE_MAX_AGE_MS);
}

/**
 * The dehydrated entry as it stood after its last SUCCESSFUL fetch.
 *
 * `dataUpdatedAt` is left exactly as it was: it is when the data was fetched,
 * it is what the envelope's `savedAt` is computed from, and it is what My Day's
 * "saved copy, 4 hr ago" banner reads. Only the failure is taken off.
 */
export function asLastGoodCopy<T extends { state?: unknown }>(query: T): T {
  const state = query.state as Record<string, unknown> | undefined;
  if (!state || state.status !== "error") return query;
  return {
    ...query,
    state: {
      ...state,
      status: "success",
      fetchStatus: "idle",
      error: null,
      fetchFailureCount: 0,
      fetchFailureReason: null,
    },
  };
}

interface StoredQuery {
  queryKey?: unknown;
  queryHash?: unknown;
  state?: QueryStateLike | null;
}

/**
 * Entries from the store already on disk that a write must not drop.
 *
 * `failedHashes` are persistable queries that are in "error" with NO data in
 * memory. Writing the cache as it stands would replace their saved copy with
 * nothing, because of a refresh that failed. Each one is carried over from the
 * previous envelope instead — only if that envelope is still restorable for
 * this user (version, owner, max age) and the entry itself is within the max
 * age, so nothing outlives the limits it was stored under.
 */
export function savedCopiesToKeep(
  previous: unknown,
  args: { userId: string; now: number; failedHashes: ReadonlySet<string>; maxAgeMs?: number },
): StoredQuery[] {
  if (args.failedHashes.size === 0) return [];
  const maxAgeMs = args.maxAgeMs ?? READ_CACHE_MAX_AGE_MS;
  if (!isRestorableEnvelope(previous, { userId: args.userId, now: args.now, maxAgeMs })) return [];
  return (previous.state.queries as StoredQuery[]).filter(
    (q) =>
      !!q &&
      typeof q.queryHash === "string" &&
      args.failedHashes.has(q.queryHash) &&
      isPersistableQueryKey(q.queryKey) &&
      !!q.state &&
      q.state.status === "success" &&
      q.state.data !== undefined &&
      fetchedWithin(q.state, args.now, maxAgeMs),
  );
}
