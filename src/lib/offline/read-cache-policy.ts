// Decision logic for the offline READ cache — which server responses are
// allowed onto a device, whose device it is, and how old the copy on screen is.
//
// Writes already survive a dead zone (the IndexedDB action queue in queue.ts).
// Reads did not: every screen is fed by a server function over HTTP, so a cold
// launch with no signal gave a tech an empty app — no route, no addresses, no
// gate codes. React Query is the only layer that can answer from the last known
// response, so we persist a *narrow slice* of its cache to disk.
//
// Everything here is pure so the rules that keep one tech's day off another
// tech's screen can be tested without a browser.

/** Bump when the envelope shape changes; older envelopes are then discarded
 * instead of being fed to hydrate() as a shape it no longer understands. */
export const READ_CACHE_VERSION = 2;

/** Per-user storage keys all share this prefix so sign-out can find and delete
 * every user's store on a shared crew tablet, not just the one signing out. */
export const READ_CACHE_KEY_PREFIX = "hs:offline-reads:";

/**
 * The ONLY query keys that may be written to a device.
 *
 * This is an allowlist, not a denylist, because the failure mode of getting it
 * wrong is a data breach on a lost phone rather than a missing feature:
 * reports, the client directory, invoices, payouts and every platform-admin
 * screen must never land in device storage. A tech in the field needs their
 * route and the property details attached to it, and nothing else.
 *
 *  - "my-day"         the day's visits: addresses, gate/lockbox codes, access
 *                     and hazard notes, dog temperament — the whole reason the
 *                     app is opened at a customer's fence.
 *  - "my-org"         role + organization. Without it the shell can't decide
 *                     what to render and RoleGuard bounces the tech off the
 *                     route before they see anything.
 *  - "visit-stations" waste stations for a visit, shown inside the visit card.
 *
 * Deliberately NOT here: "addon-services" (a price list feeding a charge the
 * tech cannot create offline anyway), anything under clients/invoices/reports.
 */
export const PERSISTABLE_QUERY_ROOTS = ["my-day", "my-org", "visit-stations"] as const;

/** A store older than this is deleted on read rather than shown. A route is a
 * plan for one day; three days later it is not a stale answer, it is a wrong
 * one, and a device that has been in a drawer must not present it at all. */
export const READ_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Past this the banner stops saying "saved copy" and starts warning. Half a
 * day is the point where a route has almost certainly been re-sequenced by the
 * office and driving off it sends the tech to the wrong houses. */
export const READ_CACHE_TRUST_HORIZON_MS = 12 * 60 * 60 * 1000;

/** Serialized ceiling for one user's store. localStorage gives ~5MB for the
 * whole origin and Supabase's session lives there too; blowing the quota would
 * take the auth session down with it, so the cache stays small on purpose. */
export const READ_CACHE_MAX_BYTES = 512_000;

export interface ReadCacheEnvelope {
  version: number;
  /** Whose data this is. Checked on read — never trusted from the key alone. */
  userId: string;
  savedAt: number;
  state: { mutations: unknown[]; queries: unknown[] };
}

/**
 * True when this query's response may be written to disk.
 *
 * Matches on the FIRST key segment only. Query keys in this app are
 * `["my-day", day, staffId]`, `["visit-stations", visitId]` and so on, so the
 * root is what identifies the data; matching anywhere in the key would let
 * an unrelated query smuggle itself in by carrying "my-day" as an argument.
 */
export function isPersistableQueryKey(queryKey: unknown): boolean {
  if (!Array.isArray(queryKey) || queryKey.length === 0) return false;
  const root = queryKey[0];
  if (typeof root !== "string") return false;
  return (PERSISTABLE_QUERY_ROOTS as readonly string[]).includes(root);
}

/**
 * Storage key for one user's store.
 *
 * A shared crew tablet is the normal case here, not an edge case: two techs
 * sign into the same iPad on the same morning. Keying by user id is what stops
 * the second one from opening the first one's route.
 */
export function readCacheStorageKey(userId: string): string {
  return `${READ_CACHE_KEY_PREFIX}v${READ_CACHE_VERSION}:user:${userId}`;
}

/** Pointer to the last user who authenticated on this device. Read only when
 * the network is gone and Supabase can no longer tell us who is signed in. */
export const LAST_USER_KEY = `${READ_CACHE_KEY_PREFIX}last-user`;

