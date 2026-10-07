// What happens in the field, told to the people it matters to.
//
// Until this file, every notification in the product was about the office:
// a portal request, a payment, a text. The field told nobody anything -- not
// the office when a stop was skipped or a truck was late or a route was
// done, and not the tech when the office moved their day around. The rules
// (who hears what, which ones buzz, what they say) are in field-notify.ts;
// this is the half that reads the database and sends, through notifyUsers /
// notifyRoles, which is the one door every notification and push leaves by.
//
// Every export here is BEST-EFFORT and never throws. Each runs after the
// action it reports has already succeeded, and a notification that could not
// be sent must never turn a tech's tap or a dispatcher's drag into an error.
//
// All reads are on the service role, because the people notified are not the
// person acting: a tech cannot read the office's roles, and a dispatcher's
// session has no business reading another person's language. Every query is
// pinned to one organization, resolved from the acting user or the row.

import {
  FIELD_TYPES,
  ROUTE_COALESCE_MS,
  accessChanges,
  accessNotice,
  coalescedRouteNotice,
  diffRoutes,
  estimateDriveMin,
  finishedTitle,
  LATE_GIVE_UP_MIN,
  LATE_LOOKAHEAD_MIN,
  lateStep,
  minutesLate,
  nextStopPerTechDay,
  whereTheTruckIs,
  withinWorkingHours,
  myDayLink,
  roundLate,
  routeThreadId,
  tallyDay,
  techRouteNotice,
  visitThreadId,
  type AccessFields,
  type RouteChange,
  type RouteRow,
} from "@/lib/field-notify";
import { DEFAULT_ORG_TIMEZONE, orgLocalMinutes, orgLocalTime, orgToday } from "@/lib/org-day";

type Admin = { from: (table: string) => any };

const OFFICE = ["owner", "office_manager", "dispatcher"] as const;

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as Admin;
}

function addDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

type OrgClock = {
  orgId: string;
  tz: string;
  today: string;
  tomorrow: string;
  speedKmh: number;
  roadFactor: number;
};

const CLOCK_COLS = "timezone, avg_speed_kmh, measured_speed_kmh, road_factor, measured_road_factor";

async function orgClock(db: Admin, orgId: string, now = new Date()): Promise<OrgClock> {
  const { data: org } = await db
    .from("organizations")
    .select(CLOCK_COLS)
    .eq("id", orgId)
    .maybeSingle();
  return clockOf(orgId, org, now);
}

type ClockRow = {
  timezone?: string | null;
  avg_speed_kmh?: number | null;
  measured_speed_kmh?: number | null;
  road_factor?: number | null;
  measured_road_factor?: number | null;
} | null;

function clockOf(orgId: string, org: ClockRow, now: Date): OrgClock {
  const tz = (org?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
  const today = orgToday(tz, now);
  const speed = Number(org?.measured_speed_kmh ?? org?.avg_speed_kmh ?? 40);
  const factor = Number(org?.measured_road_factor ?? org?.road_factor ?? 1.35);
  return {
    orgId,
    tz,
    today,
    tomorrow: addDay(today, 1),
    speedKmh: speed > 0 ? speed : 40,
    roadFactor: factor > 0 ? factor : 1.35,
  };
}

async function orgOfUser(db: Admin, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const { data } = await db
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();
  return (data?.organization_id as string | undefined) ?? null;
}

const one = <T>(x: T | T[] | null | undefined): T | null =>
  Array.isArray(x) ? (x[0] ?? null) : (x ?? null);

const addressOf = (p: { street?: string | null; city?: string | null } | null) =>
  p ? [p.street, p.city].filter(Boolean).join(", ") : "";

async function languageOf(db: Admin, userId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("app_notification_prefs")
      .select("language")
      .eq("user_id", userId)
      .maybeSingle();
    return error ? null : ((data?.language as string | null) ?? null);
  } catch {
    return null;
  }
}

