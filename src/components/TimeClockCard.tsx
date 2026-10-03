// The time clock at the top of My Day.
//
// One card, one button. Off the clock it offers Clock in; on the clock it says
// since when and for how long, and offers Clock out. Clocking out says what the
// day came to -- hours and visits -- because that is the moment a tech wants to
// know it and the only moment the product has their attention for it.
//
// Works in a dead zone the way the visit buttons do: runOrQueue tries the
// server with a deadline and queues the tap otherwise, and the card is drawn
// from the server's copy with the queued taps applied on top
// (queued-clock-state.ts), so a clock-in at a yard with no signal reads "On
// the clock since 7:02" at once and still does after the app is reopened. The
// replay sends the tap time, so 7:02 is also what the timesheet will say.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CloudOff, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIntlLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { clockIn, clockOut, getMyClock, type MyClock } from "@/lib/time-clock.functions";
import { minutesBetween, minutesOnDay } from "@/lib/time-clock";
import type { TFunction } from "i18next";
import { orgLocalTime, orgToday } from "@/lib/org-day";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { enqueueAction } from "@/lib/offline/queue";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { useQueuedClock } from "@/lib/offline/useQueuedClock";
import { withQueuedClock } from "@/lib/offline/queued-clock-state";
import { haptic } from "@/lib/haptics";

/** Under the "my-day" root so it is persisted with the day for offline use
 *  (read-cache-policy) and refetched with it after a sync. */
export const MY_CLOCK_QUERY_KEY = ["my-day", "clock"] as const;

export function TimeClockCard({
  visitsCompletedToday,
}: {
  /** My Day's own count when it is showing today, which already includes
   *  completions still in the queue. Null when it is showing another day. */
  visitsCompletedToday: number | null;
}) {
  const fetchClock = useServerFn(getMyClock);
  const clockInFn = useServerFn(clockIn);
  const clockOutFn = useServerFn(clockOut);
  const qc = useQueryClient();
  const { data, dataUpdatedAt } = useQuery({
    queryKey: MY_CLOCK_QUERY_KEY,
    queryFn: () => fetchClock(),
    staleTime: 30_000,
  });
  const taps = useQueuedClock(dataUpdatedAt);
  const [busy, setBusy] = useState(false);
  const { t } = useTranslation();
  const locale = useIntlLocale();

  // The running total has to keep running.
  const [, repaint] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => repaint((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);

  if (!data?.staff) return null;

  const tz = data.timezone;
  const now = Date.now();
  // Today at RENDER, not the day the copy was fetched: a copy restored from
  // disk may be yesterday's, and its open shift still counts toward today.
  const today = orgToday(tz);
  const shown = withQueuedClock(data.entries, taps);
  const todayMinutes = minutesOnDay(shown.entries, today, tz, now);
  const open = shown.open;
  const shiftMinutes = open ? minutesBetween(open.clock_in, now) : 0;

  const summarise = (minutes: number, visits: number | null) => {
    const parts = [t("clock.today", { duration: durationLabel(t, minutes) })];
    if (visits != null) parts.push(t("clock.visitsCompleted", { count: visits }));
    return parts.join(" · ");
  };

  const tap = async (kind: "clock_in" | "clock_out") => {
    if (busy) return;
    setBusy(true);
    haptic("tap");
    try {
      // Filled by the live clock-out, which returns the day as it now stands.
      const live: { clock?: MyClock } = {};
      const { queued } = await runOrQueue({
        online: !isDefinitelyOffline(),
        label: kind === "clock_in" ? "Clock in" : "Clock out",
        send: async () => {
          if (kind === "clock_in") await clockInFn({ data: {} });
          else live.clock = (await clockOutFn({ data: {} })).clock;
        },
        queue: async () => {
          await enqueueAction({ kind, userId: await resolveOfflineUserId() });
        },
      });

      if (kind === "clock_in") {
        toast.success(queued ? t("clock.clockedInQueued") : t("clock.clockedIn"));
      } else if (live.clock) {
        const c = live.clock;
        qc.setQueryData(MY_CLOCK_QUERY_KEY, c);
        toast.success(t("clock.clockedOut"), {
          description: summarise(
            minutesOnDay(c.entries, c.today, c.timezone, Date.now()),
            visitsCompletedToday ?? c.visitsCompletedToday,
          ),
          duration: 8_000,
        });
      } else {
        // Queued: the summary is the day as this device knows it, with the tap
        // just made applied, and says that it is waiting to sync.
        const after = withQueuedClock(data.entries, [
          ...taps,
          { id: "this-tap", kind: "clock_out", at: Date.now() },
        ]);
        toast.success(t("clock.clockedOutQueued"), {
          description: summarise(
            minutesOnDay(after.entries, today, tz, Date.now()),
            visitsCompletedToday ?? data.visitsCompletedToday,
          ),
          duration: 8_000,
        });
      }
      if (!queued) await qc.invalidateQueries({ queryKey: MY_CLOCK_QUERY_KEY });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("clock.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const earlierToday = todayMinutes - shiftMinutes;

  return (
    <section
      aria-label={t("clock.label")}
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        open ? "border-emerald-500/40 bg-emerald-500/5" : "bg-card"
      }`}
    >
      <Timer
        className={`h-5 w-5 shrink-0 ${open ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {/* The running time on the first line and the start on the second,
              not "On the clock since 7:42 AM" as one: at 360px beside the
              button that sentence truncated exactly the part being asked
              about, the time. */}
          {open
            ? t("clock.onTheClock", { duration: durationLabel(t, shiftMinutes) })
            : t("clock.offTheClock")}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {open
            ? `${t("clock.since", { time: orgLocalTime(open.clock_in, tz, locale) })}${
                earlierToday >= 1
                  ? ` · ${t("clock.today", { duration: durationLabel(t, todayMinutes) })}`
                  : ""
              }`
            : todayMinutes >= 1
              ? t("clock.today", { duration: durationLabel(t, todayMinutes) })
              : t("clock.prompt")}
        </p>
        {shown.queued && (
          <p className="flex min-w-0 items-center gap-1 text-xs text-amber-700 dark:text-amber-400">
            <CloudOff className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {shown.queued === "clock_in" ? t("clock.clockInWaiting") : t("clock.clockOutWaiting")}
            </span>
          </p>
        )}
      </div>
      <Button
        type="button"
        variant={open ? "outline" : "default"}
        disabled={busy}
        onClick={() => tap(open ? "clock_out" : "clock_in")}
        className="min-h-11 shrink-0 px-4"
      >
        {open ? t("clock.clockOut") : t("clock.clockIn")}
      </Button>
    </section>
  );
}

/** "3h 12m" in the interface language: "3 س 12 د", "3小时12分钟".
 *  lib/time-clock's formatDuration is the same arithmetic in English, and stays
 *  English for the office's timesheets, which are not a tech screen. */
function durationLabel(t: TFunction, minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return t("duration.minutes", { m: r });
  return r === 0 ? t("duration.hours", { h }) : t("duration.hoursMinutes", { h, m: r });
}