/**
 * Whether this session may persist reads at all.
 *
 * An impersonation tab is the case that matters: a platform admin acting as a
 * tenant sees that tenant's real customer addresses and gate codes, and writing
 * those to the admin's own laptop is a customer-data leak that outlives the
 * impersonation window by however long the laptop exists. Impersonation is
 * detected structurally (window.name prefix, see integrations/supabase/client)
 * — the same signal that already routes the impersonated auth session to
 * sessionStorage — so it is known before any query resolves.
 */
export function shouldPersistReads(args: {
  userId: string | null | undefined;
  impersonating: boolean;
}): boolean {
  if (args.impersonating) return false;
  return typeof args.userId === "string" && args.userId.length > 0;
}

interface PersistableQuery {
  queryKey: unknown;
  state?: { dataUpdatedAt?: number } | null;
}

/**
 * Filter a dehydrated query list down to what may be stored, newest first,
 * stopping at the byte budget.
 *
 * Sorting by dataUpdatedAt before the budget check means the entries that get
 * dropped when a device has accumulated many days are the OLDEST ones — the
 * days a tech is least likely to open — rather than whichever the cache
 * happened to enumerate last, which would have silently evicted today.
 */
export function selectPersistableQueries<T extends PersistableQuery>(
  queries: readonly T[],
  opts: { maxBytes?: number; sizeOf?: (query: T) => number } = {},
): T[] {
  const maxBytes = opts.maxBytes ?? READ_CACHE_MAX_BYTES;
  const sizeOf = opts.sizeOf ?? ((q: T) => JSON.stringify(q)?.length ?? 0);

  const eligible = queries
    .filter((q) => isPersistableQueryKey(q.queryKey))
    .sort((a, b) => (b.state?.dataUpdatedAt ?? 0) - (a.state?.dataUpdatedAt ?? 0));

  const kept: T[] = [];
  let used = 0;
  for (const query of eligible) {
    const bytes = sizeOf(query);
    // One oversized entry (a day with a very large payload) is skipped rather
    // than allowed to end the loop — the smaller days after it are still worth
    // keeping, and a tech with one huge day should not lose the rest.
    if (used + bytes > maxBytes) continue;
    kept.push(query);
    used += bytes;
  }
  return kept;
}

/**
 * Whether a stored envelope may be hydrated into the query cache.
 *
 * The user-id check is the load-bearing one. The storage key already contains
 * the user id, but keys are strings in a shared namespace: re-checking the id
 * recorded INSIDE the envelope means a corrupted, hand-edited or
 * previous-version key can never resolve to another user's day.
 */
export function isRestorableEnvelope(
  envelope: unknown,
  args: { userId: string; now: number; maxAgeMs?: number },
): envelope is ReadCacheEnvelope {
  const maxAgeMs = args.maxAgeMs ?? READ_CACHE_MAX_AGE_MS;
  if (!envelope || typeof envelope !== "object") return false;
  const e = envelope as Partial<ReadCacheEnvelope>;
  if (e.version !== READ_CACHE_VERSION) return false;
  if (typeof e.userId !== "string" || e.userId !== args.userId) return false;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return false;
  // A savedAt in the FUTURE is a clock change or a tampered store. The
  // subtraction goes negative and the age check passes trivially, so a store
  // written under a fast clock could never be aged out. Refuse it instead —
  // an unmeasurable age is not a young one.
  if (e.savedAt > args.now) return false;
  if (args.now - e.savedAt > maxAgeMs) return false;
  if (!e.state || typeof e.state !== "object" || !Array.isArray(e.state.queries)) return false;
  return true;
}

export type ReadFreshness =
  | { status: "live" }
  | {
      status: "cached";
      fetchedAt: number;
      ageMs: number;
      beyondTrustHorizon: boolean;
      /** The data claims to have been fetched in the FUTURE, so its age cannot
       *  be computed. Never treated as fresh — see describeReadFreshness. */
      clockSuspect: boolean;
    };

/**
 * What the my-day header must say about the data currently on screen.
 *
 * A tech looking at yesterday's route with no indication is worse off than a
 * tech looking at an error: they will drive the wrong houses and believe they
 * are done. So anything that is not a successful fetch from THIS app session
 * is labelled as a saved copy with the time it was fetched.
 *
 * `sessionStartedAt` is what separates "this data was just fetched" from "this
 * data came off the disk on launch": a restored entry keeps its original
 * dataUpdatedAt, so it is necessarily older than the moment the app started.
 */