async function staffRows(db: Admin, orgId: string, ids: string[]) {
  if (!ids.length)
    return new Map<string, { user_id: string | null; display_name: string; active: boolean }>();
  const { data } = await db
    .from("staff")
    .select("id, user_id, display_name, active")
    .eq("organization_id", orgId)
    .in("id", ids);
  return new Map(
    (
      (data ?? []) as Array<{
        id: string;
        user_id: string | null;
        display_name: string | null;
        active: boolean | null;
      }>
    ).map((s) => [
      s.id,
      {
        user_id: s.user_id,
        display_name: (s.display_name ?? "").trim() || "A tech",
        active: s.active !== false,
      },
    ]),
  );
}

// ── The tech's day, as a dispatcher changes it ─────────────────────────────

const ROUTE_COLS =
  "id, assigned_staff_id, scheduled_on, status, sequence, eta_start, clients(display_name), properties(street, city)";

function toRouteRow(v: any): RouteRow {
  return {
    id: v.id,
    assigned_staff_id: v.assigned_staff_id ?? null,
    scheduled_on: v.scheduled_on,
    status: v.status,
    sequence: v.sequence ?? null,
    eta_start: v.eta_start ?? null,
    client: one(v.clients)?.display_name ?? null,
    address: addressOf(one(v.properties)),
  };
}

const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The open stops these visits are, and every stop on these techs' today and
 *  tomorrow. Chunked: five hundred ids in one query string is past what a
 *  URL can carry. */
async function snapshot(
  db: Admin,
  clock: OrgClock,
  visitIds: string[],
  staffIds: string[],
): Promise<RouteRow[]> {
  const out = new Map<string, RouteRow>();
  for (const ids of chunks([...new Set(visitIds)], 100)) {
    const { data, error } = await db
      .from("visits")
      .select(ROUTE_COLS)
      .eq("organization_id", clock.orgId)
      .in("id", ids);
    if (error) throw new Error(error.message);
    for (const v of data ?? []) out.set(v.id, toRouteRow(v));
  }
  const staff = [...new Set(staffIds)];
  if (staff.length) {
    const { data, error } = await db
      .from("visits")
      .select(ROUTE_COLS)
      .eq("organization_id", clock.orgId)
      .in("assigned_staff_id", staff)
      .in("scheduled_on", [clock.today, clock.tomorrow]);
    if (error) throw new Error(error.message);
    for (const v of data ?? []) out.set(v.id, toRouteRow(v));
  }
  return [...out.values()];
}

async function stopsOnDay(
  db: Admin,
  orgId: string,
  staffId: string,
  day: string,
): Promise<number | null> {
  const { count, error } = await db
    .from("visits")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("assigned_staff_id", staffId)
    .eq("scheduled_on", day)
    .neq("status", "canceled");
  return error ? null : (count ?? null);
}

/** Tell each tech whose today or tomorrow changed, once, in their language.
 *  `push: false` files it in the notification centre without buzzing the
 *  phone (the nightly run, outside working hours). */
async function notifyRouteChanges(
  db: Admin,
  clock: OrgClock,
  changes: RouteChange[],
  actorUserId: string | null,
  push?: boolean,
): Promise<void> {
  if (!changes.length) return;
  const staff = await staffRows(db, clock.orgId, [...new Set(changes.map((c) => c.staffId))]);
  const { notifyUsers } = await import("@/lib/notify-center.server");
  const { techT } = await import("@/lib/tech-push-i18n");
  for (const change of changes) {
    const s = staff.get(change.staffId);
    // Nobody to tell, or the tech moved their own day.
    if (!s?.user_id || !s.active || s.user_id === actorUserId) continue;
    const t = techT(await languageOf(db, s.user_id));
    const kind = change.day === clock.today ? "today" : "tomorrow";
    const total = await stopsOnDay(db, clock.orgId, change.staffId, change.day);
    const notice = techRouteNotice(t, change, kind, total);
    await notifyUsers([s.user_id], {
      orgId: clock.orgId,
      type: notice.type,
      title: notice.title,
      body: notice.body,
      link: notice.link,
      threadId: routeThreadId(change.staffId, change.day),
      collapseId: notice.collapseId,
      exceptUserId: actorUserId,
      ...(push === false ? { push: false } : {}),
      coalesce: {
        windowMs: ROUTE_COALESCE_MS,
        ...coalescedRouteNotice(t, change.day, kind, total),
      },
    });
  }
}

/** A tech's day, by staff id and calendar day. */
export type TechDay = { staffId: string; day: string };

