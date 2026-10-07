// The route on the lock screen: when it starts, what keeps it current, when
// it ends, and the one control a tech has over it.
//
// iPhone app only. Everywhere else this does nothing (src/lib/live-activity.ts
// is a no-op off iOS), and nothing at all on a page that is not the tech's
// own today.
//
// This was RouteLiveActivityCard, a full-width card on My Day that put the
// first stop halfway down the screen. Its logic moved here unchanged and its
// face became RouteLockScreenToggle, an icon in the status row; the owner's
// words were "the route on lock screen need a better home ... it's too
// cluttered". The hook is called by My Day itself rather than by the toggle,
// so the route keeps starting, updating and ending whether or not the status
// row is drawn.
//
// STARTS when the tech's day does, which in My Day is either of two taps,
// whichever comes first: Clock in, or Start on the first visit. Both are
// read as TRANSITIONS seen on this screen, never as a state found on
// opening it, so a tech who swiped the activity away is not handed it back
// every time the app comes to the front. And by hand, from the toggle. Never
// by itself on a phone whose "Route on the lock screen" preference is off
// (lib/live-activity-pref.ts); hiding it from the toggle turns that off.
//
// UPDATES on every change to the day as worked: the visits My Day already
// has, queued offline Completes and Skips included (withQueuedLifecycle), so
// the lock screen moves the moment the list does, signal or not. The office's
// changes arrive by push instead (push-liveactivity.server.ts), which is why
// the activity's token is saved.
//
// ENDS when nothing is left on the route (the last stop done or skipped; the
// final state stays up for fifteen minutes), when the tech clocks out, or
// when they hide it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { dirFor, languageFor, useIntlLocale } from "@/lib/i18n";
import { useOrgTimezone } from "@/hooks/useOrgToday";
import { getMyClock } from "@/lib/time-clock.functions";
import { MY_CLOCK_QUERY_KEY } from "@/components/TimeClockChip";
import { useQueuedClock } from "@/lib/offline/useQueuedClock";
import { withQueuedClock } from "@/lib/offline/queued-clock-state";
import {
  buildRouteActivityState,
  routeHasStopsLeft,
  type RouteActivityVisit,
} from "@/lib/live-activity-state";
import {
  endRouteActivity,
  liveActivityAvailable,
  liveActivitySupport,
  onRouteActivityEvents,
  startRouteActivity,
  updateRouteActivity,
} from "@/lib/live-activity";
import { useRouteOnLockScreen } from "@/lib/live-activity-pref";
import { endLiveActivityToken, saveLiveActivityToken } from "@/lib/live-activity.functions";
import { reportClientError } from "@/lib/monitoring/client";
import { haptic } from "@/lib/haptics";

type EndReason = "dismissed" | "finished" | "clocked_out" | "hidden";

/** A finished route stays on the lock screen this long, then iOS removes it. */
const FINISHED_LINGERS_MS = 15 * 60 * 1000;

export type RouteLiveActivity = {
  /** Draw a control at all: the iPhone app, ActivityKit present, the tech's
   *  own today, and either stops left to show or something showing. */
  relevant: boolean;
  /** Live Activities are switched on for the app in iPhone Settings. */
  allowed: boolean;
  showing: boolean;
  busy: boolean;
  /** Show it or hide it, with a toast that says which. */
  toggle: () => void;
};