export function describeReadFreshness(input: {
  hasData: boolean;
  dataUpdatedAt: number;
  isError: boolean;
  online: boolean;
  /**
   * The current time. OPTIONAL, and callers should leave it out.
   *
   * QA-P1: my-day passed a `Date.now()` it had stored in state and refreshed
   * on a 60-second interval, so between ticks it was up to a minute BEHIND.
   * Every comparison below is a subtraction against this value, and a `now`
   * that trails `dataUpdatedAt` produces a negative age — which is exactly
   * what `clockSuspect` exists to detect. So the escalated "this route may
   * have changed" warning fired against correct, live, just-fetched data for
   * the first minute of every load.
   *
   * The guard was right. The input was wrong, and nothing in a signature that
   * merely REQUIRED a number could have said so. Defaulting it means a caller
   * has to pass a stale clock deliberately rather than by writing the obvious
   * thing, and the only callers that pass it now are tests.
   */
  now?: number;
  sessionStartedAt: number;
  trustHorizonMs?: number;
}): ReadFreshness | null {
  // No data at all is not a staleness question — the caller owns that screen.
  if (!input.hasData) return null;

  const now = input.now ?? Date.now();
  const fetchedAt = Number.isFinite(input.dataUpdatedAt) ? input.dataUpdatedAt : 0;
  const refreshFailed = input.isError;

  // ── a backward clock step used to make stale data read as current ────────
  //
  // Every comparison here is a subtraction against the device clock, and all of
  // them failed OPEN when that clock moved backward — an Android tablet with a
  // dead RTC booting to a wrong date then NTP-correcting, or someone fixing the
  // date by hand:
  //
  //   * ageMs was Math.max(0, now - fetchedAt), so a three-day-old route
  //     rendered as "saved just now";
  //   * beyondTrustHorizon went negative, so the red "this route may have
  //     changed" escalation never fired;
  //   * restoredFromDisk (fetchedAt < sessionStartedAt) went false against the
  //     same skewed clock, so the whole thing returned "live" and NO banner
  //     rendered at all.
  //
  // A negative age is not a small age; it is an unmeasurable one. It is now the
  // most suspicious state, not the least.
  const rawAgeMs = now - fetchedAt;
  const clockSuspect = rawAgeMs < 0;
  const restoredFromDisk = fetchedAt < input.sessionStartedAt;

  // Online, refreshed successfully in this session: nothing to warn about.
  if (input.online && !refreshFailed && !restoredFromDisk && !clockSuspect) {
    return { status: "live" };
  }

  return {
    status: "cached",
    fetchedAt,
    ageMs: Math.max(0, rawAgeMs),
    beyondTrustHorizon:
      clockSuspect || rawAgeMs > (input.trustHorizonMs ?? READ_CACHE_TRUST_HORIZON_MS),
    clockSuspect,
  };
}

/** Compact age for the banner. Rounds DOWN so the copy never claims the data is
 * fresher than it is (59 minutes reads as "59 min", never "1 hour"). */
export function formatCacheAge(ageMs: number): string {
  // A negative age means the device clock moved backward since the fetch. It
  // used to clamp to 0 and print "just now" — the most reassuring thing it
  // could possibly say about data whose age is unknown.
  if (ageMs < 0) return "at an unknown time";
  const ms = Math.max(0, ageMs);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

/**
 * Whether a failed auth call means "the network is gone" rather than "this
 * session is no longer valid".
 *
 * getUser() is a network call. Offline it fails, and the old code read any
 * failure as "not signed in" and redirected to /auth — which is exactly the
 * screen a tech in a dead zone can do nothing with. Getting this wrong in the
 * other direction is worse, so a response that actually came back from the auth
 * server (any 4xx) is always treated as a real rejection.
 */
export function isOfflineAuthFailure(error: unknown, args: { online: boolean }): boolean {
  if (!error) return false;
  const err = error as { status?: unknown; name?: unknown; message?: unknown };

  if (typeof err.status === "number" && err.status >= 400) return false;
  if (err.name === "AuthRetryableFetchError") return true;

  const message = typeof err.message === "string" ? err.message : "";
  if (/failed to fetch|networkerror|network request failed|load failed|timeout/i.test(message)) {
    return true;
  }
  // Unrecognized error shape: only the device's own offline signal can justify
  // keeping the user signed in, and it has to actually say offline.
  return !args.online;
}
