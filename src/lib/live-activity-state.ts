// What the route on the lock screen says, computed from the same visit list
// My Day draws.
//
// One builder, two callers: My Day on the phone (src/components/my-day/
// RouteLockScreen.tsx), with the visits as worked -- queued Completes
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
import { visitEta } from "@/lib/visit-eta";

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
  // ── The buttons (2026-10-07). Every one of these is null when the route is
  // finished, and every one is a plain value, never an object: the "skip
  // unchanged state" check in routeChangePriority compares field by field
  // with !==, and an object would differ from its own copy every time.
  //
  // An older app build ignores these keys and an older state (one saved in
  // live_activity_tokens.last_state, or sent before this) has none of them;
  // RouteActivityAttributes.swift decodes a missing one as nil, and the card
  // then draws no buttons. ──
  /** The stop on the card, for the deep links back into My Day. */
  visitId: string | null;
  /** Where Navigate sends the maps app: the property's coordinates... */
  destLat: number | null;
  destLng: number | null;
  /** ...or, only when it has none, its address, as My Day's Navigate uses. */
  destAddress: string | null;
  /** Which of My Day's buttons that stop needs next. */
  nextAction: "start" | "complete" | null;
  navigateLabel: string | null;
  /** The label for nextAction, in the tech's language. */
  actionLabel: string | null;
};

export type RouteActivityVisit = {
  id: string;
  status: string;
  scheduled_on?: string | null;
  /** A booked appointment's start (`time`); beats the ETA (#654). */
  start_time?: string | null;
  duration_min?: number | null;
  eta_start?: string | null;
  eta_end?: string | null;
  properties?: {
    label?: string | null;
    street?: string | null;
    city?: string | null;
    postal_code?: string | null;
    latitude?: number | null;
    longitude?: number | null;
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

/** Where Navigate goes: the property's coordinates when it has them, else
 *  "412 Elm St, Springfield, 62704", the string My Day's own Navigate button
 *  hands the maps app. The address is sent only when there are no
 *  coordinates, so the payload carries no more of it than it has to. */
export function stopDestination(
  v: RouteActivityVisit | undefined,
): { lat: number; lng: number; address: null } | { lat: null; lng: null; address: string | null } {
  const p = v?.properties;
  const lat = Number(p?.latitude);
  const lng = Number(p?.longitude);
  if (
    p?.latitude != null &&
    p?.longitude != null &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180 &&
    !(lat === 0 && lng === 0)
  ) {
    return { lat, lng, address: null };
  }
  const address = [p?.street, p?.city, p?.postal_code]
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean)
    .join(", ");
  return { lat: null, lng: null, address: address || null };
}

/** "10:40–11:00": the routed ETA if there is one, else the property's own
 *  service window, else nothing. The same precedence as My Day's card. */
export function stopWindow(v: RouteActivityVisit | undefined, ctx: RouteActivityContext): string | null {
  if (!v) return null;
  const t = ctx.t as (key: string, opts?: Record<string, unknown>) => string;
  const eta = visitEta(v, ctx.tz);
  if (eta.start) {
    const start = orgLocalTime(eta.start, ctx.tz, ctx.locale);
    const end = eta.end ? orgLocalTime(eta.end, ctx.tz, ctx.locale) : "";
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
  const dest = allDone ? null : next ? stopDestination(next) : null;
  // A stop under way needs Complete; one not started needs Start. On iOS 17
  // and later Start runs from the lock screen itself, through an App Intent
  // and the action token (src/lib/live-activity-action.ts). Complete opens
  // the app on the stop, straight into its photo capture when a photo is
  // what it needs (src/lib/live-activity-links.ts): completing can need a
  // photo, a checklist or a cash entry, and none of it is done from a lock
  // screen.
  const nextAction: RouteActivityState["nextAction"] =
    allDone || !next ? null : next.status === "in_progress" ? "complete" : "start";
  const hasDest = !!dest && (dest.lat != null || !!dest.address);

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
    visitId: allDone || !next ? null : next.id,
    destLat: dest?.lat ?? null,
    destLng: dest?.lng ?? null,
    destAddress: dest?.address ?? null,
    nextAction,
    navigateLabel: hasDest ? t("liveActivity.action.navigate") : null,
    actionLabel:
      nextAction === "complete"
        ? t("liveActivity.action.complete")
        : nextAction === "start"
          ? t("liveActivity.action.start")
          : null,
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
