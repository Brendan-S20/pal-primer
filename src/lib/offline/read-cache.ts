// Device-side persistence for the narrow slice of React Query the field app
// needs offline. The rules live in read-cache-policy.ts; this file is the
// browser wiring — localStorage, the cache subscription, and teardown.
//
// Why hand-rolled rather than @tanstack/react-query-persist-client: the two
// hard requirements here are per-user isolation on a shared crew tablet and a
// hard "never during impersonation" switch. Both are decisions about WHO is
// asking, which that package leaves to the caller anyway, and it is not a
// dependency of this repo.

import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { isImpersonationTab, supabase } from "@/integrations/supabase/client";
import {
  isPersistableQueryKey,
  isLandingPath,
  isRestorableEnvelope,
  LAST_LANDING_KEY,
  LAST_USER_KEY,
  PERSISTABLE_QUERY_ROOTS,
  READ_CACHE_KEY_PREFIX,
  READ_CACHE_MAX_AGE_MS,
  READ_CACHE_MAX_BYTES,
  READ_CACHE_VERSION,
  readCacheStorageKey,
  selectPersistableQueries,
  shouldPersistReads,
  type ReadCacheEnvelope,
} from "./read-cache-policy";
import { asLastGoodCopy, hasLastGoodCopy, savedCopiesToKeep } from "./last-good-copy";
import { clearAllFormDrafts } from "@/lib/form-drafts";

/** Coalesces the burst of cache events a single page load produces into one
 * write. localStorage writes are synchronous and block the UI thread, which on
 * a mid-range Android phone is visible as jank while scrolling a route. */
const WRITE_THROTTLE_MS = 1_000;

let activeUserId: string | null = null;
let unsubscribeCache: (() => void) | null = null;
let unsubscribeAuth: (() => void) | null = null;
let removeFlushListeners: (() => void) | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private-mode Safari and locked-down WebViews throw on access. The cache
    // is an optimization; losing it must never take the app down with it.
    return null;
  }
}

/** The last user who authenticated on this device. Read ONLY when the network
 * is gone and Supabase can no longer answer who is signed in — see
 * resolveOfflineUserId. Cleared by sign-out along with the stores themselves. */
export function rememberLastUser(userId: string): void {
  try {
    storage()?.setItem(LAST_USER_KEY, userId);
  } catch {
    /* quota or blocked storage — nothing here is worth failing a boot over */
  }
}

