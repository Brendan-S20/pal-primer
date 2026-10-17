// One van is one groomer: two grooms for the same groomer cannot share a
// minute. This is the one copy of that check, used by booking
// (groom-booking.server.ts) and by every office path that moves a groom to
// another day or another groomer (visits.functions.ts, weather.functions.ts).
//
// A groom's hold is its visit's duration_min, which already carries the
// business's setup and cleanup minutes (groom_buffer_min): booking stores
// groomHoldMinutes on the plan and visits_groom_plan_stamp copies it onto
// every visit. So a moved groom is checked with the same length it was
// booked with.
//
// There is no override. Booking refuses a clash for the same groomer outright,
// and a move or a reassign does the same, with the same sentence.
//
// The database holds the same line (zz_visits_groom_no_overlap,
// 20261017120000) for the writes this file never sees: two saves at once, and
// Cover's redistribution. It raises 23P01 with the first sentence of
// groomClashRefusal; groomWriteError turns that back into the full sentence.

import { groomClashes, openGroomStarts, type BookedGroom } from "@/lib/groom";

/** The statuses that hold a groomer's time. */
export const GROOM_BUSY_STATUSES = ["scheduled", "in_progress", "completed"] as const;

/** Booking's refusal for a groom at `startTime` for `holdMinutes` on `date`,
 *  or null when it fits beside `booked`. */
export function groomClashRefusal(
  date: string,
  startTime: string,
  holdMinutes: number,
  booked: readonly BookedGroom[],
): string | null {
  if (groomClashes(startTime, holdMinutes, booked).length === 0) return null;
  const open = openGroomStarts(holdMinutes, booked);
  return open.length
    ? `This groomer already has a groom at that time on ${date}. Open start times that day: ${open.join(", ")}.`
    : `This groomer already has a groom at that time on ${date}, and no ${holdMinutes}-minute opening is left that day.`;
}

/** SQLSTATE of the database's refusal of an overlapping groom. */
export const GROOM_OVERLAP_SQLSTATE = "23P01";

/**
 * The error to throw for a failed visit write. When the database refused an
 * overlapping groom, the save lost a race to another one, so the clash is now
 * committed and refuseGroomMoveClash, asked again with the same move, throws
 * the sentence the server would have shown with the open start times. Any
 * other error, or a clash the check no longer finds, keeps the database's
 * message.
 */
export async function groomWriteError(
  db: any,
  error: { code?: string; message: string },
  move?: { visitIds: readonly string[]; toDate?: string; toStaffId?: string | null },
): Promise<Error> {
  if (error.code === GROOM_OVERLAP_SQLSTATE && move) {
    try {
      await refuseGroomMoveClash(db, move);
    } catch (e) {
      return e as Error;
    }
  }
  return new Error(error.message);
}

/** What a groomer (or, for null, the unassigned pool) already holds on each
 *  of `dates`, leaving out `excludeVisitIds`: the visits being moved, which
 *  cannot clash with themselves. */
