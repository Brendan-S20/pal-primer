/**
 * When coming back to the app refetches what is on screen.
 *
 * React Query refetches every query on screen whenever the page becomes
 * visible again, if its data is stale, and with the default staleTime of 0
 * all of it always is. In the native app "visible again" is every return from
 * another app: a glance at a text, a look at the camera roll, the Maps
 * handoff for directions. Each one fired every query on the screen at once,
 * and the answers landed together a moment later, re-rendering the page in
 * the middle of whatever the thumb was doing. On My Day that was the whole
 * day, its staff list, the time clock and the notification bell, for a
 * thirty-second detour.
 *
 * So a return refetches a query only when its data is older than
 * REFETCH_ON_RETURN_AFTER_MS. A tech back from twenty minutes of driving gets
 * a fresh day; one back from reading a text gets the same screen, still. A
 * query that sets its own refetchOnWindowFocus keeps it, and nothing else
 * changes: mount, reconnect, invalidation after a write and pull-to-refresh
 * all refetch exactly as before.
 */
export const REFETCH_ON_RETURN_AFTER_MS = 30_000;

/** For React Query's `refetchOnWindowFocus`: refetch on return only if the
 *  data was last updated at least REFETCH_ON_RETURN_AFTER_MS ago (or never). */
export function refetchOnReturn(
  query: { state: { dataUpdatedAt: number } },
  now: number = Date.now(),
): boolean {
  const at = query.state.dataUpdatedAt;
  if (!at) return true;
  return now - at >= REFETCH_ON_RETURN_AFTER_MS;
}
