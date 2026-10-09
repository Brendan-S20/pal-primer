// The time clock: one sheet, reached from the More tab and the sidebar, and a
// slim banner on My Day for the one moment a tech needs reminding.
//
// History, because it moved twice in two days. It was a full-width card on My
// Day; on 2026-10-07 it became a chip in My Day's status row ("the clock in
// and clock out ... need a better home/location. It's too cluttered"); and on
// 2026-10-08, after testing that build, the owner took it off My Day
// altogether. My Day is the route. The clock lives where the rest of a
// person's own things live:
//
//   * a "Time clock" row in the More sheet (MobileTabBar) and at the foot of
//     the sidebar, saying "On the clock · 3h 12m" or "Off the clock", which
//     opens THE sheet: on since when, this shift, today, and Clock out, or,
//     off the clock, today so far and Clock in. One sheet for the app,
//     mounted once by the signed-in layout and opened by an event, so the
//     More sheet can close under it;
//   * on My Day, ONLY when there is work today and the tech is not on the
//     clock: "You're off the clock" and a Clock in button. One tap, a
//     haptic, queued when there is no signal. On the clock, nothing at all.
//
// Clocking out says what the day came to -- hours and visits -- because that
// is the moment a tech wants to know it and the only moment the product has
// their attention for it.
//
// Works in a dead zone the way the visit buttons do: runOrQueue tries the
// server with a deadline and queues the tap otherwise, and everything here is
// drawn from the server's copy with the queued taps applied on top
// (queued-clock-state.ts), so a clock-in at a yard with no signal reads "On
// the clock" at once and still does after the app is reopened. The replay
// sends the tap time, so 7:02 is also what the timesheet will say.
//
// The route on the lock screen starts on Clock in by watching the same query
// (useRouteLiveActivity in my-day/RouteLockScreen.tsx), so nothing here has
// to know about it.

import { useCallback, useEffect, useState } from "react";
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

/** Asks the one time-clock sheet to open. TimeClockSheetHost listens. */
export const OPEN_TIME_CLOCK_EVENT = "houndstack:open-time-clock";

export function openTimeClock() {
  window.dispatchEvent(new Event(OPEN_TIME_CLOCK_EVENT));
}

/**
 * The clock as this device knows it -- the server's copy with queued taps on
 * top -- and the tap that changes it. `staff` is false for an account with no
 * staff record, which has no clock and draws none of this.
 */