export type RouteWatch = {
  /** Call after the change has been written. Extra visit ids are ones the
   *  change created (a one-off booked straight onto a route). Answers which
   *  tech-days changed, for a caller that has a lock screen to refresh and no
   *  visit ids to find them by (the nightly generation). Never throws. */
  finish: (extra?: { visitIds?: string[] }) => Promise<TechDay[]>;
};

const NO_WATCH: RouteWatch = { finish: async () => [] };

/**
 * Look at the affected techs' today and tomorrow before a dispatcher's
 * change, and again after, and tell each tech what moved. Every server
 * function that moves work onto, off or around a tech's day wraps its write
 * in one of these, rather than each describing its own change: a reassign, a
 * drag, a bulk move, a reschedule, a cancel, the optimizer and a one-off
 * booking all reduce to "these stops were here, and now they are there", and
 * one diff says that the same way for all of them.
 *
 * `visitIds` are the visits being moved; `staffIds` the techs whose whole
 * day is being rewritten (a reorder, the optimizer, redistributing someone's
 * work). Only today and tomorrow, in the organization's calendar: a change to
 * next Thursday is something the tech will see when they look at next
 * Thursday, not a reason to buzz a phone.
 */
export async function startRouteWatch(input: {
  actorUserId: string | null;
  orgId?: string | null;
  visitIds?: string[];
  staffIds?: string[];
  /** false: in the notification centre only, no push. For a system job that
   *  runs while the tech is asleep. Default: each type's own rule. */
  push?: boolean;
}): Promise<RouteWatch> {
  try {
    const db = await admin();
    const orgId = input.orgId ?? (await orgOfUser(db, input.actorUserId));
    if (!orgId) return NO_WATCH;
    const clock = await orgClock(db, orgId);
    const visitIds = input.visitIds ?? [];
    const staffIds = input.staffIds ?? [];
    const before = await snapshot(db, clock, visitIds, staffIds);
    return {
      finish: async (extra) => {
        try {
          const ids = [...before.map((r) => r.id), ...visitIds, ...(extra?.visitIds ?? [])];
          const after = await snapshot(db, clock, ids, staffIds);
          const changes = diffRoutes(before, after, [clock.today, clock.tomorrow]);
          await notifyRouteChanges(db, clock, changes, input.actorUserId, input.push);
          return changes.map((c) => ({ staffId: c.staffId, day: c.day }));
        } catch (e) {
          console.warn("[field-notify] route change not told", e);
          return [];
        }
      },
    };
  } catch (e) {
    console.warn("[field-notify] route watch could not start", e);
    return NO_WATCH;
  }
}

// ── Access to a stop today ─────────────────────────────────────────────────

/** The gate code, the do-not-enter rule or the hazard notes changed on a
 *  property that a tech is going to today: tell that tech. */
export async function notifyAccessChanged(input: {
  propertyId: string;
  before: AccessFields;
  after: AccessFields;
  actorUserId: string | null;
}): Promise<void> {
  try {
    const changes = accessChanges(input.before, input.after);
    if (!changes.length) return;
    const db = await admin();
    const { data: prop } = await db
      .from("properties")
      .select("organization_id, street, city, clients(display_name)")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (!prop) return;
    const clock = await orgClock(db, prop.organization_id);
    const { data: visits } = await db
      .from("visits")
      .select("id, assigned_staff_id")
      .eq("organization_id", clock.orgId)
      .eq("property_id", input.propertyId)
      .eq("scheduled_on", clock.today)
      .in("status", ["scheduled", "in_progress"]);
    const list = ((visits ?? []) as Array<{ id: string; assigned_staff_id: string | null }>).filter(
      (v) => v.assigned_staff_id,
    );
    if (!list.length) return;
    const staff = await staffRows(
      db,
      clock.orgId,
      list.map((v) => v.assigned_staff_id!),
    );
    const { notifyUsers } = await import("@/lib/notify-center.server");
    const { techT } = await import("@/lib/tech-push-i18n");
    for (const v of list) {
      const s = staff.get(v.assigned_staff_id!);
      if (!s?.user_id || !s.active || s.user_id === input.actorUserId) continue;
      const t = techT(await languageOf(db, s.user_id));
      const notice = accessNotice(
        t,
        {
          visitId: v.id,
          day: clock.today,
          client: one(prop.clients)?.display_name,
          address: addressOf(prop),
        },
        changes,
      );
      await notifyUsers([s.user_id], {
        orgId: clock.orgId,
        type: notice.type,
        title: notice.title,
        body: notice.body,
        link: notice.link,
        threadId: visitThreadId(v.id),
        collapseId: notice.collapseId,
        exceptUserId: input.actorUserId,
        // The office saving the form twice is one notification, updated.
        coalesce: {
          windowMs: ROUTE_COALESCE_MS,
          title: notice.title,
          body: notice.body,
          link: notice.link,
        },
      });
    }
  } catch (e) {
    console.warn("[field-notify] access change not told", e);
  }
}

