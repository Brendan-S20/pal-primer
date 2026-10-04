/**
 * The arithmetic behind the two touch gestures (PullToRefresh, and swipe
 * down to dismiss on a bottom sheet). Pure, so the thresholds are pinned by
 * tests/an-app-that-moves.test.ts rather than tuned by feel and forgotten.
 */

/** How far the refresh indicator must travel before letting go refreshes. */
export const PULL_THRESHOLD_PX = 64;
/** The indicator never travels further than this, however far the thumb goes. */
export const PULL_MAX_PX = 112;
/** Movement under this is a tap or a wobble, not yet a gesture of any kind. */
export const GESTURE_SLOP_PX = 8;

/**
 * Finger travel to indicator travel: one-to-one at first, then heavier and
 * heavier toward PULL_MAX_PX, so it feels attached to a spring rather than to
 * the thumb. Negative (pushing up) is no pull at all.
 */
export function pullDistance(fingerDy: number): number {
  if (fingerDy <= 0) return 0;
  return PULL_MAX_PX * (1 - Math.exp(-fingerDy / PULL_MAX_PX));
}

export type GestureAxis = "vertical" | "horizontal" | "undecided";

/**
 * Which way a gesture is going, once it has gone far enough to say. A
 * gesture that is more sideways than down belongs to whatever scrolls
 * sideways under the thumb (a day strip, a table), never to a pull.
 */
export function gestureAxis(dx: number, dy: number): GestureAxis {
  if (Math.abs(dx) < GESTURE_SLOP_PX && Math.abs(dy) < GESTURE_SLOP_PX) return "undecided";
  return Math.abs(dy) > Math.abs(dx) ? "vertical" : "horizontal";
}

/**
 * Should a sheet dragged down by `dy` px in `ms` milliseconds close, given
 * it is `height` px tall? A third of the way down closes it, and so does a
 * flick: fast enough (0.5px/ms, about what a deliberate swipe does) and at
 * least 24px, so a twitch is not a dismissal.
 */
export function shouldDismissSheet(dy: number, ms: number, height: number): boolean {
  if (dy <= 0) return false;
  if (dy >= height / 3) return true;
  const velocity = dy / Math.max(ms, 1);
  return dy >= 24 && velocity >= 0.5;
}

/**
 * Can a touch that started on `target` become a pull or a sheet drag? Not if
 * it began inside something that scrolls vertically and is not at its top
 * (the gesture is that scroller's), on a map, in a text field, or anywhere
 * marked `data-no-pull`.
 */
export function touchCanStartVerticalGesture(target: EventTarget | null, stopAt?: Element | null): boolean {
  let el = target instanceof Element ? target : null;
  if (!el) return true;
  if (el.closest("[data-no-pull], .leaflet-container, .gm-style, input, textarea, select, [contenteditable='true']")) {
    return false;
  }
  // Up to and including `stopAt` (a sheet that is itself the scroller), or
  // up to <body> for the page.
  for (; el && el !== document.body; el = el.parentElement) {
    if (el.scrollTop > 0) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === "auto" || oy === "scroll") return false;
    }
    if (el === stopAt) break;
  }
  return true;
}
