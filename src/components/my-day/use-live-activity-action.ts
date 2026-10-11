// My Day's half of the Start and Complete buttons on the lock screen.
//
// Those buttons open the app at /my-day?visit=<id>&action=start|complete
// (src/lib/live-activity-links.ts). The page already scrolls to ?visit=. This
// takes the last step.
//
// Both land on the stop's one button (src/lib/visit-step.ts), at whatever
// step the visit is at -- Start, "Take completion photo" or Complete -- bring
// it to the middle of the screen, focus it and pulse it once, and do NOT press
// it. Neither opens the camera: #357 had Complete open it by itself, and the
// owner's rule since 2026-10-09 is that the camera opens only on a tap at the
// photo step.
//
// START reaches here only when the lock screen could not start the stop
// itself (iOS 16, no signal, an expired token): the intent falls back to
// opening the app. The start the tech asked for did not happen, and the
// card's own button, with everything around it, is where to decide again.
// When the stop has moved on since the lock screen was drawn (it says Start,
// the visit is already under way) the button is at its later step, and that
// is what it lands on.
//
// The button is found inside the stop's card, #visit-<id>: the one marked
// data-visit-step, or failing that by its Start or Complete label.
// Once handled, `action` leaves the URL, so a refresh or a refetch does not
// do it again, and the next tap on the lock screen does.

import { useEffect, useRef } from "react";
import type { LiveActivityAction } from "@/lib/live-activity-links";

type Options = {
  visitId: string | undefined;
  action: LiveActivityAction | undefined;
  /** The stop's card is on the page. */
  ready: boolean;
  /** The two buttons' labels, exactly as the card draws them. */
  labels: Record<LiveActivityAction, string>;
  /** Take `action` back out of the URL. */
  onHandled: () => void;
};

/** The stop's one button, at its current step; else the button for this
 *  action by label, or the other one if that is all the card has now.
 *  Exported for the test. */
export function findActionButton(
  card: ParentNode,
  action: LiveActivityAction,
  labels: Record<LiveActivityAction, string>,
): HTMLButtonElement | null {
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
  const step = buttons.find((b) => b.hasAttribute?.("data-visit-step"));
  if (step) return step;
  const byLabel = (a: LiveActivityAction) =>
    buttons.find((b) => (b.textContent ?? "").trim() === labels[a]) ?? null;
  return byLabel(action) ?? byLabel(action === "start" ? "complete" : "start");
}

export function useLiveActivityAction({
  visitId,
  action,
  ready,
  labels,
  onHandled,
}: Options) {
  const done = useRef<string | null>(null);
  const handled = useRef(onHandled);
  handled.current = onHandled;
  const startLabel = labels.start;
  const completeLabel = labels.complete;

  useEffect(() => {
    if (!visitId || !action || !ready) return;
    const key = `${visitId}|${action}`;
    if (done.current === key) return;
    // Three frames: after My Day's own scroll to ?visit= (two), so this one,
    // which is more precise, is the one that wins.
    let f1 = 0;
    let f2 = 0;
    let f3 = 0;
    f1 = requestAnimationFrame(() => {
      f2 = requestAnimationFrame(() => {
        f3 = requestAnimationFrame(() => {
          done.current = key;
          const card = document.getElementById(`visit-${visitId}`);
          const button = card
            ? findActionButton(card, action, { start: startLabel, complete: completeLabel })
            : null;
          if (button) {
            button.scrollIntoView({ block: "center", behavior: "smooth" });
            if (!button.disabled) button.focus({ preventScroll: true });
            button.animate?.(
              [
                { boxShadow: "0 0 0 0 var(--ring)" },
                { boxShadow: "0 0 0 10px transparent" },
              ],
              { duration: 900, iterations: 2, easing: "ease-out" },
            );
          }
          handled.current();
        });
      });
    });
    return () => {
      cancelAnimationFrame(f1);
      cancelAnimationFrame(f2);
      cancelAnimationFrame(f3);
    };
  }, [visitId, action, ready, startLabel, completeLabel]);

  // A new tap on the lock screen for the same stop is a new request.
  useEffect(() => {
    if (!action) done.current = null;
  }, [action]);
}