// ── A stop skipped, a route finished, the next stop late ───────────────────

const STOP_COLS =
  "id, organization_id, assigned_staff_id, scheduled_on, status, sequence, eta_end, travel_min, skip_reason, skip_reason_code, clients(display_name), properties(street, city, latitude, longitude)";

type Stop = {
  id: string;
  organization_id: string;
  assigned_staff_id: string | null;
  scheduled_on: string;
  status: string;
  sequence: number | null;
  eta_end: string | null;
  travel_min: number | null;
  skip_reason: string | null;
  skip_reason_code: string | null;
  clients: unknown;
  properties: unknown;
};

async function loadStop(db: Admin, visitId: string): Promise<Stop | null> {
  const { data } = await db.from("visits").select(STOP_COLS).eq("id", visitId).maybeSingle();
  return (data as Stop | null) ?? null;
}

const clientOf = (v: Stop) =>
  (one(v.clients as any) as { display_name?: string | null } | null)?.display_name?.trim() ||
  "a customer";
const propOf = (v: Stop) =>
  one(v.properties as any) as {
    street?: string | null;
    city?: string | null;
    latitude?: number | null;
    longitude?: number | null;
  } | null;

/** A tech skipped a stop: tell the office, with the reason, and then do what
 *  any resolved stop does (afterStopResolved). */
export async function notifyVisitSkipped(input: {
  visitId: string;
  actorUserId: string | null;
}): Promise<void> {
  try {
    const db = await admin();
    const v = await loadStop(db, input.visitId);
    if (!v || v.status !== "skipped" || !v.assigned_staff_id) return;
    const staff = await staffRows(db, v.organization_id, [v.assigned_staff_id]);
    const name = staff.get(v.assigned_staff_id)?.display_name ?? "A tech";
    const { SKIP_REASON_LABELS } = await import("@/lib/skip-rules.functions");
    const label =
      (SKIP_REASON_LABELS as Record<string, string>)[v.skip_reason_code ?? ""] ?? "Skipped";
    const reason = (v.skip_reason ?? "").trim().slice(0, 160);
    const address = addressOf(propOf(v));
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles([...OFFICE], {
      orgId: v.organization_id,
      type: FIELD_TYPES.skipped,
      title: `${name} skipped ${clientOf(v)}`,
      body: [
        reason && reason.toLowerCase() !== label.toLowerCase() ? `${label}: ${reason}` : label,
        address,
      ]
        .filter(Boolean)
        .join(". "),
      link: myDayLink({ day: v.scheduled_on, staffId: v.assigned_staff_id, visitId: v.id }),
      threadId: routeThreadId(v.assigned_staff_id, v.scheduled_on),
      collapseId: visitThreadId(v.id),
      // A skip replayed from the offline queue is the same skip.
      eventKey: `skip:${v.id}`,
      exceptUserId: input.actorUserId,
    });
  } catch (e) {
    console.warn("[field-notify] skip not told", e);
  }
  await afterStopResolved(input);
}

/**
 * A stop is done or skipped. Two things can follow, and both are about the
 * same tech-day:
 *
 *   the route is finished, when nothing on it is left open -- the office
 *   hears "Taylor finished 12 of 12, 1 skipped", in-app only unless a stop
 *   was skipped (see field-notify.ts);
 *
 *   or the NEXT stop is going to be late: the tech is leaving now, the drive
 *   is the planner's travel_min for that stop (or the planner's estimate from
 *   here), and if that lands past the arrival window the office hears it
 *   before the customer does. This is the check that needs no GPS.
 */
