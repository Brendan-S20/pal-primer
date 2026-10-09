// The route on the lock screen: when it starts, what keeps it current, when
// it ends, and the token its Start button presses with.
//
// iPhone app only. Everywhere else this does nothing (src/lib/live-activity.ts
// is a no-op off iOS, and RouteLockScreenHost renders nothing).
//
// MOUNTED BY THE SIGNED-IN LAYOUT, not by My Day (2026-10-08). It used to run
// inside My Day, so the route only came back when My Day was the page on
// screen. The owner wants it back whenever the app opens or returns to the
// front mid-day, whatever page that is, so RouteLockScreenHost reads today's
// route through the same query My Day uses (["my-day", today, ""], persisted
// for offline) and runs the hook from the layout.
//
// STARTS by itself (shouldStartRouteActivity, src/lib/live-activity-autostart
// .ts) whenever the app opens, comes back to the front, or the day changes
// under it, if: the Preferences switch "Route on the lock screen" is on; there
// is a stop left today; the tech is on the clock, or the day has begun and
// they have not clocked out; and nothing is showing. That replaces the old
// rule -- transitions only, never on opening -- which kept a route the tech
// had swiped away off the lock screen for the rest of the day. The switch is
// now the only way to say no, and turning it off ends what is showing.
//
// UPDATES on every change to the day as worked: the visits My Day already
// has, queued offline Completes and Skips included (withQueuedLifecycle), so
// the lock screen moves the moment the list does, signal or not. The office's
// changes arrive by push instead (push-liveactivity.server.ts), which is why
// the activity's push token is saved.
//
// THE START BUTTON. On iOS 17 the card's Start runs from the lock screen
// through an App Intent, which posts an ACTION TOKEN to the server
// (src/lib/live-activity-action.ts). The token is minted here, while signed
// in, whenever a route is showing and the one held is missing, for another
// day or near its end, and is handed to the plugin, which keeps it in the
// keychain. Ending the route forgets it on the phone and revokes it on the
// server.
//
// ENDS when nothing is left on the route (the last stop done or skipped; the
// final state stays up for fifteen minutes), when the tech clocks out, or
// when the Preferences switch is turned off.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { dirFor, languageFor, useIntlLocale } from "@/lib/i18n";
import { useOrgTimezone, useOrgToday } from "@/hooks/useOrgToday";
import { useMyProfile } from "@/hooks/useMyProfile";
import { getMyDay } from "@/lib/my-day.functions";
import { getMyClock } from "@/lib/time-clock.functions";
import { minutesOnDay } from "@/lib/time-clock";
import { orgToday } from "@/lib/org-day";
import { MY_CLOCK_QUERY_KEY } from "@/components/TimeClock";
import { useQueuedClock } from "@/lib/offline/useQueuedClock";
import { withQueuedClock } from "@/lib/offline/queued-clock-state";
import { useQueuedLifecycle } from "@/lib/offline/useQueuedLifecycle";
import { withQueuedLifecycle } from "@/lib/offline/queued-visit-state";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { buildRouteActivityState, type RouteActivityVisit } from "@/lib/live-activity-state";
import { routeHasWorkLeft, shouldStartRouteActivity } from "@/lib/live-activity-autostart";
import { ACTION_TOKEN_REFRESH_MS, LIVE_ACTIVITY_ACTION_PATH } from "@/lib/live-activity-action";
import {
  clearRouteActionToken,
  endRouteActivity,
  liveActivityAvailable,
  liveActivitySupport,
  onRouteActivityEvents,
  saveRouteActionToken,
  startRouteActivity,
  updateRouteActivity,
} from "@/lib/live-activity";
import { useRouteOnLockScreen } from "@/lib/live-activity-pref";
import {
  endLiveActivityToken,
  mintLiveActivityActionToken,
  saveLiveActivityToken,
} from "@/lib/live-activity.functions";
import { apiUrl } from "@/lib/server-fn-origin";
import { reportClientError } from "@/lib/monitoring/client";

type EndReason = "dismissed" | "finished" | "clocked_out" | "hidden";

/** A finished route stays on the lock screen this long, then iOS removes it. */
const FINISHED_LINGERS_MS = 15 * 60 * 1000;

