// What an auto-routing plan would change about who has which visit.
//
// The panel shows this list before Apply (#609, D10), and Apply writes the
// plan the list was read from, so the list is the set of changes. Pure, so
// the preview, the write's own check and the tests all run the same rule.
//
// A move is a visit whose technician changes, or that comes off the route:
//
//   assigned     had nobody, now on a technician's route
//   reassigned   on one technician, now on another
//   unassigned   taken off its technician (only on a run that may move work,
//                and never a pinned visit: apply_route_plan keeps those)
//   off_route    keeps its technician but is on no route, because no route
//                keeps its window or nobody picked does its service
//
// A visit that stays with the same technician and only changes place in the
// order is not a move; the preview counts those separately. Auto-routing
// never changes a visit's day.

export type RouteMoveKind = "assigned" | "reassigned" | "unassigned" | "off_route";

export type RouteMove = {
  day: string;
  visitId: string;
  client: string | null;
  service: string | null;
  kind: RouteMoveKind;
  fromStaffId: string | null;
  /** Null when the visit ends on nobody's route. */
  toStaffId: string | null;
};

/** One visit as the plan read it, before anything was solved. */
export type VisitBefore = {
  visitId: string;
  staffId: string | null;
  pinned: boolean;
};

export function routeMoves(args: {
  day: string;
  before: ReadonlyArray<VisitBefore>;
  names?: ReadonlyMap<string, { client: string | null; service: string | null }>;
  routes: ReadonlyArray<{ staff_id: string; visit_ids: ReadonlyArray<string> }>;
  unassigned: ReadonlyArray<string>;
  reassign: boolean;
}): { moves: RouteMove[]; reordered: number } {
  const to = new Map<string, string>();
  for (const r of args.routes) for (const id of r.visit_ids) to.set(id, r.staff_id);
  const left = new Set(args.unassigned);
  const moves: RouteMove[] = [];
  let reordered = 0;
  for (const v of args.before) {
    const name = args.names?.get(v.visitId);
    const base = {
      day: args.day,
      visitId: v.visitId,
      client: name?.client ?? null,
      service: name?.service ?? null,
      fromStaffId: v.staffId,
    };
    const next = to.get(v.visitId);
    if (next !== undefined) {
      if (v.staffId === next) reordered++;
      else moves.push({ ...base, kind: v.staffId ? "reassigned" : "assigned", toStaffId: next });
      continue;
    }
    if (!left.has(v.visitId) || !v.staffId) continue;
    // apply_route_plan: a stop left out comes off its technician only when
    // the run may move work, and a pinned one never does.
    moves.push(
      args.reassign && !v.pinned
        ? { ...base, kind: "unassigned", toStaffId: null }
        : { ...base, kind: "off_route", toStaffId: v.staffId },
    );
  }
  return { moves, reordered };
}

/** Why a day's visits no longer match what the preview read, or null when
 *  they still do. Checked just before the write, so Apply never moves a
 *  visit the preview did not show. */
export function changedSincePreview(
  previewed: ReadonlyArray<VisitBefore>,
  now: ReadonlyArray<VisitBefore>,
): string | null {
  const current = new Map(now.map((v) => [v.visitId, v]));
  for (const v of previewed) {
    const c = current.get(v.visitId);
    if (!c) return "a visit was cancelled, moved or completed";
    if (c.staffId !== v.staffId) return "a visit was reassigned";
    if (c.pinned !== v.pinned) return "a visit was pinned or unpinned";
  }
  return null;
}
