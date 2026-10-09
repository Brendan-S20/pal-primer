// My Day's half of the Start and Complete buttons on the lock screen.
//
// Those buttons open the app at /my-day?visit=<id>&action=start|complete
// (src/lib/live-activity-links.ts). The page already scrolls to ?visit=. This
// takes the last step.
//
// COMPLETE (2026-10-08) goes straight into the stop's completion photo when
// that is what the visit needs: `openCapture` hands the request to the card,
// which opens the camera, then shows the checklist if there is one, then
// completes (src/lib/start-photo-complete.ts). Where no photo is needed the
// card puts the tech's thumb on its Complete button instead.
//
// START reaches here only when the lock screen could not start the stop
// itself (iOS 16, no signal, an expired token): the intent falls back to
// opening the app. Then this finds the stop's Start button, brings it to the
// middle of the screen, focuses it and pulses it once, and does NOT press it:
// the start the tech asked for did not happen, and the card's own button,
// with everything around it, is where to decide again. When the stop has
// moved on since the lock screen was drawn (it says Start, the visit is
// already under way) the other button is the one that exists, and that is
// the one it lands on.
//
// The button is found by its label inside the stop's card, #visit-<id>, so
// this needs nothing from the card's markup and survives it being moved.
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
  /** Ask the stop's card for its completion photo. True when the card took
   *  the request; false leaves the focus-the-button path to run. */
  openCapture?: (visitId: string) => boolean;
};

/** The stop's button for this action, or the other one if that is all the
 *  card has now. Exported for the test. */
export function findActionButton(
  card: ParentNode,
  action: LiveActivityAction,
  labels: Record<LiveActivityAction, string>,
): HTMLButtonElement | null {
  const buttons = [...card.querySelectorAll<HTMLButtonElement>("button")];
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
  openCapture,
}: Options) {
  const done = useRef<string | null>(null);
  const handled = useRef(onHandled);
  handled.current = onHandled;
  const capture = useRef(openCapture);
  capture.current = openCapture;
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
          if (action === "complete" && capture.current?.(visitId)) {
            handled.current();
            return;
          }
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
