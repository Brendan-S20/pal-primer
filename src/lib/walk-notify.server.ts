/** Client emails when a dog walk does not happen or moves (#410).
 *
 *    notifyWalkNotDone       a walker skipped it (skipVisit), or the nightly
 *                            job marked it missed (notifyMissedWalks)
 *    watchWalkSchedule       the office moved one or more visits
 *                            (rescheduleVisitFromOffice, bulkRescheduleVisits),
 *                            or moved them for weather (rescheduleVisits)
 *    notifyWalkPlanChanged   the office changed a walk plan's days or window
 *                            (updateSubscription)
 *    notifyWalksCanceled     the office canceled one or more upcoming walks
 *                            (cancelVisitFromOffice, notifyCanceledWalks)
 *
 *  Every one of them reads the service line first and does nothing for a
 *  visit or plan that is not a dog walk, so a pet-waste client is sent
 *  exactly what they were before. Each is best-effort and never throws: the
 *  change has already happened, and an email that could not go must not
 *  turn it into an error. enqueueAppEmail honours the org's switch
 *  (notifyKey), the client's opt-out and the comms hold, as it does for every
 *  other client email. Reads are the service role's, scoped by the ids the
 *  caller already passed its own permission check for. */

import { dogNamesPhrase } from "@/lib/walk-report";
import {
  SCHEDULE_LINES_MAX,
  canceledWalkLabel,
  walkPlanScheduleChanged,
  walkScheduleLine,
  walkSkipReason,
  type WalkNotDoneKind,
  type WalkScheduleLine,
  type WalkSlot,
} from "@/lib/walk-notify";
import { formatDay } from "@/lib/format";

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

type VisitRow = {
  id: string;
  organization_id: string;
  client_id: string;
  scheduled_on: string;
  status: string;
  skip_reason_code: string | null;
  subscription_id: string | null;
  services: { service_line: string | null } | { service_line: string | null }[] | null;
  subscriptions:
    | { earliest_time: string | null; latest_time: string | null }
    | { earliest_time: string | null; latest_time: string | null }[]
    | null;
  properties:
    | {
        visit_contact_email: string | null;
        dogs: { name: string | null; active: boolean | null }[] | null;
      }
    | {
        visit_contact_email: string | null;
        dogs: { name: string | null; active: boolean | null }[] | null;
      }[]
    | null;
};

/** Exported for the real-database test, which reads a canceled walk with it. */
export const VISIT_COLUMNS =
  "id, organization_id, client_id, scheduled_on, status, skip_reason_code, subscription_id, services(service_line), subscriptions(earliest_time, latest_time), properties(visit_contact_email, dogs(name, active))";

const isWalk = (v: Pick<VisitRow, "services">) => one(v.services)?.service_line === "dog_walking";

function slotOf(v: VisitRow): WalkSlot {
  const s = one(v.subscriptions);
  return { day: v.scheduled_on, earliest: s?.earliest_time ?? null, latest: s?.latest_time ?? null };
}

// ── Skipped or missed ───────────────────────────────────────────────────────

export async function notifyWalkNotDone(opts: {
  visitId: string;
  kind: WalkNotDoneKind;
}): Promise<void> {
  try {
    const sb = await admin();
    const { data } = await sb.from("visits").select(VISIT_COLUMNS).eq("id", opts.visitId).maybeSingle();
    const v = data as VisitRow | null;
    if (!v || !isWalk(v)) return;
    if (v.status !== opts.kind) return;
    await sendWalkNotDone(v, opts.kind);
  } catch (e) {
    console.warn("walk-not-done email failed", opts.visitId, e);
  }
}

async function sendWalkNotDone(v: VisitRow, kind: WalkNotDoneKind): Promise<void> {
  const prop = one(v.properties);
  const dogs = dogNamesPhrase((prop?.dogs ?? []).filter((d) => d.active !== false).map((d) => d.name));
  const day = formatDay(v.scheduled_on);
  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  await enqueueAppEmail({
    organizationId: v.organization_id,
    clientId: v.client_id,
    templateName: "walk-not-done",
    notifyKey: "notify_email_walk_not_done",
    // One per walk: a replayed skip is the same skip, and a missed walk is
    // looked at by more than one nightly run.
    idempotencyKey: `walk-${kind}-${v.id}`,
    oncePerKey: true,
    toOverride: prop?.visit_contact_email || undefined,
    templateData: {
      kind,
      dogs,
      day,
      ...(kind === "skipped" ? { reason: walkSkipReason(v.skip_reason_code) } : {}),
    },
  });
}

/** The nightly run, after admin_transition_missed_visits: every dog walk that
 *  became missed in the last few days, once each (oncePerKey). Returns how
 *  many were looked at, for the run's report. */