export function useRouteLiveActivity({
  visits,
  day,
  enabled,
}: {
  /** My Day's visits for `day`, with queued taps applied. */
  visits: readonly RouteActivityVisit[];
  /** The org-local day those visits are for. */
  day: string;
  /** Today, the tech's own day (not an office preview), and a staff record. */
  enabled: boolean;
}): RouteLiveActivity {
  const on = enabled && liveActivityAvailable();
  const { t, i18n } = useTranslation();
  const lang = languageFor(i18n.language) ?? "en";
  const locale = useIntlLocale();
  const tz = useOrgTimezone();
  const saveFn = useServerFn(saveLiveActivityToken);
  const endFn = useServerFn(endLiveActivityToken);
  const pref = useRouteOnLockScreen();

  const [support, setSupport] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!on) return;
    let live = true;
    void liveActivitySupport().then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, [on]);
  const can = on && !!support?.supported && support.enabled;

  const state = useMemo(
    () => buildRouteActivityState(visits, { t, tz, locale, rtl: dirFor(lang) === "rtl" }),
    [visits, t, tz, locale, lang],
  );
  const stateKey = JSON.stringify(state);
  const stateRef = useRef(state);
  stateRef.current = state;
  const stopsLeft = routeHasStopsLeft(visits);

  // ── the token ─────────────────────────────────────────────────────────────
  const current = useRef<{ id: string; token?: string } | null>(null);
  const savedKey = useRef<string | null>(null);
  const endingReason = useRef<EndReason | null>(null);

  const saveToken = useCallback(
    async (id: string, token: string) => {
      const key = `${id}|${token}|${lang}`;
      if (savedKey.current === key) return;
      try {
        await saveFn({ data: { activityId: id, token, routeDate: day, language: lang } });
        savedKey.current = key;
      } catch (e) {
        reportClientError(e, { area: "live_activity", step: "save_token" });
      }
    },
    [saveFn, lang, day],
  );
  const endToken = useCallback(
    async (id: string, reason: EndReason) => {
      try {
        await endFn({ data: { activityId: id, reason } });
      } catch (e) {
        reportClientError(e, { area: "live_activity", step: "end_token" });
      }
    },
    [endFn],
  );

  useEffect(() => {
    if (!can) return;
    return onRouteActivityEvents({
      onToken: (e) => {
        current.current = { id: e.id, token: e.token };
        void saveToken(e.id, e.token);
      },
      onEnded: (e) => {
        setShowing(false);
        current.current = null;
        void endToken(e.id, endingReason.current ?? "dismissed");
      },
    });
  }, [can, saveToken, endToken]);

  // The server writes the office's changes in the language saved with the
  // token, so a language change re-saves it.
  useEffect(() => {
    const c = current.current;
    if (can && c?.token) void saveToken(c.id, c.token);
  }, [can, lang, saveToken]);

  // ── start, stop ───────────────────────────────────────────────────────────
  const show = useCallback(
    async (byHand: boolean): Promise<boolean> => {
      setBusy(true);
      endingReason.current = null;
      const r = await startRouteActivity(day, t("liveActivity.title"), stateRef.current);
      setBusy(false);
      if (!r) {
        if (byHand) toast.error(t("liveActivity.failed"));
        return false;
      }
      setShowing(true);
      current.current = { id: r.id, token: r.pushToken };
      if (r.pushToken) void saveToken(r.id, r.pushToken);
      return true;
    },
    [day, t, saveToken],
  );

  const stop = useCallback(
    async (reason: EndReason, finished: boolean) => {
      endingReason.current = reason;
      const ids = await endRouteActivity(
        finished ? stateRef.current : undefined,
        finished ? { after: new Date(Date.now() + FINISHED_LINGERS_MS) } : "immediate",
      );
      setShowing(false);
      current.current = null;
      for (const id of ids) void endToken(id, reason);
    },
    [endToken],
  );

  // ── keep it current ───────────────────────────────────────────────────────
  // Every change to the day. `update` is a no-op when nothing is showing, and
  // its answer is how this screen learns an activity from an earlier launch
  // is still up.
  useEffect(() => {
    if (!can) return;
    if (!stopsLeft) {
      // Finished, or every stop taken away: end what is showing, if anything.
      void stop("finished", stateRef.current.total > 0);
      return;
    }
    let live = true;
    void updateRouteActivity(stateRef.current).then((r) => {
      if (!live || !r) return;
      setShowing(r.updated);
      if (r.updated && r.id) {
        if (r.pushToken) {
          current.current = { id: r.id, token: r.pushToken };
          void saveToken(r.id, r.pushToken);
        } else if (current.current?.id !== r.id) {
          current.current = { id: r.id };
        }
      }
    });
    return () => {
      live = false;
    };
    // stateKey stands for `state`: a new object with the same content is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, stateKey, stopsLeft]);

  // ── when the day starts and stops ─────────────────────────────────────────
  const fetchClock = useServerFn(getMyClock);
  const { data: clock, dataUpdatedAt } = useQuery({
    queryKey: MY_CLOCK_QUERY_KEY,
    queryFn: () => fetchClock(),
    staleTime: 30_000,
    enabled: on,
  });
  const taps = useQueuedClock(dataUpdatedAt);
  const onClock: boolean | null = clock?.staff
    ? withQueuedClock(clock.entries, taps).open != null
    : null;
  const begun = visits.filter((v) => v.status !== "scheduled" && v.status !== "canceled").length;
  const wanted = pref.ready && pref.on;

  const seen = useRef<{ day: string; begun: number; onClock: boolean | null } | null>(null);
  useEffect(() => {
    if (!can) {
      seen.current = null;
      return;
    }
    const prev = seen.current;
    seen.current = { day, begun, onClock: onClock ?? prev?.onClock ?? null };
    // The first look at a day is a baseline, not an event.
    if (!prev || prev.day !== day) return;

    if (prev.onClock === true && onClock === false) {
      void stop("clocked_out", false);
      return;
    }
    const clockedIn = prev.onClock === false && onClock === true;
    const firstStart = prev.begun === 0 && begun > 0;
    if ((clockedIn || firstStart) && wanted && stopsLeft && !showing && !busy) void show(false);
  }, [can, day, begun, onClock, stopsLeft, showing, busy, show, stop, wanted]);

  // ── the preference changing under a mounted My Day ────────────────────────
  // Off ends what is showing. On, with the day already under way, starts it:
  // that is the tech asking for it, not the app handing it back unasked.
  const lastWanted = useRef<boolean | null>(null);
  useEffect(() => {
    if (!can || !pref.ready) return;
    const prev = lastWanted.current;
    lastWanted.current = pref.on;
    if (prev === null || prev === pref.on) return;
    if (!pref.on && showing) void stop("hidden", false);
    const underway = onClock === true || begun > 0;
    if (pref.on && underway && stopsLeft && !showing && !busy) void show(false);
    // Only the preference is the event here; the rest is read as it stands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, pref.ready, pref.on]);

  // ── the control ───────────────────────────────────────────────────────────
  const toggle = useCallback(() => {
    if (busy) return;
    haptic("tap");
    if (!support?.enabled) {
      // Switched off for the whole app in iPhone Settings: nothing this
      // screen can start, so say where the switch is.
      toast.message(t("liveActivity.cardDisabled"));
      return;
    }
    if (showing) {
      void stop("hidden", false).then(() => {
        pref.set(false);
        toast.success(t("liveActivity.hiddenToast"));
      });
    } else {
      void show(true).then((ok) => {
        if (!ok) return;
        pref.set(true);
        toast.success(t("liveActivity.cardOn"));
      });
    }
  }, [busy, support?.enabled, showing, stop, show, pref, t]);

  const relevant = on && !!support?.supported && (showing || stopsLeft);
  return { relevant, allowed: !!support?.enabled, showing, busy, toggle };
}
