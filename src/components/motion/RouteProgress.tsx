import { useEffect, useRef, useState } from "react";
import { useRouterState } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  PENDING_SHOW_AFTER_MS,
  remainingVisibleMs,
} from "@/lib/motion/pending";

type Phase = "idle" | "running" | "finishing";

/**
 * A thin bar along the top of the screen while a navigation is slow.
 *
 * Only slow ones: it waits PENDING_SHOW_AFTER_MS (300ms) before drawing
 * anything, so the ordinary navigation, a preloaded chunk and a cached
 * query, never flashes it. Once drawn it stays at least
 * PENDING_MIN_VISIBLE_MS and then runs to the end and fades. Both numbers
 * are in src/lib/motion/pending.ts, shared with the router's own pending
 * thresholds.
 *
 * It follows the ROUTER (code, beforeLoad, loaders), not every query in
 * flight. Data a page fetches after it has rendered is the page's skeleton's
 * job; a bar tied to every background refetch would never go away.
 *
 * Under the status bar on the native app (env() is 0 on the web), above
 * everything, and never in the way of a tap.
 */
export function RouteProgress() {
  const { t } = useTranslation();
  const pending = useRouterState({ select: (s) => s.status === "pending" });
  const [phase, setPhase] = useState<Phase>("idle");
  const shownAt = useRef(0);

  useEffect(() => {
    if (pending) {
      if (phase === "running") return;
      if (phase === "finishing") {
        // A new navigation began while the last one was fading out.
        shownAt.current = performance.now();
        setPhase("running");
        return;
      }
      const timer = setTimeout(() => {
        shownAt.current = performance.now();
        setPhase("running");
      }, PENDING_SHOW_AFTER_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "running") {
      const timer = setTimeout(
        () => setPhase("finishing"),
        remainingVisibleMs(performance.now() - shownAt.current),
      );
      return () => clearTimeout(timer);
    }
    if (phase === "finishing") {
      const timer = setTimeout(() => setPhase("idle"), 400);
      return () => clearTimeout(timer);
    }
  }, [pending, phase]);

  if (phase === "idle") return null;
  return (
    <div
      role="progressbar"
      aria-label={t("common.loading")}
      data-route-progress={phase}
      className="pointer-events-none fixed inset-x-0 z-[100] h-0.5"
      style={{ top: "env(safe-area-inset-top)" }}
    >
      <div
        className={`hs-progress-bar h-full w-full bg-primary ${
          phase === "running" ? "hs-progress-running" : "hs-progress-done"
        }`}
      />
    </div>
  );
}