export async function notifyMissedWalks(orgId: string, today: string): Promise<number> {
  try {
    const sb = await admin();
    const since = new Date(`${today}T00:00:00Z`);
    since.setUTCDate(since.getUTCDate() - 3);
    const { data } = await sb
      .from("visits")
      .select(VISIT_COLUMNS)
      .eq("organization_id", orgId)
      .eq("status", "missed")
      .gte("scheduled_on", since.toISOString().slice(0, 10))
      .lt("scheduled_on", today)
      .limit(500);
    const walks = ((data ?? []) as VisitRow[]).filter(isWalk);
    for (const v of walks) {
      try {
        await sendWalkNotDone(v, "missed");
      } catch (e) {
        console.warn("missed-walk email failed", v.id, e);
      }
    }
    return walks.length;
  } catch (e) {
    console.warn("missed-walk emails failed", orgId, e);
    return 0;
  }
}

// ── The office moved a walk ─────────────────────────────────────────────────

/** Read the walks among `visitIds` before a move; `finish` reads them after
 *  and emails each client once with what changed. Not a dog walk, or nothing
 *  a client reads changed: nothing is sent. `walkIds` is the walks it read,
 *  so a caller with its own email (the weather move) can leave them out. */
export async function watchWalkSchedule(visitIds: readonly string[]): Promise<{
  walkIds: ReadonlySet<string>;
  finish: (actionKey: string) => Promise<void>;
}> {
  let before = new Map<string, VisitRow>();
  try {
    if (visitIds.length > 0) {
      const sb = await admin();
      const { data } = await sb.from("visits").select(VISIT_COLUMNS).in("id", [...visitIds]);
      before = new Map(((data ?? []) as VisitRow[]).filter(isWalk).map((v) => [v.id, v]));
    }
  } catch (e) {
    console.warn("walk schedule could not be read before the move", e);
  }
  return {
    walkIds: new Set(before.keys()),
    finish: async (actionKey: string) => {
      if (before.size === 0) return;
      try {
        const sb = await admin();
        const { data } = await sb.from("visits").select(VISIT_COLUMNS).in("id", [...before.keys()]);
        const byClient = new Map<string, { v: VisitRow; lines: WalkScheduleLine[] }>();
        for (const after of (data ?? []) as VisitRow[]) {
          const was = before.get(after.id);
          if (!was) continue;
          const line = walkScheduleLine(slotOf(was), slotOf(after));
          if (!line) continue;
          const entry = byClient.get(after.client_id) ?? { v: after, lines: [] };
          entry.lines.push(line);
          byClient.set(after.client_id, entry);
        }
        for (const [clientId, { v, lines }] of byClient) {
          await sendScheduleChanged({
            orgId: v.organization_id,
            clientId,
            lines,
            toOverride: one(v.properties)?.visit_contact_email ?? null,
            key: `walk-moved-${clientId}-${actionKey}`,
          });
        }
      } catch (e) {
        console.warn("walk schedule email failed", e);
      }
    },
  };
}

async function sendScheduleChanged(p: {
  orgId: string;
  clientId: string;
  lines: WalkScheduleLine[];
  toOverride: string | null;
  key: string;
}): Promise<void> {
  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  await enqueueAppEmail({
    organizationId: p.orgId,
    clientId: p.clientId,
    templateName: "walk-schedule-changed",
    notifyKey: "notify_email_walk_schedule_change",
    idempotencyKey: p.key,
    toOverride: p.toOverride || undefined,
    templateData: {
      changes: p.lines.slice(0, SCHEDULE_LINES_MAX),
      moreCount: Math.max(0, p.lines.length - SCHEDULE_LINES_MAX),
    },
  });
}

/** A stable key for one move of a set of visits to a day. */
export function moveKey(visitIds: readonly string[], toDate: string): string {
  const ids = [...visitIds].sort().join(",");
  let h = 0;
  for (let i = 0; i < ids.length; i++) h = (Math.imul(31, h) + ids.charCodeAt(i)) | 0;
  return `${toDate}-${(h >>> 0).toString(16)}-${visitIds.length}`;
}

// ── The office canceled walks ───────────────────────────────────────────────

/** After the office cancels one or more visits (cancelVisitFromOffice, or the
 *  client page's bulk cancel through notifyCanceledWalks): one email per
 *  client, listing every walk among `visitIds` that is now skipped and was
 *  for today or later in the business's own timezone. A visit that is not a
 *  dog walk, or a walk whose day has passed, sends nothing. `orgId`, when
 *  given, keeps the read to that business. */