export function readLastUser(): string | null {
  try {
    return storage()?.getItem(LAST_USER_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Where this device's last verified sign-in landed. Written whenever the
 * landing path is successfully resolved, read only when it cannot be — see
 * LAST_LANDING_KEY for why a tech's /my-day must not silently become
 * /dashboard the first time they open the app without signal. */
export function rememberLandingPath(path: string): void {
  if (!isLandingPath(path)) return;
  try {
    storage()?.setItem(LAST_LANDING_KEY, path);
  } catch {
    /* quota or blocked storage — nothing here is worth failing a boot over */
  }
}

export function readLandingPath(): string | null {
  try {
    const v = storage()?.getItem(LAST_LANDING_KEY);
    // Validated on the way out, not just on the way in: this ends up in a
    // navigate() call, and device storage is shared with anything else running
    // on this origin.
    return isLandingPath(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * Delete every persisted read store on this device, for every user.
 *
 * Sign-out has to destroy the cache, not just the session: on a shared crew
 * tablet the next person to pick it up is a different tech, and "signed out"
 * has to mean the previous tech's addresses and gate codes are gone. Deleting
 * by prefix (rather than only the current user's key) also cleans up stores
 * left by an earlier app version or an interrupted sign-out.
 */
export function clearPersistedReadCaches(): void {
  // An impersonation tab never wrote a store, and it shares localStorage with
  // the admin's own tabs — clearing here would wipe a cache that belongs to a
  // different, still-signed-in identity.
  if (isImpersonationTab()) return;
  const store = storage();
  if (!store) return;
  stopPersistence();
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(READ_CACHE_KEY_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) store.removeItem(key);
  } catch {
    /* best effort */
  }
}

/** Half-typed office forms (lib/form-drafts.ts, gaps-r2-12), every one on the
 *  device, so the next person to sign in never sees them. Not from an
 *  impersonation tab, for the reason clearPersistedReadCaches gives: it
 *  shares localStorage with the admin's own, still signed-in, tabs. */
function clearFormDraftsOnSignOut(): void {
  if (isImpersonationTab()) return;
  clearAllFormDrafts();
}

function stopPersistence(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  unsubscribeCache?.();
  unsubscribeCache = null;
  removeFlushListeners?.();
  removeFlushListeners = null;
  activeUserId = null;
}

/**
 * Keep every allowlisted read in MEMORY for as long as the device may keep it
 * on DISK.
 *
 * ── THE DAY LEFT THE PHONE FIVE MINUTES AFTER THE TECH LEFT MY DAY ─────────
 *
 * React Query removes a query from the cache `gcTime` after its last observer
 * goes away, and the default is five minutes. The writer below dehydrates
 * what is in the cache, so the sequence
 *
 *   1. My Day loads the day (persisted);
 *   2. the tech opens Waste log, Alerts or Preferences: no observer left;
 *   3. five minutes later the day is garbage-collected, and the cache's
 *      "removed" event schedules a write;
 *   4. that write finds no day and removes it from the device
 *
 * took the day off the phone in a dead zone without anything failing. A
 * restored copy on a cold offline launch went the same way if the tech
 * opened any other page first.
 *
 * Two fixes were possible: hold these queries in memory for the max age, or
 * teach the writer to carry an allowlisted key that has left memory over from
 * the old store. This is the first, because it is one rule in one place and
 * adds no new path: the writer still writes exactly what is in the cache, so
 * the per-user store, the impersonation switch and the sign-out clear cannot
 * be routed around by a carried-over copy. The second would need the old
 * store read on every write and a second carry-over rule beside
 * savedCopiesToKeep (last-good-copy.ts), each of which the writer has to get
 * right. Holding the query also leaves the day on screen when the tech comes
 * back to My Day, rather than on disk only.
 *
 * `setQueryDefaults` matches by key prefix, so ["my-day", day, staff] and
 * ["visit-stations", id] are covered, and it applies to queries `hydrate`
 * builds from the store too. The cost is memory for a few days' responses at
 * most, inside the same 512 KB budget the store is held to. Age is still
 * enforced where it always was: the writer drops a copy past the max age
 * (hasLastGoodCopy) and restore refuses an old store.
 */
export function holdPersistedReadsInMemory(queryClient: QueryClient): void {
  for (const root of PERSISTABLE_QUERY_ROOTS) {
    queryClient.setQueryDefaults([root], { gcTime: READ_CACHE_MAX_AGE_MS });
  }
}

function restore(queryClient: QueryClient, userId: string): void {
  const store = storage();
  if (!store) return;
  const key = readCacheStorageKey(userId);
  let raw: string | null = null;
  try {
    raw = store.getItem(key);
  } catch {
    return;
  }
  if (!raw) return;

  // Size sanity check before parsing: a store that has somehow grown past the
  // budget is corrupt or hostile, and JSON.parse on multiple megabytes is a
  // visible freeze on launch — the one moment the app must feel instant.
  if (raw.length > READ_CACHE_MAX_BYTES * 2) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(raw);
  } catch {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }

  if (!isRestorableEnvelope(envelope, { userId, now: Date.now() })) {
    // Wrong user, wrong version, or older than the max age. Deleting rather
    // than ignoring means a device that has sat in a drawer for a week comes
    // back with nothing to show instead of last week's route.
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }

  hydrate(queryClient, envelope.state);
}

function writeNow(queryClient: QueryClient, userId: string): void {
  const store = storage();
  if (!store) return;
  const key = readCacheStorageKey(userId);

  const now = Date.now();
  const dehydrated = dehydrate(queryClient, {
    // Pending queries stay out, and so does an error with nothing behind it.
    // An error WITH data — a refresh that failed on top of a good copy — is
    // kept, written back as the success it last was (see last-good-copy.ts:
    // writing only "success" here is what deleted the day from the phone the
    // first time a refetch failed offline).
    shouldDehydrateQuery: (query) =>
      isPersistableQueryKey(query.queryKey) && hasLastGoodCopy(query.state, { now }),
  });
  const candidates: unknown[] = dehydrated.queries.map(asLastGoodCopy);

  // A persistable query that failed with NO data in memory must not overwrite
  // the copy already on disk with nothing. Only read the old store when there
  // is such a query: on the ordinary path this costs nothing.
  const failedHashes = new Set(
    queryClient
      .getQueryCache()
      .getAll()
      .filter(
        (q) =>
          isPersistableQueryKey(q.queryKey) &&
          q.state.status === "error" &&
          q.state.data === undefined,
      )
      .map((q) => q.queryHash),
  );
  if (failedHashes.size > 0) {
    try {
      const raw = store.getItem(key);
      if (raw && raw.length <= READ_CACHE_MAX_BYTES * 2) {
        candidates.push(...savedCopiesToKeep(JSON.parse(raw), { userId, now, failedHashes }));
      }
    } catch {
      /* unreadable old store — nothing in it to keep */
    }
  }

  // Reserve room for the envelope around the queries: budgeting the queries at
  // the full ceiling could push the serialized whole just over it, and the
  // guard below would then refuse every write from then on — a cache that
  // silently stops updating while still looking populated.
  const queries = selectPersistableQueries(candidates as { queryKey: unknown }[], {
    maxBytes: READ_CACHE_MAX_BYTES - 2_048,
  });
  if (queries.length === 0) {
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
    return;
  }

  // ── savedAt is when the DATA was fetched, not when this file was written ──
  //
  // It used to be Date.now(). Restoring a store immediately re-persists it
  // (ensureReadCachePersistence: restore() then writeNow()), so every launch
  // re-stamped savedAt — and a device that is OPENED never aged. The 3-day
  // maximum measured "time since the app was last opened", which for a tech who
  // opens it every morning in a dead zone is always ~0, so the branch that
  // deletes a stale store was unreachable. The documented guarantee — a device
  // that has sat in a drawer comes back with nothing to show — held only for a
  // device nobody touched.
  //
  // The newest dataUpdatedAt across the persisted queries is the real answer:
  // it survives a restore-and-rewrite unchanged, because hydrate() carries it,
  // so age now advances even while the app is used offline.
  const newestFetch = queries.reduce((max, q) => {
    const at = (q as { state?: { dataUpdatedAt?: number } }).state?.dataUpdatedAt;
    return typeof at === "number" && Number.isFinite(at) && at > max ? at : max;
  }, 0);

  const envelope: ReadCacheEnvelope = {
    version: READ_CACHE_VERSION,
    userId,
    // Fall back to now only if nothing carried a fetch time — a store with no
    // measurable age should expire on schedule, not live for ever.
    savedAt: newestFetch > 0 ? newestFetch : Date.now(),
    state: { mutations: [], queries },
  };

  let raw: string;
  try {
    raw = JSON.stringify(envelope);
  } catch {
    return; // non-serializable payload — skip rather than corrupt the store
  }
  if (raw.length > READ_CACHE_MAX_BYTES) return;

  try {
    store.setItem(key, raw);
  } catch {
    // Quota exceeded. Drop our own store rather than leaving a half-written
    // one behind, and above all leave the Supabase auth session — which lives
    // in the same localStorage — untouched.
    try {
      store.removeItem(key);
    } catch {
      /* ignore */
    }
  }
}

function scheduleWrite(queryClient: QueryClient, userId: string): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (activeUserId !== userId) return;
    writeNow(queryClient, userId);
  }, WRITE_THROTTLE_MS);
}

/**
 * Restore this user's persisted reads into the query cache and keep writing
 * them back as they change. Idempotent: safe to call on every route load.
 *
 * Call this BEFORE anything reads the cache (route beforeLoad), otherwise a
 * cold offline launch renders its empty state before the disk copy arrives.
 */
export function ensureReadCachePersistence(
  queryClient: QueryClient,
  userId: string | null | undefined,
): void {
  if (typeof window === "undefined") return;

  if (!shouldPersistReads({ userId, impersonating: isImpersonationTab() })) {
    stopPersistence();
    return;
  }
  const uid = userId as string;
  if (activeUserId === uid) return;

  if (activeUserId && activeUserId !== uid) {
    // A different user is now signed in on this device without a reload. Drop
    // the in-memory cache too: the persisted store is per-user, but the live
    // QueryClient still holds the previous tech's visits and would serve them
    // straight to the new one.
    stopPersistence();
    queryClient.clear();
  }

  activeUserId = uid;
  rememberLastUser(uid);
  // Before restore, so the queries hydrate() builds get the long gcTime too.
  holdPersistedReadsInMemory(queryClient);
  restore(queryClient, uid);
  writeNow(queryClient, uid);

  unsubscribeCache = queryClient.getQueryCache().subscribe(() => {
    if (activeUserId !== uid) return;
    scheduleWrite(queryClient, uid);
  });

  // A phone going into a pocket mid-route is the moment we most want the last
  // fetch on disk, and it is exactly when a throttled write would be lost.
  const flush = () => {
    if (document.visibilityState === "hidden" && activeUserId === uid) {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
      }
      writeNow(queryClient, uid);
    }
  };
  document.addEventListener("visibilitychange", flush);
  window.addEventListener("pagehide", flush);
  removeFlushListeners = () => {
    document.removeEventListener("visibilitychange", flush);
    window.removeEventListener("pagehide", flush);
  };

  if (!unsubscribeAuth) {
    // Backstop for sign-out paths that don't go through signOutAndClearDevice
    // (a session revoked from another tab, or a future call site that forgets).
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
        // Same ordering as signOutAndClearDevice, and the same reason: once
        // LAST_USER_KEY is gone the queue can never be attributed or cleared.
        // This backstop covers sign-outs that never reach our own helper — a
        // session revoked from another tab, or a call site that forgets.
        void (async () => {
          try {
            const { resolveOfflineUserId } = await import("@/lib/offline/action-owner");
            const { clearQueueForUser } = await import("@/lib/offline/queue");
            await clearQueueForUser(await resolveOfflineUserId());
          } catch {
            /* nothing resolvable, nothing to clear */
          } finally {
            clearPersistedReadCaches();
            clearFormDraftsOnSignOut();
          }
        })();
      }
    });
    unsubscribeAuth = () => data.subscription.unsubscribe();
  }
}