export function useRouteLiveActivity({
  visits,
  day,
  enabled,
}: {
  /** Today's visits, with queued taps applied. */
  visits: readonly RouteActivityVisit[];
  /** The org-local day those visits are for: today. */
  day: string;
  /** A staff record, and today's route loaded. */
  enabled: boolean;
}): { showing: boolean } {
  const on = enabled && liveActivityAvailable();
  const { t, i18n } = useTranslation();
  const lang = languageFor(i18n.language) ?? "en";
  const locale = useIntlLocale();
  const tz = useOrgTimezone();
  const saveFn = useServerFn(saveLiveActivityToken);
  const endFn = useServerFn(endLiveActivityToken);
  const mintFn = useServerFn(mintLiveActivityActionToken);
  const pref = useRouteOnLockScreen();

  const [support, setSupport] = useState<{ supported: boolean; enabled: boolean } | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped each time the app comes back to the front: a reason to look again.
  const [resumed, setResumed] = useState(0);

  useEffect(() => {
    if (!on) return;
    let live = true;
    const check = () => void liveActivitySupport().then((s) => live && setSupport(s));
    check();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // The switch in iPhone Settings may have changed while we were away.
      check();
      setResumed((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
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
  const stopsLeft = routeHasWorkLeft(visits);

  // ── the push token ────────────────────────────────────────────────────────
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

  // ── the action token, for Start on the lock screen ────────────────────────
  const actionToken = useRef<{ key: string; expiresAt: number } | null>(null);
  const minting = useRef(false);
  const ensureActionToken = useCallback(async () => {
    const key = `${day}|${lang}`;
    const held = actionToken.current;
    if (held && held.key === key && held.expiresAt - Date.now() > ACTION_TOKEN_REFRESH_MS) return;
    // Minting needs the server; with no signal the card's Start opens the
    // app instead, exactly as it did before there was a token.
    if (minting.current || isDefinitelyOffline()) return;
    minting.current = true;
    try {
      const r = await mintFn({ data: { routeDate: day, language: lang } });
      if (!r.minted) return;
      const saved = await saveRouteActionToken({
        token: r.token,
        endpoint: apiUrl(LIVE_ACTIVITY_ACTION_PATH),
        routeDate: day,
        expiresAt: new Date(r.expiresAt),
      });
      if (saved) actionToken.current = { key, expiresAt: Date.parse(r.expiresAt) };
    } catch (e) {
      reportClientError(e, { area: "live_activity", step: "mint_action_token" });
    } finally {
      minting.current = false;
    }
  }, [mintFn, day, lang]);

  const forget = useCallback(() => {
    current.current = null;
    actionToken.current = null;
    void clearRouteActionToken();
  }, []);

  useEffect(() => {
    if (!can) return;
    return onRouteActivityEvents({
      onToken: (e) => {
        current.current = { id: e.id, token: e.token };
        void saveToken(e.id, e.token);
      },
      onEnded: (e) => {
        setShowing(false);
        forget();
        void endToken(e.id, endingReason.current ?? "dismissed");
      },
    });
  }, [can, saveToken, endToken, forget]);

  // The server writes the office's changes in the language saved with the
  // token, so a language change re-saves it (and mints a token in it).
  useEffect(() => {
    const c = current.current;
    if (can && c?.token) void saveToken(c.id, c.token);
    if (can && showing) void ensureActionToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, lang, saveToken]);

  // ── start, stop ───────────────────────────────────────────────────────────
  const show = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    endingReason.current = null;
    const r = await startRouteActivity(day, t("liveActivity.title"), stateRef.current);
    setBusy(false);
    if (!r) return false;
    setShowing(true);
    current.current = { id: r.id, token: r.pushToken };
    if (r.pushToken) void saveToken(r.id, r.pushToken);
    void ensureActionToken();
    return true;
  }, [day, t, saveToken, ensureActionToken]);

  const stop = useCallback(
    async (reason: EndReason, finished: boolean) => {
      endingReason.current = reason;
      const ids = await endRouteActivity(
        finished ? stateRef.current : undefined,
        finished ? { after: new Date(Date.now() + FINISHED_LINGERS_MS) } : "immediate",
      );
      setShowing(false);
      forget();
      for (const id of ids) void endToken(id, reason);
    },
    [endToken, forget],
  );

  // ── keep it current ───────────────────────────────────────────────────────
  // Every change to the day, and every return to the front. `update` is a
  // no-op when nothing is showing, and its answer is how this learns that an
  // activity from an earlier launch (or one iOS kept after the app was
  // killed) is still up. `looked` counts the answers: nothing is started
  // before the first one, so a route already up is updated, not doubled.
  const [looked, setLooked] = useState(0);
  useEffect(() => {
    if (!can) return;
    if (!stopsLeft) {
      // Finished, or every stop taken away: end what is showing, if anything.
      void stop("finished", stateRef.current.total > 0).then(() => setLooked((n) => n + 1));
      return;
    }
    let live = true;
    void updateRouteActivity(stateRef.current).then((r) => {
      if (!live) return;
      if (r) {
        setShowing(r.updated);
        if (r.updated && r.id) {
          if (r.pushToken) {
            current.current = { id: r.id, token: r.pushToken };
            void saveToken(r.id, r.pushToken);
          } else if (current.current?.id !== r.id) {
            current.current = { id: r.id };
          }
          // A route left up by an earlier launch needs this launch's token.
          void ensureActionToken();
        }
      }
      setLooked((n) => n + 1);
    });
    return () => {
      live = false;
    };
    // stateKey stands for `state`: a new object with the same content is not a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, stateKey, stopsLeft, resumed]);

  // ── the clock ─────────────────────────────────────────────────────────────
  const fetchClock = useServerFn(getMyClock);
  const { data: clock, dataUpdatedAt } = useQuery({
    queryKey: MY_CLOCK_QUERY_KEY,
    queryFn: () => fetchClock(),
    staleTime: 30_000,
    enabled: on,
  });
  const taps = useQueuedClock(dataUpdatedAt);
  const shownClock = clock?.staff ? withQueuedClock(clock.entries, taps) : null;
  const onClock: boolean | null = shownClock ? shownClock.open != null : null;
  // Off the clock after time on it today: they clocked out.
  const clockedOutToday =
    !!shownClock &&
    !shownClock.open &&
    !!clock?.timezone &&
    minutesOnDay(shownClock.entries, orgToday(clock.timezone), clock.timezone, Date.now()) > 0;

  // Clocking out ends it: a transition, seen here.
  const lastClock = useRef<{ day: string; onClock: boolean | null } | null>(null);
  useEffect(() => {
    if (!can) {
      lastClock.current = null;
      return;
    }
    const prev = lastClock.current;
    lastClock.current = { day, onClock: onClock ?? prev?.onClock ?? null };
    if (prev && prev.day === day && prev.onClock === true && onClock === false && showing) {
      void stop("clocked_out", false);
    }
  }, [can, day, onClock, showing, stop]);

  // ── starting it by itself ─────────────────────────────────────────────────
  // A STATE, not a transition: whenever the answer is yes -- on opening, on
  // coming back to the front, on Clock in, on the first Start -- once
  // update() has said whether one is already up. One attempt per reason to
  // look: a start that fails (iOS refused it) is not retried in a loop, but
  // the next change to the day, the clock or the switch tries again.
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (!can || looked === 0) return;
    const reason = `${looked}|${onClock}|${clockedOutToday}|${pref.ready && pref.on}`;
    if (attempted.current === reason) return;
    const go = shouldStartRouteActivity({
      supported: can,
      preferenceOn: pref.ready ? pref.on : null,
      visits,
      onClock,
      clockedOutToday,
      showing,
      busy,
    });
    if (!go) return;
    attempted.current = reason;
    void show();
    // `visits` changes reach here through looked, which update() bumps on
    // every change to the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [can, looked, pref.ready, pref.on, onClock, clockedOutToday, showing, busy]);

  // ── the preference, the one off switch ────────────────────────────────────
  useEffect(() => {
    if (!can || !pref.ready) return;
    if (!pref.on && showing) void stop("hidden", false);
  }, [can, pref.ready, pref.on, showing, stop]);

  return { showing };
}

/**
 * Today's route, read the way My Day reads it, driving the lock screen from
 * wherever the app happens to be. Renders nothing, and does nothing at all
 * off the iPhone app or for an account with no staff record.
 */
export function RouteLockScreenHost() {
  if (!liveActivityAvailable()) return null;
  return <RouteLockScreenRunner />;
}

function RouteLockScreenRunner() {
  const { staff } = useMyProfile();
  const today = useOrgToday();
  const fn = useServerFn(getMyDay);
  // My Day's own key for today, so the two share one fetch and one cache.
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["my-day", today, ""],
    queryFn: () => fn({ data: { day: today } }),
    enabled: !!staff,
  });
  const queued = useQueuedLifecycle(dataUpdatedAt);
  const serverVisits = data?.visits;
  const visits = useMemo(
    () => withQueuedLifecycle(serverVisits ?? [], queued),
    [serverVisits, queued],
  );
  useRouteLiveActivity({
    visits: visits as RouteActivityVisit[],
    day: today,
    enabled: !!staff && !!data?.staff && !data?.previewing,
  });
  return null;
}