export async function notifyWalksCanceled(opts: {
  visitIds: readonly string[];
  orgId?: string;
}): Promise<void> {
  try {
    if (opts.visitIds.length === 0) return;
    const sb = await admin();
    let q = sb.from("visits").select(VISIT_COLUMNS).in("id", [...opts.visitIds]);
    if (opts.orgId) q = q.eq("organization_id", opts.orgId);
    const { data } = await q;
    const walks = ((data ?? []) as VisitRow[]).filter((v) => isWalk(v) && v.status === "skipped");
    if (walks.length === 0) return;

    const { orgToday, DEFAULT_ORG_TIMEZONE } = await import("@/lib/org-day");
    const todayByOrg = new Map<string, string>();
    for (const orgId of new Set(walks.map((v) => v.organization_id))) {
      const { data: org } = await sb
        .from("organizations")
        .select("timezone")
        .eq("id", orgId)
        .maybeSingle();
      const tz = (org as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE;
      todayByOrg.set(orgId, orgToday(tz));
    }

    const byClient = new Map<string, VisitRow[]>();
    for (const v of walks) {
      if (v.scheduled_on < (todayByOrg.get(v.organization_id) ?? "")) continue;
      byClient.set(v.client_id, [...(byClient.get(v.client_id) ?? []), v]);
    }
    for (const [clientId, rows] of byClient) {
      try {
        await sendWalksCanceled(clientId, rows);
      } catch (e) {
        console.warn("walk-canceled email failed", clientId, e);
      }
    }
  } catch (e) {
    console.warn("walk-canceled emails failed", e);
  }
}

async function sendWalksCanceled(clientId: string, rows: VisitRow[]): Promise<void> {
  const sorted = [...rows].sort((a, b) => (a.scheduled_on < b.scheduled_on ? -1 : 1));
  const first = sorted[0];
  const names = new Set<string>();
  for (const v of sorted) {
    for (const d of one(v.properties)?.dogs ?? []) {
      if (d.active !== false && d.name) names.add(d.name);
    }
  }
  const ids = sorted.map((v) => v.id);
  const key = ids.length === 1 ? ids[0] : moveKey(ids, clientId);
  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  await enqueueAppEmail({
    organizationId: first.organization_id,
    clientId,
    templateName: "walk-canceled",
    notifyKey: "notify_email_walk_canceled",
    // A canceled visit stays canceled, so one walk is one email for good;
    // several canceled together are one email for that set.
    idempotencyKey: `walk-canceled-${key}`,
    oncePerKey: true,
    toOverride: one(first.properties)?.visit_contact_email || undefined,
    templateData: {
      dogs: dogNamesPhrase([...names]),
      walks: sorted.slice(0, SCHEDULE_LINES_MAX).map((v) => canceledWalkLabel(slotOf(v))),
      day: formatDay(first.scheduled_on),
      count: sorted.length,
    },
  });
}

// ── The office changed a walk plan ──────────────────────────────────────────

export type PlanSchedule = {
  weekdays: readonly number[] | null;
  earliest_time: string | null;
  latest_time: string | null;
};

/** After updateSubscription: one email when an ACTIVE dog-walking plan's
 *  days or window changed. */
export async function notifyWalkPlanChanged(opts: {
  subscriptionId: string;
  before: PlanSchedule;
}): Promise<void> {
  try {
    const sb = await admin();
    const { data: s } = await sb
      .from("subscriptions")
      .select(
        "id, organization_id, client_id, status, weekdays, earliest_time, latest_time, services(service_line), properties(visit_contact_email)",
      )
      .eq("id", opts.subscriptionId)
      .maybeSingle();
    if (!s || s.status !== "active") return;
    if (one(s.services as any)?.service_line !== "dog_walking") return;
    const was: WalkSlot = {
      weekdays: opts.before.weekdays,
      earliest: opts.before.earliest_time,
      latest: opts.before.latest_time,
    };
    const now: WalkSlot = {
      weekdays: s.weekdays as number[] | null,
      earliest: s.earliest_time,
      latest: s.latest_time,
    };
    if (!walkPlanScheduleChanged(was, now)) return;
    const line = walkScheduleLine(was, now);
    if (!line) return;
    await sendScheduleChanged({
      orgId: s.organization_id,
      clientId: s.client_id,
      lines: [line],
      toOverride: (one(s.properties as any) as { visit_contact_email?: string | null } | null)
        ?.visit_contact_email ?? null,
      // The new schedule and the minute: a drawer saved twice in a row is
      // one email, a later change is another.
      key: `walk-plan-${s.id}-${line.after}-${Math.floor(Date.now() / 60_000)}`,
    });
  } catch (e) {
    console.warn("walk plan email failed", opts.subscriptionId, e);
  }
}