/**
 * The only sign-out the staff app should call.
 *
 * Signing out has to destroy the persisted day, not just the session —
 * otherwise the next tech to unlock the shared tablet is one failed fetch away
 * from seeing the previous tech's route. Clearing happens FIRST so a signOut
 * that hangs on a bad connection still leaves the device clean.
 */
export async function signOutAndClearDevice(): Promise<void> {
  // ORDER MATTERS, and it used to be wrong in a way nothing could recover from.
  //
  // `clearPersistedReadCaches` also drops LAST_USER_KEY — it shares the prefix
  // — which is the ONLY way to resolve who owns the queued actions in
  // IndexedDB once the session is gone. So clearing the read cache first and
  // the queue never left a tech's actions AND their photo blobs on the device
  // with nothing able to name their owner again: `clearQueueForUser` needs a
  // user id, `usePendingCount` reports 0, and the rows are invisible and
  // permanent. Pictures of customers' back yards, on a shared crew tablet, for
  // ever.
  //
  // So the queue goes first, while the identity is still resolvable.
  //
  // This is the LAST-RESORT sweep. The staff surfaces call
  // `flushThenClearAndSignOut`, which tries to sync before discarding and asks
  // first. This path — platform/admin/no-workspace sign-out, a revoked session,
  // an impersonation exit — has no callers to replay with and no one to ask, so
  // it drops the queue silently rather than leaving it unreachable. Losing an
  // unsyncable queue is bad; leaving customer photos on a device nobody can
  // clear is worse, and it is the one this used to do.
  try {
    const { resolveOfflineUserId } = await import("@/lib/offline/action-owner");
    const { clearQueueForUser } = await import("@/lib/offline/queue");
    await clearQueueForUser(await resolveOfflineUserId());
  } catch {
    /* no identity resolvable means no queue of ours to clear */
  }
  clearPersistedReadCaches();
  clearFormDraftsOnSignOut();
  // A sign-out on purpose ends the last sign-in, and whatever page was held
  // to return to (#785). Without this a sign-out within a minute of signing
  // in was reported on the next /auth as "your password was accepted, but we
  // couldn't finish signing you in", and a page held for the person who just
  // left was where the next person landed.
  try {
    const { signInLanded } = await import("@/lib/sign-in-handoff");
    const { forgetDeepLink } = await import("@/lib/pending-deep-link");
    signInLanded();
    forgetDeepLink();
  } catch {
    /* never let this hold up a sign-out */
  }
  // Before signOut, while the session can still authenticate the delete: this
  // device stops receiving the signed-out user's push notifications. Bounded
  // inside releasePushRegistration, and a no-op on the web.
  try {
    const { releasePushRegistration } = await import("@/lib/native");
    await releasePushRegistration();
  } catch {
    /* never let push bookkeeping hold up a sign-out */
  }
  // The route on the iPhone lock screen is the signed-out person's, and its
  // Start button holds an action token that would go on starting their stops
  // for the rest of the day. End it, forget the token on this phone, and
  // revoke it on the server while the session can still say whose it is.
  // Bounded, like the push release above; a no-op off iOS.
  try {
    const la = await import("@/lib/live-activity");
    if (la.liveActivityAvailable()) {
      const ids = await la.endRouteActivity(undefined, "immediate");
      await la.clearRouteActionToken();
      const { endLiveActivityToken } = await import("@/lib/live-activity.functions");
      await Promise.race([
        Promise.all(
          ids.map((activityId) =>
            endLiveActivityToken({ data: { activityId, reason: "signed_out" } }).catch(() => {}),
          ),
        ),
        new Promise((r) => setTimeout(r, 3_000)),
      ]);
    }
  } catch {
    /* never let the lock screen hold up a sign-out */
  }
  await supabase.auth.signOut();
}
