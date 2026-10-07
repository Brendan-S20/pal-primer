// The time clock on My Day, as one chip in the status row.
//
// It was a full-width card ("On the clock · 11h 23m / Since 6:04 AM / Clock
// out"), and with the lock-screen card under it the first stop started
// halfway down the phone. The owner: "the clock in and clock out ... need a
// better home/location. It's too cluttered." So:
//
//   OFF the clock, the slot is a primary Clock in button. That is a tech's
//   first action of the day, so it stays one tap and stays obvious.
//
//   ON the clock, it is a green timer, "11h 23m", which opens a bottom sheet:
//   on since when, the shift and the day so far, and Clock out. Clocking out
//   is two deliberate taps, never one brushed in passing on the way to a
//   stop's Start button.
//
// Clocking out says what the day came to -- hours and visits -- because that
// is the moment a tech wants to know it and the only moment the product has
// their attention for it.
//
// Works in a dead zone the way the visit buttons do: runOrQueue tries the
// server with a deadline and queues the tap otherwise, and the chip is drawn
// from the server's copy with the queued taps applied on top
// (queued-clock-state.ts), so a clock-in at a yard with no signal reads
// "On the clock" at once and still does after the app is reopened. The replay
// sends the tap time, so 7:02 is also what the timesheet will say.
//
// The route on the lock screen starts on Clock in by watching this query
// (useRouteLiveActivity in my-day/RouteLockScreen.tsx), so nothing here has to
// know about it.

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { CloudOff, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useIntlLocale } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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

export function TimeClockChip({
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
  const visits = visitsCompletedToday ?? data.visitsCompletedToday;

  const summarise = (minutes: number, count: number | null) => {
    const parts = [t("clock.today", { duration: durationLabel(t, minutes) })];
    if (count != null) parts.push(t("clock.visitsCompleted", { count }));
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
      if (kind === "clock_out") setSheetOpen(false);
      if (!queued) await qc.invalidateQueries({ queryKey: MY_CLOCK_QUERY_KEY });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("clock.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const waiting =
    shown.queued === "clock_in"
      ? t("clock.clockInWaiting")
      : shown.queued === "clock_out"
        ? t("clock.clockOutWaiting")
        : null;
  // Said, not only drawn: on the chip the cloud is the whole of the message.
  const waitingMark = waiting ? (
    <>
      <CloudOff className="h-3.5 w-3.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
      <span className="sr-only">{waiting}</span>
    </>
  ) : null;

  if (!open) {
    return (
      <Button
        type="button"
        disabled={busy}
        onClick={() => tap("clock_in")}
        data-time-clock="off"
        className="min-h-11 shrink-0 gap-1.5 px-4"
      >
        <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
        {t("clock.clockIn")}
        {waitingMark}
      </Button>
    );
  }

  const shift = durationLabel(t, shiftMinutes);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={t("clock.onTheClock", { duration: shift })}
        onClick={() => {
          haptic("tap");
          setSheetOpen(true);
        }}
        data-time-clock="on"
        className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-sm font-semibold tabular-nums text-emerald-700 transition-colors active:scale-95 dark:text-emerald-400"
      >
        <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="whitespace-nowrap">{shift}</span>
        {waitingMark}
      </button>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="bottom" className="rounded-t-xl">
          <div className="mx-auto w-full max-w-md space-y-4">
            <SheetHeader className="text-start">
              <SheetTitle className="flex items-center gap-2">
                <Timer
                  className="h-5 w-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  aria-hidden="true"
                />
                {t("clock.label")}
              </SheetTitle>
              <SheetDescription>
                {t("clock.onSince", { time: orgLocalTime(open.clock_in, tz, locale) })}
              </SheetDescription>
            </SheetHeader>

            <dl className="grid grid-cols-2 gap-3">
              <div className="min-w-0 rounded-lg bg-muted/60 p-3">
                <dt className="truncate text-xs text-muted-foreground">{t("clock.thisShift")}</dt>
                <dd className="text-lg font-semibold tabular-nums">{shift}</dd>
              </div>
              <div className="min-w-0 rounded-lg bg-muted/60 p-3">
                <dt className="truncate text-xs text-muted-foreground">{t("clock.todayTotal")}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {durationLabel(t, Math.max(todayMinutes, shiftMinutes))}
                </dd>
              </div>
            </dl>
            {visits != null && (
              <p className="text-sm text-muted-foreground">
                {t("clock.visitsCompleted", { count: visits })}
              </p>
            )}
            {waiting && (
              <p className="flex min-w-0 items-center gap-1.5 text-sm text-amber-700 dark:text-amber-400">
                <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0">{waiting}</span>
              </p>
            )}

            <Button
              type="button"
              disabled={busy}
              onClick={() => tap("clock_out")}
              className="min-h-11 w-full"
            >
              {t("clock.clockOut")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
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