export async function afterStopResolved(input: {
  visitId: string;
  actorUserId: string | null;
}): Promise<void> {
  try {
    const db = await admin();
    const v = await loadStop(db, input.visitId);
    if (!v?.assigned_staff_id || (v.status !== "completed" && v.status !== "skipped")) return;
    const clock = await orgClock(db, v.organization_id);
    if (v.scheduled_on > clock.today) return;
    const { data: dayRows } = await db
      .from("visits")
      .select(STOP_COLS)
      .eq("organization_id", v.organization_id)
      .eq("assigned_staff_id", v.assigned_staff_id)
      .eq("scheduled_on", v.scheduled_on);
    const day = (dayRows ?? []) as Stop[];
    const tally = tallyDay(day);
    const staff = await staffRows(db, v.organization_id, [v.assigned_staff_id]);
    const name = staff.get(v.assigned_staff_id)?.display_name ?? "A tech";
    const { notifyRoles } = await import("@/lib/notify-center.server");

    if (tally.total > 0 && tally.open === 0) {
      const skipped = day.filter((r) => r.status === "skipped" || r.status === "missed");
      const names = skipped.slice(0, 3).map(clientOf);
      await notifyRoles([...OFFICE], {
        orgId: v.organization_id,
        type: FIELD_TYPES.finished,
        title: finishedTitle(name, tally),
        body: skipped.length
          ? `Skipped: ${names.join(", ")}${skipped.length > names.length ? ` and ${skipped.length - names.length} more` : ""}.`
          : "Every stop done.",
        link: myDayLink({ day: v.scheduled_on, staffId: v.assigned_staff_id }),
        threadId: routeThreadId(v.assigned_staff_id, v.scheduled_on),
        collapseId: `finished:${v.assigned_staff_id}:${v.scheduled_on}`,
        // The total is in the key: a stop added after the route was finished,
        // and then done, is a second "finished" worth hearing.
        eventKey: `finished:${v.assigned_staff_id}:${v.scheduled_on}:${tally.total}`,
        push: skipped.length > 0,
        exceptUserId: input.actorUserId,
      });
      return;
    }

    // Lateness is about today: a replayed completion from yesterday says
    // nothing about where the truck is now.
    if (v.scheduled_on !== clock.today) return;
    const next = day
      .filter((r) => r.status === "scheduled" && r.eta_end)
      .sort(
        (a, b) =>
          (a.sequence ?? Number.MAX_SAFE_INTEGER) - (b.sequence ?? Number.MAX_SAFE_INTEGER) ||
          String(a.eta_end).localeCompare(String(b.eta_end)),
      )[0];
    if (!next) return;
    const here = propOf(v);
    const there = propOf(next);
    const drive =
      next.travel_min != null
        ? Number(next.travel_min)
        : here?.latitude != null &&
            here?.longitude != null &&
            there?.latitude != null &&
            there?.longitude != null
          ? estimateDriveMin(
              { lat: here.latitude, lng: here.longitude },
              { lat: there.latitude, lng: there.longitude },
              clock.speedKmh,
              clock.roadFactor,
            )
          : 0;
    await tellIfLate(next, name, clock, new Date(Date.now() + drive * 60_000), input.actorUserId);
  } catch (e) {
    console.warn("[field-notify] finished/late check failed", e);
  }
}

/** The office hears a stop will be late: once per stop, again only when it
 *  slips another LATE_STEP_MIN. Answers how many people were pushed. */
async function tellIfLate(
  v: Stop,
  techName: string,
  clock: OrgClock,
  projected: Date,
  actorUserId: string | null,
): Promise<number> {
  if (!v.assigned_staff_id) return 0;
  const late = minutesLate(v.eta_end, projected);
  if (late == null) return 0;
  const { notifyRoles } = await import("@/lib/notify-center.server");
  const address = addressOf(propOf(v));
  const told = await notifyRoles([...OFFICE], {
    orgId: v.organization_id,
    type: FIELD_TYPES.late,
    title: `${techName} is running about ${roundLate(late)} min late`,
    body: [
      `${clientOf(v)}${address ? `, ${address}` : ""}`,
      `Arrival window ends ${orgLocalTime(v.eta_end, clock.tz)}`,
    ].join(". "),
    link: myDayLink({ day: v.scheduled_on, staffId: v.assigned_staff_id, visitId: v.id }),
    threadId: routeThreadId(v.assigned_staff_id, v.scheduled_on),
    // A newer estimate for the same stop replaces the older one on the phone.
    collapseId: `late:${v.id}`,
    eventKey: `late:${v.id}:${lateStep(late)}`,
    exceptUserId: actorUserId,
  });
  return told.pushed.length;
}

