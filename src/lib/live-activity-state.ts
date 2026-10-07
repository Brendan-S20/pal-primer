// What the route on the lock screen says, computed from the same visit list
// My Day draws.
//
// One builder, two callers: My Day on the phone (src/components/my-day/
// RouteLiveActivityCard.tsx), with the visits as worked -- queued Completes
// and Skips applied -- and the server when the office changes the day
// (src/lib/push-liveactivity.server.ts), with the visits as stored. Both pass
// a `t` in the tech's language, so the strings the widget extension draws are
// finished text and it has no translations of its own
// (ios/App/App/LiveActivity/RouteActivityAttributes.swift is the other half
// of this shape, field for field).
//
// Nothing here is more personal than My Day: the next stop is named by the
// property's label or its street, never by the customer's name, because a
// lock screen is read by whoever picks the phone up.

import type { TFunction } from "i18next";
import { formatClock } from "@/lib/format";
import { orgLocalTime } from "@/lib/org-day";

/** The content state, as RouteActivityAttributes.ContentState decodes it. */
export type RouteActivityState = {
  stopLabel: string;
  nextLabel: string;
  nextStop: string | null;
  window: string | null;
  doneLabel: string;
  skippedLabel: string;
  done: number;
  skipped: number;
  total: number;
  position: number;
  allDone: boolean;
  rtl: boolean;
};

export type RouteActivityVisit = {
  id: string;
  status: string;
  eta_start?: string | null;
  eta_end?: string | null;
  properties?: {
    label?: string | null;
    street?: string | null;
    earliest_service_time?: string | null;
    latest_service_time?: string | null;
  } | null;
};

export type RouteActivityContext = {
  t: TFunction | ((key: string, opts?: Record<string, unknown>) => string);
  /** The organization's timezone: ETAs are instants read on the org's clock. */
  tz: string;
  /** The Intl locale for the interface language (intlLocaleFor). */
  locale?: string;
  rtl: boolean;
};

/** Still to do: the route is not finished while any of these remain. */
const OPEN = new Set(["scheduled", "in_progress"]);

/** A canceled visit is not on the route any more. Every other status is,
 *  including `missed`, which is finished without being done or skipped. */
export function routeStops<V extends { status: string }>(visits: readonly V[]): V[] {
  return visits.filter((v) => v.status !== "canceled");
}

/** "412 Elm St": the property's own label if the office gave it one, else
 *  its street. Null when it has neither. */
export function stopName(v: RouteActivityVisit | undefined): string | null {
  const p = v?.properties;
  const label = p?.label?.trim();
  if (label) return label;
  const street = p?.street?.trim();
  return street || null;
}

/** "10:40–11:00": the routed ETA if there is one, else the property's own
 *  service window, else nothing. The same precedence as My Day's card. */
export function stopWindow(v: RouteActivityVisit | undefined, ctx: RouteActivityContext): string | null {
  if (!v) return null;
  const t = ctx.t as (key: string, opts?: Record<string, unknown>) => string;
  if (v.eta_start) {
    const start = orgLocalTime(v.eta_start, ctx.tz, ctx.locale);
    const end = v.eta_end ? orgLocalTime(v.eta_end, ctx.tz, ctx.locale) : "";
    if (start && end) return t("liveActivity.window", { start, end });
    if (start) return start;
  }
  const p = v.properties;
  const early = p?.earliest_service_time ? formatClock(p.earliest_service_time, ctx.locale) : "";
  const late = p?.latest_service_time ? formatClock(p.latest_service_time, ctx.locale) : "";
  if (early && late) return t("liveActivity.window", { start: early, end: late });
  if (early) return t("liveActivity.after", { time: early });
  if (late) return t("liveActivity.by", { time: late });
  return null;
}

/**
 * The lock screen's state for a day.
 *
 * The stop shown is the one already under way, else the first one still
 * scheduled in route order -- the rule My Day's bottom bar follows (BUG-17 in
 * my-day-progress.ts), so the phone and the lock screen never point at two
 * different houses. "Stop 5 of 12" is that stop's place in the route, not a
 * count of finished ones: a tech who did #7 early is still driving to #5.
 */
export function buildRouteActivityState(
  visits: readonly RouteActivityVisit[],
  ctx: RouteActivityContext,
): RouteActivityState {
  const t = ctx.t as (key: string, opts?: Record<string, unknown>) => string;
  const stops = routeStops(visits);
  const total = stops.length;
  const done = stops.filter((v) => v.status === "completed").length;
  const skipped = stops.filter((v) => v.status === "skipped").length;
  const active = stops.find((v) => v.status === "in_progress");
  const next = active ?? stops.find((v) => v.status === "scheduled");
  const allDone = total > 0 && !stops.some((v) => OPEN.has(v.status));
  const position = next ? stops.indexOf(next) + 1 : total;

  return {
    stopLabel: allDone
      ? t("liveActivity.allDone")
      : t("liveActivity.stopOf", { position, total }),
    nextLabel: allDone
      ? t("liveActivity.finished")
      : active
        ? t("liveActivity.inProgress")
        : t("liveActivity.nextStop"),
    nextStop: allDone ? null : stopName(next),
    window: allDone ? null : stopWindow(next, ctx),
    doneLabel: t("liveActivity.done", { n: done }),
    skippedLabel: t("liveActivity.skipped", { n: skipped }),
    done,
    skipped,
    total,
    position,
    allDone,
    rtl: ctx.rtl,
  };
}

/** Is there anything to put on the lock screen: a route with a stop left. */
export function routeHasStopsLeft(visits: readonly { status: string }[]): boolean {
  return routeStops(visits).some((v) => OPEN.has(v.status));
}

/** How much a change matters to someone not looking at the phone. A
 *  different stop, a different number of stops, or the route finishing is a
 *  real change and goes at APNs priority 10; a new window or a count is
 *  minor, priority 5, which iOS may hold to save battery. Null when nothing a
 *  person would see is different, so nothing is sent at all. */
export function routeChangePriority(
  previous: RouteActivityState | null | undefined,
  next: RouteActivityState,
): 10 | 5 | null {
  if (!previous) return 10;
  if (
    previous.stopLabel !== next.stopLabel ||
    previous.nextStop !== next.nextStop ||
    previous.total !== next.total ||
    previous.position !== next.position ||
    previous.allDone !== next.allDone
  ) {
    return 10;
  }
  const keys = Object.keys(next) as (keyof RouteActivityState)[];
  return keys.some((k) => previous[k] !== next[k]) ? 5 : null;
}
