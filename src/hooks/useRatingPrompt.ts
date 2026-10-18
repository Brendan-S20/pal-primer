import { useEffect, useRef } from "react";
import { useRouterState } from "@tanstack/react-router";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { isCalmPath } from "@/lib/rating-prompt";

/** How long a calm screen has to stay calm before it counts: long enough that
 *  a person passing through the dashboard on the way somewhere is not asked. */
const CALM_SETTLE_MS = 2_000;

/**
 * The app-rating prompt for the signed-in shell (issue #508): counts this
 * launch as a session, asks on each return to the foreground, and once a
 * calm screen (the dashboard, the My Day list) has settled. Everything it
 * decides is in src/lib/rating-prompt.ts.
 *
 * Nothing at all in the hosted app or the PWA: IS_NATIVE_BUNDLE folds to
 * false there and takes both effects with it, and the wrapper checks
 * isNative() again before it touches a plugin.
 */
export function useRatingPrompt(userId: string) {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const search = useRouterState({ select: (r) => r.location.searchStr });
  const location = { pathname, search };
  const where = useRef(location);
  where.current = location;

  useEffect(() => {
    if (!IS_NATIVE_BUNDLE) return;
    let cancelled = false;
    let stop: (() => void) | undefined;
    void import("@/lib/rating-prompt-native")
      .then((m) => m.startRatingPrompt(userId, () => where.current))
      .then((s) => {
        if (cancelled) s();
        else stop = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [userId]);

  const calm = isCalmPath(pathname, search);
  useEffect(() => {
    if (!IS_NATIVE_BUNDLE || !calm) return;
    const t = setTimeout(() => {
      void import("@/lib/rating-prompt-native")
        .then((m) => m.maybeRequestRatingPrompt(userId, () => where.current))
        .catch(() => {});
    }, CALM_SETTLE_MS);
    return () => clearTimeout(t);
  }, [calm, pathname, userId]);
}
