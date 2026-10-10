import { useCallback, useRef } from "react";

const SEEN = "data-motion-seen";
const ARMED = "data-motion-armed";

/**
 * The ref for a `motion-list` container (styles.css, LIST ENTRANCE). With it,
 * a row ADDED to the list after it is on screen rises into place; without it
 * nothing in the list animates at all, which is the safe failure.
 *
 *   * The rows the list mounts with are marked seen before the browser
 *     paints (a ref callback runs in the commit), so first paint is the
 *     content, not an animation of it.
 *   * So is the first batch of rows an EMPTY list receives: a list that
 *     mounts empty and fills when its query lands is still arriving, not
 *     changing.
 *   * Any later row animates once, and is marked seen when its animation
 *     ends, so React moving it (a reorder re-inserts the node, and a
 *     re-inserted node would restart its animation) never replays it.
 *
 * The marks are attributes React does not own, so a re-render leaves them
 * alone. All of this is a MutationObserver and two attributes: no state, no
 * re-render, no layout read.
 */
export function useMotionList<T extends HTMLElement = HTMLElement>() {
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((el: T | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!el || typeof MutationObserver === "undefined") return;

    const markAll = () => {
      for (const child of el.children) child.setAttribute(SEEN, "");
    };
    markAll();
    let populated = el.children.length > 0;
    el.setAttribute(ARMED, "");

    const observer = new MutationObserver(() => {
      // MutationObserver callbacks run as a microtask, before the browser
      // renders again: an animation this cancels was never drawn.
      if (!populated && el.children.length > 0) {
        populated = true;
        markAll();
      } else if (el.children.length === 0) {
        populated = false;
      }
    });
    observer.observe(el, { childList: true });

    const onEnd = (e: AnimationEvent) => {
      const target = e.target as Element | null;
      if (target?.parentElement === el) target.setAttribute(SEEN, "");
    };
    el.addEventListener("animationend", onEnd);
    el.addEventListener("animationcancel", onEnd);

    cleanup.current = () => {
      observer.disconnect();
      el.removeEventListener("animationend", onEnd);
      el.removeEventListener("animationcancel", onEnd);
    };
  }, []);
}