/**
 * The tech's phone reported where it is, on the way to a stop the customer
 * was told about ("on my way", live tracking). If the drive from here lands
 * after the arrival window, the office hears it -- once per stop per slip,
 * however many pings arrive (the event key, and the memo in front of it).
 *
 * One query on a ping whose stop is hours off (the visit with its
 * property), one more inside that (the organization's clock and speed),
 * then arithmetic; the name and the roles are read only when it IS late.
 */
export async function checkRunningLateFromPosition(input: {
  visitId: string;
  lat: number;
  lng: number;
  actorUserId: string | null;
}): Promise<void> {
  try {
    const db = await admin();
    const v = await loadStop(db, input.visitId);
    if (!v || v.status !== "scheduled" || !v.eta_end || !v.assigned_staff_id) return;
    const there = propOf(v);
    if (there?.latitude == null || there?.longitude == null) return;
    // A window more than three hours off cannot be missed from anywhere a
    // scooping route drives: a ping that early stops here, on one query.
    const now = Date.now();
    if (Date.parse(v.eta_end) - now > 3 * 60 * 60_000) return;
    const clock = await orgClock(db, v.organization_id);
    if (v.scheduled_on !== clock.today) return;
    const drive = estimateDriveMin(
      input,
      { lat: there.latitude, lng: there.longitude },
      clock.speedKmh,
      clock.roadFactor,
    );
    const projected = new Date(now + drive * 60_000);
    // On time: no name to look up, nothing to tell.
    if (minutesLate(v.eta_end, projected) == null) return;
    const staff = await staffRows(db, v.organization_id, [v.assigned_staff_id]);
    await tellIfLate(
      v,
      staff.get(v.assigned_staff_id)?.display_name ?? "A tech",
      clock,
      projected,
      input.actorUserId,
    );
  } catch (e) {
    console.warn("[field-notify] late check from position failed", e);
  }
}

// ── A truck that never moved ───────────────────────────────────────────────

/** At most this many open stops are read per run. Comfortably more than
 *  every tech on the platform has inside a five-hour band; if it is ever
 *  reached, the earliest windows are read first and the run says it capped. */
export const LATE_CHECK_CANDIDATE_CAP = 500;
/** At most this many stops are announced late per run. The rest are still
 *  late in five minutes, and are told then. */
export const LATE_CHECK_TELL_CAP = 100;

export type StuckTruckSummary = {
  /** Open stops with a window inside the band, before any per-org rule. */
  candidates: number;
  /** Organizations whose clock is inside their working day right now. */
  orgsInHours: number;
  /** Tech-days whose next stop was checked. */
  checked: number;
  /** Next stops that will be reached after their window (and grace). */
  late: number;
  /** People pushed this run. A slip already told is not told again. */
  pushed: number;
  /** Next stops passed over because the tech is off or inactive today. */
  off: number;
  capped: boolean;
};

const ORG_COLS = `id, ${CLOCK_COLS}, workday_start, workday_end, latitude, longitude`;

type At = { lat: number; lng: number } | null;
const at = (lat: unknown, lng: unknown): At =>
  lat != null && lng != null && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
    ? { lat: Number(lat), lng: Number(lng) }
    : null;

