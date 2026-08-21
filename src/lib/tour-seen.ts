// "Has this person already had the tour?", answered without a network.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// The tour's only record was `user_metadata.tour_seen_at`, read with
// `supabase.auth.getUser()` — a network call — and written with
// `updateUser()`, another one. Both fail offline, and the read fails OPEN:
//
//     const seen = data.user?.user_metadata?.tour_seen_at;
//     setPhase(seen ? "hidden" : "active");
//
// `data.user` is undefined when the call fails, so `seen` is undefined, so the
// tour starts. iOS QA 2026-08-21 caught it doing exactly that — "Welcome to
// HoundStack! 1 of 8" over a dashboard whose every figure was a dash, because
// offline the read cache holds only `["my-org"]`. The worst possible moment to
// offer a tour of numbers that are not there, on every single launch.
//
// A local record fixes both halves: it answers instantly and offline, and
// dismissing the tour sticks even when the metadata write cannot go out.
//
// ── PER USER, ON THIS DEVICE ──────────────────────────────────────────────
//
// Keyed by user id, so a second person signing into the same phone — a crew
// tablet, an owner lending a device to a new hire — still gets their own first
// run. The server metadata stays as the cross-device record: a user who has had
// the tour on their phone should not get it again on the office laptop.
//
// The two are deliberately OR'd rather than synchronised. Either saying "seen"
// is enough, because the only cost of a false "seen" is a tour someone can
// re-run from the Knowledge Center, and the cost of a false "unseen" is the bug
// above.
//
// NOT under `READ_CACHE_KEY_PREFIX`. That prefix is swept on sign-out so a
// shared tablet cannot leak the previous tech's route, and this is the opposite
// case: signing out and back in should not replay the tour. The value is a
// timestamp against an opaque user id — no route, no address, no name.

const KEY_PREFIX = "hs:tour-seen:";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // Private-mode Safari and locked-down WebViews throw on access. The tour
    // falling back to the server record is fine; failing the app is not.
    return null;
  }
}

/** Has this user dismissed or completed the tour on this device? */
export function hasSeenTourLocally(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    return !!storage()?.getItem(KEY_PREFIX + userId);
  } catch {
    return false;
  }
}

/** Remember that they have. Called on Skip and on Done alike — from the
 *  person's point of view those are the same decision. */
export function rememberTourSeen(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    storage()?.setItem(KEY_PREFIX + userId, new Date().toISOString());
  } catch {
    // Quota or blocked storage. The metadata write is still attempted.
  }
}

/** Let them have it again — the Knowledge Center's "re-run the tour". Without
 *  this the local record would out-vote a deliberate restart for ever. */
export function forgetTourSeen(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    storage()?.removeItem(KEY_PREFIX + userId);
  } catch {
    /* nothing here is worth failing on */
  }
}
