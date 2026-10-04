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
  lateStep,
  minutesLate,
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
import { DEFAULT_ORG_TIMEZONE, orgLocalTime, orgToday } from "@/lib/org-day";

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

async function orgClock(db: Admin, orgId: string, now = new Date()): Promise<OrgClock> {
  const { data: org } = await db
    .from("organizations")
    .select("timezone, avg_speed_kmh, measured_speed_kmh, road_factor, measured_road_factor")
    .eq("id", orgId)
    .maybeSingle();
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

const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));

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
  if (!ids.length) return new Map<string, { user_id: string | null; display_name: string; active: boolean }>();
  const { data } = await db
    .from("staff")
    .select("id, user_id, display_name, active")
    .eq("organization_id", orgId)
    .in("id", ids);
  return new Map(
    ((data ?? []) as Array<{ id: string; user_id: string | null; display_name: string | null; active: boolean | null }>).map(
      (s) => [s.id, { user_id: s.user_id, display_name: (s.display_name ?? "").trim() || "A tech", active: s.active !== false }],
    ),
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

const chunks = <T,>(xs: T[], n: number) =>
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

async function stopsOnDay(db: Admin, orgId: string, staffId: string, day: string): Promise<number | null> {
  const { count, error } = await db
    .from("visits")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("assigned_staff_id", staffId)
    .eq("scheduled_on", day)
    .neq("status", "canceled");
  return error ? null : (count ?? null);
}

/** Tell each tech whose today or tomorrow changed, once, in their language. */
async function notifyRouteChanges(
  db: Admin,
  clock: OrgClock,
  changes: RouteChange[],
  actorUserId: string | null,
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
      coalesce: { windowMs: ROUTE_COALESCE_MS, ...coalescedRouteNotice(t, change.day, kind, total) },
    });
  }
}

export type RouteWatch = {
  /** Call after the change has been written. Extra visit ids are ones the
   *  change created (a one-off booked straight onto a route). Never throws. */
  finish: (extra?: { visitIds?: string[] }) => Promise<void>;
};

const NO_WATCH: RouteWatch = { finish: async () => {} };

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
          await notifyRouteChanges(db, clock, changes, input.actorUserId);
        } catch (e) {
          console.warn("[field-notify] route change not told", e);
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
    const staff = await staffRows(db, clock.orgId, list.map((v) => v.assigned_staff_id!));
    const { notifyUsers } = await import("@/lib/notify-center.server");
    const { techT } = await import("@/lib/tech-push-i18n");
    for (const v of list) {
      const s = staff.get(v.assigned_staff_id!);
      if (!s?.user_id || !s.active || s.user_id === input.actorUserId) continue;
      const t = techT(await languageOf(db, s.user_id));
      const notice = accessNotice(
        t,
        { visitId: v.id, day: clock.today, client: one(prop.clients)?.display_name, address: addressOf(prop) },
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
        coalesce: { windowMs: ROUTE_COALESCE_MS, title: notice.title, body: notice.body, link: notice.link },
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

const clientOf = (v: Stop) => (one(v.clients as any) as { display_name?: string | null } | null)?.display_name?.trim() || "a customer";
const propOf = (v: Stop) =>
  one(v.properties as any) as { street?: string | null; city?: string | null; latitude?: number | null; longitude?: number | null } | null;

/** A tech skipped a stop: tell the office, with the reason, and then do what
 *  any resolved stop does (afterStopResolved). */
export async function notifyVisitSkipped(input: { visitId: string; actorUserId: string | null }): Promise<void> {
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
export async function afterStopResolved(input: { visitId: string; actorUserId: string | null }): Promise<void> {
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
        : here?.latitude != null && here?.longitude != null && there?.latitude != null && there?.longitude != null
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
 *  slips another LATE_STEP_MIN. */
async function tellIfLate(
  v: Stop,
  techName: string,
  clock: OrgClock,
  projected: Date,
  actorUserId: string | null,
): Promise<void> {
  if (!v.assigned_staff_id) return;
  const late = minutesLate(v.eta_end, projected);
  if (late == null) return;
  const { notifyRoles } = await import("@/lib/notify-center.server");
  const address = addressOf(propOf(v));
  await notifyRoles([...OFFICE], {
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
    const staff = await staffRows(db, fc.organization_id, fc.collected_by_staff_id ? [fc.collected_by_staff_id] : []);
    const name = staff.get(fc.collected_by_staff_id)?.display_name ?? "A tech";
    const client = (one(fc.clients)?.display_name ?? "").trim() || "a customer";
    const how =
      fc.method === "cash" ? "cash" : fc.reference ? `check #${fc.reference}` : "a check";
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
        fc.collected_by_staff_id && day ? routeThreadId(fc.collected_by_staff_id, day) : `collection:${fc.id}`,
      collapseId: `collection:${fc.id}`,
      eventKey: `field_collection:${fc.id}`,
      exceptUserId: input.actorUserId,
    });
  } catch (e) {
    console.warn("[field-notify] collection not told", e);
  }
}