export async function loadGroomerBusy(
  db: any,
  args: {
    orgId: string;
    staffId: string | null;
    dates: readonly string[];
    excludeVisitIds?: readonly string[];
  },
): Promise<Map<string, BookedGroom[]>> {
  const out = new Map<string, BookedGroom[]>();
  if (args.dates.length === 0) return out;
  let q = db
    .from("visits")
    .select("id, scheduled_on, start_time, duration_min, groom_summary")
    .eq("organization_id", args.orgId)
    .in("scheduled_on", [...args.dates])
    .in("status", [...GROOM_BUSY_STATUSES])
    .not("start_time", "is", null);
  q = args.staffId ? q.eq("assigned_staff_id", args.staffId) : q.is("assigned_staff_id", null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const skip = new Set(args.excludeVisitIds ?? []);
  for (const row of (data ?? []) as Array<{
    id: string;
    scheduled_on: string;
    start_time: string;
    duration_min: number | null;
    groom_summary: string | null;
  }>) {
    if (skip.has(row.id)) continue;
    const list = out.get(row.scheduled_on) ?? [];
    list.push({ start: row.start_time, minutes: row.duration_min ?? 0, summary: row.groom_summary });
    out.set(row.scheduled_on, list);
  }
  return out;
}

type MovedVisit = {
  id: string;
  organization_id: string;
  scheduled_on: string;
  start_time: string | null;
  duration_min: number | null;
  assigned_staff_id: string | null;
  status: string;
  groom_summary: string | null;
  services: { service_line: string | null } | Array<{ service_line: string | null }> | null;
};

/**
 * Refuse a move or a reassign that would put a groom on top of another for the
 * same groomer. `toDate` undefined keeps each visit's day; `toStaffId`
 * undefined keeps each visit's groomer. Visits that are not grooms, have no
 * start time, or do not hold time pass through untouched, so a scooping route
 * moves exactly as before.
 *
 * Taking a groom off its groomer (to the unassigned lane) is never refused:
 * it frees a van and cannot double-book one.
 *
 * Several grooms moved together are checked against each other too, in the
 * order given, so a bulk reassign cannot stack two of them on one groomer.
 */
export async function refuseGroomMoveClash(
  db: any,
  args: { visitIds: readonly string[]; toDate?: string; toStaffId?: string | null },
): Promise<void> {
  if (args.visitIds.length === 0) return;
  const { data, error } = await db
    .from("visits")
    .select(
      "id, organization_id, scheduled_on, start_time, duration_min, assigned_staff_id, status, groom_summary, services(service_line)",
    )
    .in("id", [...args.visitIds]);
  if (error) throw new Error(error.message);
  const byId = new Map(((data ?? []) as MovedVisit[]).map((v) => [v.id, v]));

  const moves: Array<{ v: MovedVisit; date: string; staffId: string }> = [];
  for (const id of args.visitIds) {
    const v = byId.get(id);
    if (!v) continue;
    const svc = Array.isArray(v.services) ? v.services[0] : v.services;
    if (svc?.service_line !== "mobile_grooming") continue;
    if (!v.start_time || !((v.duration_min ?? 0) > 0)) continue;
    if (!(GROOM_BUSY_STATUSES as readonly string[]).includes(v.status)) continue;
    const date = args.toDate ?? v.scheduled_on;
    const staffId = args.toStaffId === undefined ? v.assigned_staff_id : args.toStaffId;
    if (!staffId) continue;
    if (date === v.scheduled_on && staffId === v.assigned_staff_id) continue;
    moves.push({ v, date, staffId });
  }
  if (moves.length === 0) return;

  const key = (orgId: string, staffId: string) => `${orgId}|${staffId}`;
  const groups = new Map<string, { orgId: string; staffId: string; dates: Set<string> }>();
  for (const m of moves) {
    const k = key(m.v.organization_id, m.staffId);
    const g = groups.get(k) ?? { orgId: m.v.organization_id, staffId: m.staffId, dates: new Set() };
    g.dates.add(m.date);
    groups.set(k, g);
  }
  // The grooms being moved leave the busy set and come back one by one where
  // they land. Everything else stays where the database has it.
  const movedIds = moves.map((m) => m.v.id);
  const busy = new Map<string, Map<string, BookedGroom[]>>();
  for (const [k, g] of groups) {
    busy.set(
      k,
      await loadGroomerBusy(db, {
        orgId: g.orgId,
        staffId: g.staffId,
        dates: [...g.dates],
        excludeVisitIds: movedIds,
      }),
    );
  }

  for (const m of moves) {
    const day = busy.get(key(m.v.organization_id, m.staffId))!;
    const booked = day.get(m.date) ?? [];
    const hold = m.v.duration_min ?? 0;
    const refusal = groomClashRefusal(m.date, m.v.start_time!, hold, booked);
    if (refusal) throw new Error(refusal);
    booked.push({ start: m.v.start_time!, minutes: hold, summary: m.v.groom_summary });
    day.set(m.date, booked);
  }
}
