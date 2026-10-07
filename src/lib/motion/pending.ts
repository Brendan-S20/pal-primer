/**
 * When the route progress bar appears and how long it stays. Pure numbers so
 * the threshold is pinned by a unit test rather than by a feeling.
 *
 * A navigation that settles inside SHOW_AFTER_MS never draws anything: most
 * navigations are a preloaded chunk and a cached query, and a bar that
 * flashes on every one of them reads as the app being slow. Once shown, it
 * stays at least MIN_VISIBLE_MS, so a navigation that settles at 320ms does
 * not draw a 20ms sliver.
 *
 * The router's own `defaultPendingMs` / `defaultPendingMinMs` (src/router.tsx)
 * are set from the same two numbers, so a route's pending skeleton and the
 * bar agree on what "slow" means.
 */
export const PENDING_SHOW_AFTER_MS = 300;
export const PENDING_MIN_VISIBLE_MS = 400;

/** Has a navigation that started `elapsedMs` ago earned a progress bar? */
export function shouldShowProgress(elapsedMs: number): boolean {
  return elapsedMs >= PENDING_SHOW_AFTER_MS;
}

/** The bar has been visible for `visibleMs` and the navigation just settled:
 *  how much longer to keep it before finishing. */
export function remainingVisibleMs(visibleMs: number): number {
  return Math.max(0, PENDING_MIN_VISIBLE_MS - visibleMs);
}