export function useMyClock({ enabled = true }: { enabled?: boolean } = {}) {
  const fetchClock = useServerFn(getMyClock);
  const clockInFn = useServerFn(clockIn);
  const clockOutFn = useServerFn(clockOut);
  const qc = useQueryClient();
  const { t } = useTranslation();
  const { data, dataUpdatedAt } = useQuery({
    queryKey: MY_CLOCK_QUERY_KEY,
    queryFn: () => fetchClock(),
    staleTime: 30_000,
    enabled,
  });
  const taps = useQueuedClock(dataUpdatedAt);
  const [busy, setBusy] = useState(false);

  // The running total has to keep running.
  const [, repaint] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => repaint((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, [enabled]);

  const staff = !!data?.staff;
  const tz = data?.timezone;
  const now = Date.now();
  // Today at RENDER, not the day the copy was fetched: a copy restored from
  // disk may be yesterday's, and its open shift still counts toward today.
  const today = tz ? orgToday(tz) : null;
  const shown = data ? withQueuedClock(data.entries, taps) : null;
  const open = shown?.open ?? null;
  const todayMinutes = shown && today && tz ? minutesOnDay(shown.entries, today, tz, now) : 0;
  const shiftMinutes = open ? minutesBetween(open.clock_in, now) : 0;

  const summarise = useCallback(
    (minutes: number, count: number | null) => {
      const parts = [t("clock.today", { duration: durationLabel(t, minutes) })];
      if (count != null) parts.push(t("clock.visitsCompleted", { count }));
      return parts.join(" · ");
    },
    [t],
  );

  const tap = async (kind: "clock_in" | "clock_out"): Promise<boolean> => {
    if (busy || !data) return false;
    setBusy(true);
    haptic(kind === "clock_in" ? "success" : "tap");
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
            c.visitsCompletedToday,
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
            minutesOnDay(after.entries, orgToday(data.timezone), data.timezone, Date.now()),
            data.visitsCompletedToday,
          ),
          duration: 8_000,
        });
      }
      if (!queued) await qc.invalidateQueries({ queryKey: MY_CLOCK_QUERY_KEY });
      return true;
    } catch (e) {
      haptic("error");
      toast.error(e instanceof Error ? e.message : t("clock.unreachable"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const waiting =
    shown?.queued === "clock_in"
      ? t("clock.clockInWaiting")
      : shown?.queued === "clock_out"
        ? t("clock.clockOutWaiting")
        : null;

  return {
    data,
    staff,
    tz,
    open,
    busy,
    tap,
    waiting,
    shiftMinutes,
    todayMinutes,
    /** "On the clock · 3h 12m" or "Off the clock", for a row that opens the sheet. */
    status: open
      ? t("clock.onTheClock", { duration: durationLabel(t, shiftMinutes) })
      : t("clock.offTheClockShort"),
  };
}

/**
 * THE time-clock sheet. Mounted once, by the signed-in layout, and opened by
 * openTimeClock() from the More sheet or the sidebar. Renders nothing for an
 * account with no staff record.
 */
export function TimeClockSheetHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_TIME_CLOCK_EVENT, show);
    return () => window.removeEventListener(OPEN_TIME_CLOCK_EVENT, show);
  }, []);
  // Fetched only once somebody asks for it; the copy My Day keeps (and the
  // device persists) is what draws it until then.
  const clock = useMyClock({ enabled: open });
  const { t } = useTranslation();
  const locale = useIntlLocale();
  if (!clock.staff) return null;
  const { open: shift, tz, waiting, busy, tap, data } = clock;
  const visits = data?.visitsCompletedToday ?? null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="bottom" className="rounded-t-xl">
        <div className="mx-auto w-full max-w-md space-y-4">
          <SheetHeader className="text-start">
            <SheetTitle className="flex items-center gap-2">
              <Timer
                className={`h-5 w-5 shrink-0 ${
                  shift ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
                }`}
                aria-hidden="true"
              />
              {t("clock.label")}
            </SheetTitle>
            <SheetDescription>
              {shift && tz
                ? t("clock.onSince", { time: orgLocalTime(shift.clock_in, tz, locale) })
                : t("clock.offTheClock")}
            </SheetDescription>
          </SheetHeader>

          <dl className={`grid gap-3 ${shift ? "grid-cols-2" : "grid-cols-1"}`}>
            {shift && (
              <div className="min-w-0 rounded-lg bg-muted/60 p-3">
                <dt className="truncate text-xs text-muted-foreground">{t("clock.thisShift")}</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {durationLabel(t, clock.shiftMinutes)}
                </dd>
              </div>
            )}
            <div className="min-w-0 rounded-lg bg-muted/60 p-3">
              <dt className="truncate text-xs text-muted-foreground">{t("clock.todayTotal")}</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {durationLabel(t, Math.max(clock.todayMinutes, clock.shiftMinutes))}
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
            onClick={async () => {
              const ok = await tap(shift ? "clock_out" : "clock_in");
              if (ok) setOpen(false);
            }}
            className="min-h-11 w-full"
            data-time-clock-action={shift ? "clock-out" : "clock-in"}
          >
            {shift ? t("clock.clockOut") : t("clock.clockIn")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * "Time clock · On the clock · 3h 12m", as a row in the More sheet. Opens the
 * sheet. Not drawn for an account with no staff record.
 */
export function TimeClockMoreRow({ onSelect }: { onSelect: () => void }) {
  const clock = useMyClock();
  const { t } = useTranslation();
  if (!clock.staff) return null;
  return (
    <button
      type="button"
      onClick={() => {
        haptic("tap");
        onSelect();
        openTimeClock();
      }}
      data-time-clock-row=""
      className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-3 text-start text-sm font-medium transition-colors hover:bg-muted active:bg-muted"
    >
      <Timer
        className={`h-4 w-4 shrink-0 ${
          clock.open ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"
        }`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1 truncate">{t("clock.label")}</span>
      <span
        className={`shrink-0 text-xs tabular-nums ${
          clock.open ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"
        }`}
      >
        {clock.status}
      </span>
    </button>
  );
}

/**
 * My Day's reminder: "You're off the clock" and Clock in, ONLY while there is
 * work today and the tech is not on the clock. On the clock, and on a day
 * with nothing on it, it is not drawn at all.
 */
export function OffTheClockBanner({ visitsToday }: { visitsToday: number }) {
  const clock = useMyClock();
  const { t } = useTranslation();
  if (!clock.staff || clock.open || visitsToday === 0) return null;
  return (
    <div
      data-off-the-clock=""
      className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 py-1.5 ps-3 pe-1.5 text-sm"
    >
      <span className="flex min-w-0 items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
        <Timer className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t("clock.offTheClock")}</span>
      </span>
      <Button
        type="button"
        size="sm"
        disabled={clock.busy}
        onClick={() => void clock.tap("clock_in")}
        className="min-h-11 shrink-0 gap-1.5 px-4"
      >
        {t("clock.clockIn")}
        {clock.waiting && (
          <>
            <CloudOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="sr-only">{clock.waiting}</span>
          </>
        )}
      </Button>
    </div>
  );
}

/** "3h 12m" in the interface language: "3 س 12 د", "3小时12分钟".
 *  lib/time-clock's formatDuration is the same arithmetic in English, and stays
 *  English for the office's timesheets, which are not a tech screen. */
export function durationLabel(t: TFunction, minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return t("duration.minutes", { m: r });
  return r === 0 ? t("duration.hours", { h }) : t("duration.hoursMinutes", { h, m: r });
}
