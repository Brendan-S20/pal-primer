import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { haptic } from "@/lib/haptics";
import {
  PULL_THRESHOLD_PX,
  gestureAxis,
  pullDistance,
  touchCanStartVerticalGesture,
} from "@/lib/motion/gestures";

type Phase = "idle" | "pulling" | "refreshing" | "settling";

/** An open dialog, sheet or menu owns the touch, not the page under it. */
const OPEN_LAYER = '[role="dialog"]:not([data-state="closed"]), [role="alertdialog"]:not([data-state="closed"])';

/**
 * Pull down at the top of the page to refetch what the page shows.
 *
 * TOUCH ONLY, and it stands aside for everything else that a downward drag
 * might mean: the page has to be scrolled to its very top, the gesture has to
 * be more down than sideways (a sideways drag is a day strip's or a table's),
 * it cannot start inside an inner scroller that is not at its own top, on a
 * map, in a text field, or while a dialog or sheet is open. Only once all of
 * that holds does it take the gesture (preventDefault, which is also what
 * stops iOS rubber-banding the page under the indicator).
 *
 * Past PULL_THRESHOLD_PX it gives one light haptic, so a thumb knows that
 * letting go now will refresh. Letting go refetches every ACTIVE react-query
 * query, which is exactly the queries the page on screen is using, and holds
 * the spinner until they are back (at least half a second, so a fast answer
 * still reads as "it did something").
 *
 * Never the only way: every page it is on refetches on focus and on
 * navigation, and My Day has its own Retry and Sync buttons. The indicator is
 * aria-hidden for that reason; the gesture is a shortcut, not a feature.
 *
 * Mount it anywhere in the page; it draws nothing until a pull begins.
 */
export function PullToRefresh({ onRefresh }: { onRefresh?: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const [phase, setPhase] = useState<Phase>("idle");
  const [distance, setDistance] = useState(0);
  const phaseRef = useRef<Phase>("idle");
  const distanceRef = useRef(0);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  const go = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };
  const move = (d: number) => {
    distanceRef.current = d;
    setDistance(d);
  };

  useEffect(() => {
    let tracking = false;
    let owned = false;
    let armed = false;
    let startX = 0;
    let startY = 0;

    const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY) <= 0;

    const onStart = (e: TouchEvent) => {
      tracking = false;
      owned = false;
      if (e.touches.length !== 1) return;
      if (phaseRef.current === "refreshing" || phaseRef.current === "settling") return;
      if (!atTop()) return;
      if (document.querySelector(OPEN_LAYER)) return;
      if (!touchCanStartVerticalGesture(e.target)) return;
      tracking = true;
      armed = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    };

    const onMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (!owned) {
        const axis = gestureAxis(dx, dy);
        if (axis === "undecided") return;
        // Sideways, or up: not a pull. Let it go for the rest of this touch.
        if (axis === "horizontal" || dy <= 0 || !atTop()) {
          tracking = false;
          return;
        }
        owned = true;
        go("pulling");
      }
      if (e.cancelable) e.preventDefault();
      const d = pullDistance(dy);
      move(d);
      if (!armed && d >= PULL_THRESHOLD_PX) {
        armed = true;
        haptic("tap");
      } else if (armed && d < PULL_THRESHOLD_PX) {
        armed = false;
      }
    };

    const settle = () => {
      go("settling");
      move(0);
      setTimeout(() => {
        if (phaseRef.current === "settling") go("idle");
      }, 260);
    };

    const onEnd = () => {
      if (!tracking) return;
      tracking = false;
      if (!owned) return;
      owned = false;
      if (distanceRef.current < PULL_THRESHOLD_PX) {
        settle();
        return;
      }
      go("refreshing");
      move(PULL_THRESHOLD_PX);
      const work = refreshRef.current?.() ?? qc.refetchQueries({ type: "active" });
      Promise.all([
        Promise.resolve(work).catch(() => {}),
        new Promise((r) => setTimeout(r, 500)),
      ]).finally(settle);
    };

    const onCancel = () => {
      if (!tracking) return;
      tracking = false;
      if (owned) {
        owned = false;
        settle();
      }
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    // Not passive: once the pull is ours it has to stop the page bouncing.
    document.addEventListener("touchmove", onMove, { passive: false });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
    };
  }, [qc]);

  if (phase === "idle") return null;
  const progress = Math.min(1, distance / PULL_THRESHOLD_PX);
  return (
    <div
      aria-hidden="true"
      data-pull-to-refresh={phase}
      className="pointer-events-none fixed inset-x-0 z-[45] flex justify-center"
      style={{ top: "calc(env(safe-area-inset-top) + var(--hs-banner-h, 0px))" }}
    >
      <div
        className="grid h-10 w-10 place-items-center rounded-full border bg-background shadow-md"
        style={{
          transform: `translateY(${distance - 44}px)`,
          opacity: phase === "settling" ? 0 : Math.max(0.3, progress),
          transition:
            phase === "pulling"
              ? "none"
              : "transform var(--motion-duration-base) var(--motion-ease-standard), opacity var(--motion-duration-base) var(--motion-ease-standard)",
        }}
      >
        <RefreshCw
          className={`h-5 w-5 shrink-0 text-primary ${phase === "refreshing" ? "animate-spin" : ""}`}
          style={phase === "refreshing" ? undefined : { transform: `rotate(${progress * 270}deg)` }}
        />
      </div>
    </div>
  );
}