/**
 * The periodic half of late detection, for the truck that sends nothing: a
 * tech at one long stop with location sharing off produces neither a GPS ping
 * nor a finished stop, so neither trigger above fires and the office learns
 * the next stop was late from the customer. Run every five minutes by the
 * `late-check` cron job through /api/public/hooks/late-check.
 *
 * For each tech with a route TODAY on their organization's calendar, inside
 * that organization's working day: take the next scheduled stop with an
 * arrival window, and the drive to it from where the truck is (the stop in
 * progress, else the last one finished, else the start of the day). If now
 * plus that drive is past the end of the window plus LATE_GRACE_MIN, the
 * office hears it through tellIfLate: the same text, collapse key and event
 * key `late:<visitId>:<step>` the other two triggers use, so a slip the GPS
 * or a finished stop already announced is not announced again, and running
 * twice at once is one notification (the event key is a unique index).
 *
 * Bounded: one query for candidates (scheduled, assigned, a window between
 * LATE_GIVE_UP_MIN ago and LATE_LOOKAHEAD_MIN ahead), then one each for their
 * organizations, techs, time off and where those techs' trucks are, all
 * keyed on the candidates. No road router: the drive is the planner's own
 * travel_min, else its straight-line estimate, as afterStopResolved does.
 */
export async function checkStuckTrucks(opts: { now?: Date } = {}): Promise<StuckTruckSummary> {
  const now = opts.now ?? new Date();
  const summary: StuckTruckSummary = {
    candidates: 0,
    orgsInHours: 0,
    checked: 0,
    late: 0,
    pushed: 0,
    off: 0,
    capped: false,
  };
  const db = await admin();
  const ms = now.getTime();
  const utcToday = now.toISOString().slice(0, 10);

  // 1. Every open, assigned stop whose window closes inside the band. The
  //    calendar day is narrowed to the three that can be "today" somewhere,
  //    and settled per organization below.
  const { data: rows, error } = await db
    .from("visits")
    .select(STOP_COLS)
    .eq("status", "scheduled")
    .not("assigned_staff_id", "is", null)
    .gte("eta_end", new Date(ms - LATE_GIVE_UP_MIN * 60_000).toISOString())
    .lte("eta_end", new Date(ms + LATE_LOOKAHEAD_MIN * 60_000).toISOString())
    .in("scheduled_on", [addDay(utcToday, -1), utcToday, addDay(utcToday, 1)])
    .order("eta_end", { ascending: true })
    .limit(LATE_CHECK_CANDIDATE_CAP);
  if (error) throw new Error(error.message);
  const candidates = (rows ?? []) as Stop[];
  summary.candidates = candidates.length;
  summary.capped = candidates.length >= LATE_CHECK_CANDIDATE_CAP;
  if (!candidates.length) return summary;

  // 2. Their organizations: the clock, the working day, the speed.
  const { data: orgRows, error: orgErr } = await db
    .from("organizations")
    .select(ORG_COLS)
    .in("id", [...new Set(candidates.map((v) => v.organization_id))]);
  if (orgErr) throw new Error(orgErr.message);
  const orgs = new Map<string, { clock: OrgClock; base: At }>();
  for (const o of (orgRows ?? []) as Array<Record<string, any>>) {
    const clock = clockOf(o.id, o, now);
    if (!withinWorkingHours(orgLocalMinutes(now, clock.tz), o.workday_start, o.workday_end)) {
      continue;
    }
    orgs.set(o.id, { clock, base: at(o.latitude, o.longitude) });
  }
  summary.orgsInHours = orgs.size;
  const today = candidates.filter(
    (v) => orgs.get(v.organization_id)?.clock.today === v.scheduled_on,
  );
  const next = nextStopPerTechDay(today);
  if (!next.length) return summary;

  // 3. The techs, whether any is off today, and where each truck is.
  const staffIds = [...new Set(next.map((v) => v.assigned_staff_id!))];
  const days = [...new Set(next.map((v) => v.scheduled_on))].sort();
  const [{ data: staffData }, { data: offData }, { data: doneData }] = await Promise.all([
    db
      .from("staff")
      .select("id, display_name, active, start_latitude, start_longitude")
      .in("id", staffIds),
    db
      .from("staff_time_off")
      .select("staff_id, starts_on, ends_on")
      .in("staff_id", staffIds)
      .lte("starts_on", days[days.length - 1])
      .gte("ends_on", days[0]),
    db
      .from("visits")
      .select(
        "id, assigned_staff_id, scheduled_on, status, started_at, completed_at, properties(latitude, longitude)",
      )
      .in("assigned_staff_id", staffIds)
      .in("scheduled_on", days)
      .in("status", ["in_progress", "completed"]),
  ]);
  const staff = new Map(
    ((staffData ?? []) as Array<Record<string, any>>).map((s) => [s.id as string, s]),
  );
  const off = (staffId: string, day: string) =>
    ((offData ?? []) as Array<{ staff_id: string; starts_on: string; ends_on: string }>).some(
      (t) => t.staff_id === staffId && t.starts_on <= day && t.ends_on >= day,
    );
  const done = (doneData ?? []) as Array<{
    assigned_staff_id: string;
    scheduled_on: string;
    status: string;
    started_at: string | null;
    completed_at: string | null;
    properties: unknown;
  }>;

  // 4. The arithmetic, and the office told about each late one.
  for (const v of next) {
    const staffId = v.assigned_staff_id!;
    const s = staff.get(staffId);
    if (!s || s.active === false || off(staffId, v.scheduled_on)) {
      summary.off++;
      continue;
    }
    summary.checked++;
    const org = orgs.get(v.organization_id)!;
    const truck = whereTheTruckIs(
      done.filter((d) => d.assigned_staff_id === staffId && d.scheduled_on === v.scheduled_on),
    );
    const truckAt = truck
      ? (() => {
          const p = one(truck.properties as any) as {
            latitude?: number;
            longitude?: number;
          } | null;
          return at(p?.latitude, p?.longitude);
        })()
      : null;
    const from = truckAt ?? at(s.start_latitude, s.start_longitude) ?? org.base;
    const there = propOf(v);
    const to = at(there?.latitude, there?.longitude);
    const drive =
      v.travel_min != null
        ? Number(v.travel_min)
        : from && to
          ? estimateDriveMin(from, to, org.clock.speedKmh, org.clock.roadFactor)
          : 0;
    const projected = new Date(ms + drive * 60_000);
    if (minutesLate(v.eta_end, projected) == null) continue;
    summary.late++;
    if (summary.late > LATE_CHECK_TELL_CAP) {
      summary.capped = true;
      continue;
    }
    const name = String(s.display_name ?? "").trim() || "A tech";
    summary.pushed += await tellIfLate(v, name, org.clock, projected, null);
  }
  return summary;
}

