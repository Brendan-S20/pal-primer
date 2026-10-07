import type { TFunction } from "i18next";
import { haversineKm } from "@/lib/route-inputs";

/**
 * What happens in the field, as notifications: the rules, pure.
 *
 * src/lib/field-notify.server.ts reads the database and sends; this file
 * decides what a change MEANS (a stop added, the order changed, a truck
 * running late) and what it says, so all of that is tested without one.
 *
 * ── WHO HEARS WHAT, AND WHICH ONES BUZZ ────────────────────────────────────
 *
 * The tech whose day it is, in their own language, and never about a change
 * they made themselves:
 *   route_stop_added      a stop put on today's or tomorrow's route,
 *                         including a visit reassigned to them       PUSH
 *   route_stop_removed    a stop taken off it                         PUSH
 *   route_changed         anything bigger: several stops, or the
 *                         order. One summary, not one per stop        PUSH
 *   visit_access_changed  gate code, do-not-enter or hazard notes
 *                         changed on a stop they have TODAY            PUSH
 * Every one pushes because each changes what the tech does next, and they
 * find out in a driveway. A burst (a dispatcher dragging ten stops) pushes
 * ONCE and then updates that one notification in place for three minutes;
 * a change after that pushes again, replacing it on the phone.
 *
 * The owner, office managers and dispatchers, in English (office copy):
 *   visit_skipped         a tech skipped a stop, with the reason       PUSH
 *   visit_late            a tech will reach a stop after its arrival
 *                         window: once per stop, again only if it
 *                         slips another 15 minutes                     PUSH
 *   route_finished        last stop of the day done or skipped. In
 *                         the notification centre only, unless
 *                         something was skipped: "all done" is good
 *                         news nobody has to act on                    in-app
 *   field_collection      cash or a check to confirm (owner and
 *                         office managers: dispatchers cannot)         PUSH
 * A skip and a late arrival push because somebody may need to call the
 * customer NOW. Each is mutable in Notifications settings like every type.
 */

export const FIELD_TYPES = {
  routeChanged: "route_changed",
  stopAdded: "route_stop_added",
  stopRemoved: "route_stop_removed",
  accessChanged: "visit_access_changed",
  skipped: "visit_skipped",
  late: "visit_late",
  finished: "route_finished",
  collection: "field_collection",
} as const;

/** How long a burst of changes to one tech's day folds into one notification. */
export const ROUTE_COALESCE_MS = 3 * 60_000;

/** A truck is "late" once it will reach a stop this long after the arrival
 *  window closes. Less is noise: a few minutes either side of a window is
 *  what a window is for. */
export const LATE_GRACE_MIN = 10;
/** And is told about again only when it slips this much further. */
export const LATE_STEP_MIN = 15;

// ── The keys a push is filed under ─────────────────────────────────────────
//
// thread: what the phone stacks together (APNs thread-id) and what a burst is
// coalesced on. collapse: the one notification a newer push replaces. Each is
// at most 6 + 36 + 1 + 10 = 53 bytes, inside APNs' 64.

export const routeThreadId = (staffId: string, day: string) => `route:${staffId}:${day}`;
export const visitThreadId = (visitId: string) => `visit:${visitId}`;

/** My Day, at a day, optionally another tech's (an office role previews it)
 *  and scrolled to one stop. The route already reads `date` and `staff`;
 *  `visit` is what lands a tap on the stop the push is about. */
export function myDayLink(p: {
  day: string;
  staffId?: string | null;
  visitId?: string | null;
}): string {
  const q = new URLSearchParams({ date: p.day });
  if (p.staffId) q.set("staff", p.staffId);
  if (p.visitId) q.set("visit", p.visitId);
  return `/my-day?${q.toString()}`;
}

// ── What changed on a tech's day ───────────────────────────────────────────

export type RouteRow = {
  id: string;
  assigned_staff_id: string | null;
  scheduled_on: string;
  status: string;
  sequence: number | null;
  eta_start?: string | null;
  client?: string | null;
  address?: string | null;
};

export type RouteChange = {
  staffId: string;
  day: string;
  added: RouteRow[];
  removed: RouteRow[];
  reordered: boolean;
};

/** On the day as work still to do. A stop already done is not "taken off"
 *  when it is completed, and is not something a dispatcher moves. */
const OPEN = new Set(["scheduled", "in_progress"]);

