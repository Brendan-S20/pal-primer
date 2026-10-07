// The route on the lock screen: when it starts, what keeps it current, when
// it ends, and the one control a tech has over it.
//
// iPhone app only. Everywhere else this renders nothing and does nothing
// (src/lib/live-activity.ts is a no-op off iOS), and the whole card is
// absent from a page that is not the tech's own today.
//
// STARTS when the tech's day does, which in My Day is either of two taps,
// whichever comes first: Clock in, or Start on the first visit. Both are
// read as TRANSITIONS seen on this screen, never as a state found on
// opening it, so a tech who swiped the activity away is not handed it back
// every time the app comes to the front. And by hand, from this card.
//
// UPDATES on every change to the day as worked: the visits My Day already
// has, queued offline Completes and Skips included (withQueuedLifecycle), so
// the lock screen moves the moment the card does, signal or not. The office's
// changes arrive by push instead (push-liveactivity.server.ts), which is why
// the activity's token is saved.
//
// ENDS when nothing is left on the route (the last stop done or skipped; the
// final state stays up for fifteen minutes), when the tech clocks out, or
// when they press Hide.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PawPrint } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dirFor, languageFor, useIntlLocale } from "@/lib/i18n";
import { useOrgTimezone } from "@/hooks/useOrgToday";
import { getMyClock } from "@/lib/time-clock.functions";
import { MY_CLOCK_QUERY_KEY } from "@/components/TimeClockCard";
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
import { endLiveActivityToken, saveLiveActivityToken } from "@/lib/live-activity.functions";
import { reportClientError } from "@/lib/monitoring/client";
import { haptic } from "@/lib/haptics";

type EndReason = "dismissed" | "finished" | "clocked_out" | "hidden";

/** A finished route stays on the lock screen this long, then iOS removes it. */
const FINISHED_LINGERS_MS = 15 * 60 * 1000;

export function RouteLiveActivityCard({
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
}) {
  const on = enabled && liveActivityAvailable();
  const { t, i18n } = useTranslation();
  const lang = languageFor(i18n.language) ?? "en";
  const locale = useIntlLocale();
  const tz = useOrgTimezone();
  const saveFn = useServerFn(saveLiveActivityToken);
  const endFn = useServerFn(endLiveActivityToken);

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
    async (byHand: boolean) => {
      setBusy(true);
      endingReason.current = null;
      const r = await startRouteActivity(day, t("liveActivity.title"), stateRef.current);
      setBusy(false);
      if (!r) {
        if (byHand) toast.error(t("liveActivity.failed"));
        return;
      }
      setShowing(true);
      current.current = { id: r.id, token: r.pushToken };
      if (r.pushToken) void saveToken(r.id, r.pushToken);
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
  const onClock: boolean | null = clock?.staff ? withQueuedClock(clock.entries, taps).open != null : null;
  const begun = visits.filter((v) => v.status !== "scheduled" && v.status !== "canceled").length;

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
    if ((clockedIn || firstStart) && stopsLeft && !showing && !busy) void show(false);
  }, [can, day, begun, onClock, stopsLeft, showing, busy, show, stop]);

  // ── the card ──────────────────────────────────────────────────────────────
  if (!on || !support?.supported) return null;
  if (!showing && !stopsLeft) return null;

  return (
    <section
      aria-label={t("liveActivity.cardTitle")}
      className="flex items-center gap-3 rounded-lg border bg-card p-3"
    >
      <PawPrint
        className={`h-5 w-5 shrink-0 ${showing ? "text-primary" : "text-muted-foreground"}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{t("liveActivity.cardTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {!support.enabled
            ? t("liveActivity.cardDisabled")
            : showing
              ? t("liveActivity.cardOn")
              : t("liveActivity.cardOff")}
        </p>
      </div>
      {support.enabled && (
        <Button
          type="button"
          variant={showing ? "outline" : "default"}
          disabled={busy}
          onClick={() => {
            haptic("tap");
            if (showing) void stop("hidden", false);
            else void show(true);
          }}
          className="min-h-11 shrink-0 px-4"
        >
          {showing ? t("liveActivity.hide") : t("liveActivity.show")}
        </Button>
      )}
    </section>
  );
}
