// When My Day replays the queue on its own, without being asked.
//
// ── "ALREADY SYNCING…" WITH NOTHING TO SYNC ─────────────────────────────────
//
// Reported 2026-09-27: opening My Day with an empty queue toasted "Already
// syncing…". The auto-sync effect was not running twice on every render — the
// server-fn callers it depends on are useCallback-stable, so the effect ran once
// per MOUNT. The page was being mounted twice.
//
// This app has no client entry of its own, so it hydrates through TanStack
// Start's default one, which wraps the tree in <StrictMode>. In development
// StrictMode mounts every component, unmounts it, and mounts it again, on
// purpose, to find effects that are not safe to repeat. This one was not: each
// mount started a replay, the first was still awaiting IndexedDB when the second
// arrived, `syncQueue` answered the second with `alreadyRunning`, and the page
// read that as somebody pressing the Sync button twice.
//
// StrictMode's rehearsal is not the only way to get there. A tech flicking from
// Today to Waste log and back while a replay is in flight — a replay that can
// take a minute per photo on one bar — remounts My Day for real, in production,
// and got the same toast on every return.
//
// So two changes, and both are needed:
//
//  1. The replay on mount is SCHEDULED, and the effect's cleanup cancels it.
//     StrictMode's unmount lands before the timer fires, so the rehearsal mount
//     starts nothing and exactly one replay runs per real mount. That removes
//     the double run rather than hiding its symptom.
//
//  2. "Already syncing…" is said only to a TAP. It exists because "saying
//     nothing is indistinguishable from a dead button" — which is about the
//     button. An automatic run that finds a replay already under way has
//     nothing to report: the replay in flight is doing exactly what it came to
//     do.

export type SyncTrigger = "tap" | "auto";

type Target = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "setTimeout" | "clearTimeout"
>;

/**
 * Replay once for this mount, and again whenever the browser comes back
 * online. Returns the cleanup, which is what makes a mount that is immediately
 * unmounted — StrictMode's, or a fast tab switch — start nothing.
 *
 * `isOffline` is asked when the timer FIRES rather than when it is set, so the
 * answer is the one current at the moment the replay would start.
 */
export function startAutoSync(
  run: (trigger: SyncTrigger) => void,
  target: Target,
  isOffline: () => boolean,
): () => void {
  const timer = target.setTimeout(() => {
    if (!isOffline()) run("auto");
  }, 0);
  const onOnline = () => run("auto");
  target.addEventListener("online", onOnline);
  return () => {
    target.clearTimeout(timer);
    target.removeEventListener("online", onOnline);
  };
}