const byRouteOrder = (a: RouteRow, b: RouteRow) =>
  (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
  String(a.eta_start ?? "").localeCompare(String(b.eta_start ?? "")) ||
  a.id.localeCompare(b.id);

function byDay(rows: RouteRow[], days: readonly string[]) {
  const out = new Map<string, RouteRow[]>();
  for (const r of rows) {
    if (!r.assigned_staff_id || !days.includes(r.scheduled_on) || !OPEN.has(r.status)) continue;
    const k = `${r.assigned_staff_id}|${r.scheduled_on}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  }
  for (const list of out.values()) list.sort(byRouteOrder);
  return out;
}

/** Each tech-day in `days` whose open stops differ between two snapshots:
 *  which were added, which taken off, and whether the ones on it both times
 *  are in a different order. A move between techs is a removal from one day
 *  and an addition to the other; a move to another date, the same. */
export function diffRoutes(
  before: RouteRow[],
  after: RouteRow[],
  days: readonly string[],
): RouteChange[] {
  const b = byDay(before, days);
  const a = byDay(after, days);
  const out: RouteChange[] = [];
  for (const key of new Set([...b.keys(), ...a.keys()])) {
    const was = b.get(key) ?? [];
    const now = a.get(key) ?? [];
    const wasIds = new Set(was.map((r) => r.id));
    const nowIds = new Set(now.map((r) => r.id));
    const added = now.filter((r) => !wasIds.has(r.id));
    const removed = was.filter((r) => !nowIds.has(r.id));
    const keptBefore = was
      .filter((r) => nowIds.has(r.id))
      .map((r) => r.id)
      .join();
    const keptAfter = now
      .filter((r) => wasIds.has(r.id))
      .map((r) => r.id)
      .join();
    const reordered = keptBefore !== keptAfter;
    if (!added.length && !removed.length && !reordered) continue;
    const [staffId, day] = key.split("|");
    out.push({ staffId, day, added, removed, reordered });
  }
  return out;
}

// ── What a tech reads ──────────────────────────────────────────────────────

export type TechNotice = {
  type: string;
  title: string;
  body: string;
  link: string;
  collapseId: string;
};

function stopLabel(t: TFunction, r: Pick<RouteRow, "client" | "address">): string {
  const client = r.client?.trim();
  const address = r.address?.trim();
  if (client && address) return t("techPush.stop", { client, address });
  return client || address || "";
}

const when = (kind: "today" | "tomorrow") => (kind === "today" ? "Today" : "Tomorrow");

/** One notification for one changed tech-day. A single stop on or off is
 *  named (and a tap on an added one opens it); anything more is a summary. */
export function techRouteNotice(
  t: TFunction,
  change: RouteChange,
  kind: "today" | "tomorrow",
  totalNow: number | null,
): TechNotice {
  const { added, removed, reordered, staffId, day } = change;
  if (added.length === 1 && !removed.length && !reordered) {
    return {
      type: FIELD_TYPES.stopAdded,
      title: t(`techPush.stopAdded${when(kind)}`),
      body: stopLabel(t, added[0]),
      link: myDayLink({ day, visitId: added[0].id }),
      collapseId: visitThreadId(added[0].id),
    };
  }
  if (removed.length === 1 && !added.length && !reordered) {
    return {
      type: FIELD_TYPES.stopRemoved,
      title: t(`techPush.stopRemoved${when(kind)}`),
      body: stopLabel(t, removed[0]),
      link: myDayLink({ day }),
      // The same key as its "added": a stop put on and taken off again is one
      // notification on the phone, now saying it came off.
      collapseId: visitThreadId(removed[0].id),
    };
  }
  const parts = [
    added.length ? t("techPush.added", { count: added.length }) : null,
    removed.length ? t("techPush.removed", { count: removed.length }) : null,
    reordered ? t("techPush.reordered") : null,
    totalNow != null ? t("techPush.total", { count: totalNow }) : null,
  ].filter((p): p is string => !!p);
  return {
    type: FIELD_TYPES.routeChanged,
    title: t(`techPush.routeChanged${when(kind)}`),
    body: parts.join(" · "),
    link: myDayLink({ day }),
    collapseId: routeThreadId(staffId, day),
  };
}

/** What a notification already sent for this day becomes when another change
 *  lands inside the coalescing window. */
export function coalescedRouteNotice(
  t: TFunction,
  day: string,
  kind: "today" | "tomorrow",
  totalNow: number | null,
): { title: string; body: string; link: string } {
  return {
    title: t(`techPush.routeChanged${when(kind)}`),
    body: [
      t("techPush.changedAgain"),
      totalNow != null ? t("techPush.total", { count: totalNow }) : null,
    ]
      .filter(Boolean)
      .join(" · "),
    link: myDayLink({ day }),
  };
}

// ── Access to a stop ───────────────────────────────────────────────────────

export type AccessFields = {
  gate_code?: string | null;
  do_not_enter_if_dog_out?: boolean | null;
  hazard_notes?: string | null;
};

export type AccessChange = "gateCode" | "doNotEnter" | "hazardNotes";

const norm = (s: string | null | undefined) => (s ?? "").trim();

/** What a property edit changed that a tech needs at the gate. Never the new
 *  VALUE: a push is on a lock screen, and a gate code is not lock-screen
 *  material. The tap opens the stop, where the code is. */
export function accessChanges(before: AccessFields, after: AccessFields): AccessChange[] {
  const out: AccessChange[] = [];
  if (norm(before.gate_code) !== norm(after.gate_code)) out.push("gateCode");
  if (!!before.do_not_enter_if_dog_out !== !!after.do_not_enter_if_dog_out) out.push("doNotEnter");
  if (norm(before.hazard_notes) !== norm(after.hazard_notes)) out.push("hazardNotes");
  return out;
}

export function accessNotice(
  t: TFunction,
  stop: { visitId: string; day: string; client?: string | null; address?: string | null },
  changes: AccessChange[],
): TechNotice {
  const what = changes.map((c) => t(`techPush.${c}`)).join(" · ");
  const label = stopLabel(t, stop);
  return {
    type: FIELD_TYPES.accessChanged,
    title: t("techPush.accessChanged"),
    body: label ? `${label} · ${what}` : what,
    link: myDayLink({ day: stop.day, visitId: stop.visitId }),
    collapseId: `access:${stop.visitId}`,
  };
}

// ── Running late ───────────────────────────────────────────────────────────

/** Minutes past the end of the arrival window a truck arriving at
 *  `projected` would be, or null if that is inside the grace (or there is no
 *  window to be late for). */
export function minutesLate(etaEnd: string | null | undefined, projected: Date): number | null {
  if (!etaEnd) return null;
  const end = Date.parse(etaEnd);
  if (Number.isNaN(end) || Number.isNaN(projected.getTime())) return null;
  const late = (projected.getTime() - end) / 60_000;
  return late > LATE_GRACE_MIN ? Math.ceil(late) : null;
}

/** Which slip this is: 0 for the first, 1 once it is 15 minutes worse, and so
 *  on. The event key carries it, so a stop is announced late once per step
 *  and never once per GPS ping. */
export function lateStep(minutes: number): number {
  // minutesLate is a whole number above the grace: 11..25 is the first step,
  // 26..40 the second.
  return Math.max(0, Math.floor((minutes - LATE_GRACE_MIN - 1) / LATE_STEP_MIN));
}

/** The drive, by the planner's own fallback model: straight line, times the
 *  road factor, at the organization's speed. */
export function estimateDriveMin(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  speedKmh: number,
  roadFactor: number,
): number {
  const km = haversineKm([from.lat, from.lng], [to.lat, to.lng]) * roadFactor;
  return speedKmh > 0 ? (km / speedKmh) * 60 : 0;
}

/** "about 25 min": rounded up to five, because a person reads it as a
 *  promise and the estimate is not that precise. */
export const roundLate = (minutes: number) => Math.ceil(minutes / 5) * 5;

// ── A finished route ───────────────────────────────────────────────────────

export type DayTally = {
  total: number;
  open: number;
  completed: number;
  skipped: number;
  missed: number;
};

/** The day as the office counts it: everything not canceled. */
export function tallyDay(rows: Array<{ status: string }>): DayTally {
  const live = rows.filter((r) => r.status !== "canceled");
  const n = (s: string) => live.filter((r) => r.status === s).length;
  return {
    total: live.length,
    open: n("scheduled") + n("in_progress"),
    completed: n("completed"),
    skipped: n("skipped"),
    missed: n("missed"),
  };
}

/** "Taylor finished 12 of 12, 1 skipped". Finished means nothing left open;
 *  the first number is how many were dealt with, the skips said separately
 *  because a skip is a stop somebody may have to rebook. */
export function finishedTitle(name: string, d: DayTally): string {
  const dealt = d.completed + d.skipped + d.missed;
  const skipped = d.skipped + d.missed;
  return `${name} finished ${dealt} of ${d.total}${skipped ? `, ${skipped} skipped` : ""}`;
}
