// A banner the person can put away, and the rule for when it comes back.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// Owner, 2026-10-03: "there's in-app notifications that are not able to be
// cleared away on certain screens, and it would be nice to dismiss or hide
// them if they are not necessary." The trial notice sat on every page, the
// texting-consent count sat on /clients, and neither had any way to go. A
// notice you have read and cannot move is furniture, and furniture is not
// read on the day it changes.
//
// ── THE RULE, IN ONE PLACE ────────────────────────────────────────────────
//
// A dismissal is remembered per PERSON, per BUSINESS, per BANNER, against a
// VERSION the banner supplies. It stays dismissed until either:
//
//   1. the version changes, because the thing the banner is about changed
//      (the count of clients without texting consent moved, the trial went
//      from "8 days left" to "3 days left", a payment went from failing to
//      canceled). A version is a fingerprint of the facts, not of the copy;
//   2. the snooze runs out, for the banners that pass one (a billing nag comes
//      back after a week even if nothing changed, because "you have not paid"
//      is a fact that gets more urgent by standing still).
//
// Each call site states its own version and snooze in a comment beside it.
// Safety-critical notices (a stop's hazards, impersonation, "you are offline")
// do not use this at all; they are not the kind of thing that should go away.
//
// ── WHY localStorage, AND WHY EVERY TOUCH OF IT IS GUARDED ─────────────────
//
// A dismissal is a convenience for this device. Losing it costs one more look
// at a notice, so it does not earn a table, a migration and a round trip.
// Private-mode Safari and locked-down WebViews throw on ACCESS to
// localStorage, not only on write, so every read and write below is inside a
// try. When storage is unavailable the dismissal still works for the rest of
// the session, from memory, rather than the X doing nothing.
//
// NOT under the read cache's prefix (`hs:offline-reads:`), which is swept on
// sign-out: signing out and back in should not bring back everything you put
// away. The value is a version string and a timestamp against opaque ids.

import { useCallback, useSyncExternalStore } from "react";
import { LAST_USER_KEY } from "@/lib/offline/read-cache-policy";

export const DISMISS_KEY_PREFIX = "hs:dismissed:";
/** Fired on this tab when a dismissal is written; `storage` covers the others. */
export const DISMISS_EVENT = "hs:dismissed-change";
export const DAY_MS = 24 * 60 * 60 * 1000;

export type DismissRecord = { v: string; at: number };

/** Writes that storage refused, so the X still works for this session. */
const memory = new Map<string, string>();

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Who is signed in on this device, read synchronously. The same pointer the
 *  header preferences use; null before the first verified sign-in. */
function currentUserId(): string | null {
  try {
    return storage()?.getItem(LAST_USER_KEY) ?? null;
  } catch {
    return null;
  }
}

export function dismissKey(userId: string | null, orgId: string | null, banner: string): string {
  return `${DISMISS_KEY_PREFIX}${userId ?? "anon"}:${orgId ?? "no-org"}:${banner}`;
}

/** The raw stored value for a key: memory first (a write storage refused),
 *  then storage. "" when there is none or storage cannot be read. */
export function readRaw(key: string, store: Storage | null = storage()): string {
  const mem = memory.get(key);
  if (mem !== undefined) return mem;
  try {
    return store?.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/**
 * Is a banner with this version dismissed, given what was stored?
 *
 * Pure, so the rule is a table a test can read: no record, a malformed one,
 * a different version, or a snooze that has run out all mean SHOW.
 */
export function isDismissed(
  raw: string,
  version: string | null,
  snoozeDays: number | undefined,
  now: number,
): boolean {
  if (version === null || !raw) return false;
  let rec: DismissRecord;
  try {
    rec = JSON.parse(raw) as DismissRecord;
  } catch {
    return false;
  }
  if (!rec || typeof rec !== "object" || rec.v !== version || typeof rec.at !== "number") {
    return false;
  }
  if (snoozeDays !== undefined && now - rec.at >= snoozeDays * DAY_MS) return false;
  return true;
}

/** Record a dismissal. Never throws: if storage refuses, memory keeps it. */
export function writeDismissal(
  key: string,
  version: string,
  now: number,
  store: Storage | null = storage(),
): void {
  const raw = JSON.stringify({ v: version, at: now } satisfies DismissRecord);
  try {
    if (!store) throw new Error("no storage");
    store.setItem(key, raw);
    memory.delete(key);
  } catch {
    memory.set(key, raw);
  }
  try {
    window.dispatchEvent(new Event(DISMISS_EVENT));
  } catch {
    /* no window (a test) — nothing is listening */
  }
}

/** Test seam: forget the in-memory fallback. */
export function resetDismissMemory(): void {
  memory.clear();
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DISMISS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(DISMISS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * `useDismissed("trial", "expired", { orgId, snoozeDays: 7 })`.
 *
 * `version` null means the banner has nothing to say right now; it is never
 * reported dismissed, so the caller's own "nothing to show" check decides.
 *
 * Rendered on the server (and in the static-markup tests) it reports NOT
 * dismissed: the server cannot see this device's storage, and a banner that
 * flashes away is a better failure than one that never appears. On the client
 * the stored answer is read during render, so a banner mounted after its query
 * resolves (all of them) never flashes in at all.
 */
export function useDismissed(
  banner: string,
  version: string | null,
  opts: { orgId: string | null; snoozeDays?: number },
): { dismissed: boolean; dismiss: () => void } {
  const key = dismissKey(currentUserId(), opts.orgId, banner);
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => "",
  );
  const dismissed = isDismissed(raw, version, opts.snoozeDays, Date.now());
  const dismiss = useCallback(() => {
    if (version !== null) writeDismissal(key, version, Date.now());
  }, [key, version]);
  return { dismissed, dismiss };
}