// ── Cash or a check ────────────────────────────────────────────────────────

/** A tech recorded cash or a check: the owner and office managers confirm it,
 *  so they are told, and their phones buzz. This replaced the INSERT that
 *  record_field_collection did in SQL, whose rows could never reach a phone
 *  (20261004150000). Keyed on the collection, so the replay the offline queue
 *  sends after a lost response -- which the RPC answers with the same id --
 *  tells nobody twice. Dispatchers are not told: they cannot confirm money. */
export async function notifyFieldCollection(input: {
  collectionId: string;
  actorUserId: string | null;
}): Promise<void> {
  try {
    const db = await admin();
    const { data: fc } = await db
      .from("field_collections")
      .select(
        "id, organization_id, amount_cents, method, reference, collected_by_staff_id, clients(display_name), visits(scheduled_on)",
      )
      .eq("id", input.collectionId)
      .maybeSingle();
    if (!fc) return;
    const staff = await staffRows(
      db,
      fc.organization_id,
      fc.collected_by_staff_id ? [fc.collected_by_staff_id] : [],
    );
    const name = staff.get(fc.collected_by_staff_id)?.display_name ?? "A tech";
    const client = (one(fc.clients)?.display_name ?? "").trim() || "a customer";
    const how = fc.method === "cash" ? "cash" : fc.reference ? `check #${fc.reference}` : "a check";
    const amount = `$${(Number(fc.amount_cents) / 100).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
    const day = one(fc.visits)?.scheduled_on as string | undefined;
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles(["owner", "office_manager"], {
      orgId: fc.organization_id,
      type: FIELD_TYPES.collection,
      title: `${name} collected ${amount} (${how})`,
      body: `From ${client}. Confirm it on Invoices to apply it to their open invoices.`,
      link: "/invoices#field-collections",
      threadId:
        fc.collected_by_staff_id && day
          ? routeThreadId(fc.collected_by_staff_id, day)
          : `collection:${fc.id}`,
      collapseId: `collection:${fc.id}`,
      eventKey: `field_collection:${fc.id}`,
      exceptUserId: input.actorUserId,
    });
  } catch (e) {
    console.warn("[field-notify] collection not told", e);
  }
}
