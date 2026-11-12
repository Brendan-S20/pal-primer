/** What a client is sent when a pet sitting visit ends (#411), read for one
 *  visit. The pure rules are in sit-report.ts.
 *
 *    sitCompletionFor    the visit report the completion email carries,
 *                        in place of the cleanup wording (completeVisit)
 *    afterSitCompleted   the missed medication email, once per visit, and
 *                        the stay summary once the stay's last visit is done
 *    sendSettledStaySummaries
 *                        the nightly catch for a stay whose last visit was
 *                        skipped or went missed rather than completed: no
 *                        completion ran, so no summary had been sent. It
 *                        looks back 7 days only when the business turned on
 *                        stay_summary_catch_up; otherwise no further than
 *                        the day the catch went live for it
 *
 *  Both return nothing for a visit that is not pet sitting, which is how a
 *  pet-waste or walking client is sent exactly what they were before. Neither
 *  throws: the completion has already happened. enqueueAppEmail honours the
 *  org's switch, the client's opt-out and the comms hold. Reads are the
 *  service role's, for a visit the caller has just completed. */

import { DEFAULT_TIMEZONE } from "@/lib/route-window";
import { formatDay } from "@/lib/format";
import { addDays } from "@/lib/stays";
import { orgLocalDay } from "@/lib/org-day";
import {
  SIT_PUSH,
  missedMeds,
  petNamesPhrase,
  sitReportEmail,
  staySummaryDates,
  type CareRow,
  type SitReportEmail,
  type StaySummaryEmail,
} from "@/lib/sit-report";

export type SitCompletion = {
  email: SitReportEmail;
  push: { title: string; body: string };
};

const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

async function admin(): Promise<any> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

type Pet = { id: string; name: string | null; active: boolean | null };
type StayRef = {
  id: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  pet_ids: string[] | null;
};

type Row = {
  id: string;
  organization_id: string;
  client_id: string;
  scheduled_on: string;
  started_at: string | null;
  completed_at: string | null;
  report_note: string | null;
  assigned_staff_id: string | null;
  services: { service_line: string | null } | { service_line: string | null }[] | null;
  organizations: { timezone: string | null } | { timezone: string | null }[] | null;
  subscriptions:
    { stays: StayRef | StayRef[] | null } | { stays: StayRef | StayRef[] | null }[] | null;
  properties:
    | { visit_contact_email: string | null; dogs: Pet[] | null }
    | { visit_contact_email: string | null; dogs: Pet[] | null }[]
    | null;
};

const COLUMNS =
  "id, organization_id, client_id, scheduled_on, started_at, completed_at, report_note, assigned_staff_id, services(service_line), organizations(timezone), subscriptions(stays(id, kind, starts_on, ends_on, pet_ids)), properties(visit_contact_email, dogs(id, name, active))";

const CARE_COLUMNS = "pet_id, kind, med_name, status, missed_reason, note, at";

async function readSitVisit(sb: any, visitId: string): Promise<Row | null> {
  const { data, error } = await sb.from("visits").select(COLUMNS).eq("id", visitId).maybeSingle();
  if (error || !data) return null;
  const v = data as Row;
  return one(v.services)?.service_line === "pet_sitting" ? v : null;
}

const stayOf = (v: Row): StayRef | null => one(one(v.subscriptions)?.stays ?? null);

/** The stay's pets when it names them, otherwise the active pets at home. */
function petsOf(v: Row): Pet[] {
  const all = one(v.properties)?.dogs ?? [];
  const named = new Set(stayOf(v)?.pet_ids ?? []);
  return named.size > 0
    ? all.filter((p) => named.has(p.id))
    : all.filter((p) => p.active !== false);
}

export async function sitCompletionFor(visitId: string): Promise<SitCompletion | null> {
  try {
    const sb = await admin();
    const v = await readSitVisit(sb, visitId);
    if (!v) return null;
    const { data: rows } = await sb
      .from("care_log")
      .select(CARE_COLUMNS)
      .eq("visit_id", visitId)
      .order("at");
    let sitterName: string | null = null;
    if (v.assigned_staff_id) {
      const { data: staff } = await sb
        .from("staff")
        .select("display_name")
        .eq("id", v.assigned_staff_id)
        .maybeSingle();
      sitterName = (staff?.display_name as string | null) ?? null;
    }
    const overnight = stayOf(v)?.kind === "overnight";
    return {
      email: sitReportEmail({
        overnight,
        startedAt: v.started_at,
        completedAt: v.completed_at,
        timezone: one(v.organizations)?.timezone || DEFAULT_TIMEZONE,
        pets: petsOf(v),
        rows: (rows ?? []) as CareRow[],
        reportNote: v.report_note,
        sitterName,
      }),
      push: overnight ? { ...SIT_PUSH.overnight } : { ...SIT_PUSH.drop_in },
    };
  } catch (e) {
    console.warn("sit report could not be read; sending the plain completion email", visitId, e);
    return null;
  }
}

export async function afterSitCompleted(visitId: string): Promise<void> {
  let v: Row | null = null;
  let sb: any;
  try {
    sb = await admin();
    v = await readSitVisit(sb, visitId);
  } catch (e) {
    console.warn("sit visit could not be read after completion", visitId, e);
    return;
  }
  if (!v) return;
  await sendMissedMeds(sb, v);
  await sendStaySummaryIfLast(sb, v);
}

async function sendMissedMeds(sb: any, v: Row): Promise<void> {
  try {
    const { data } = await sb
      .from("care_log")
      .select(CARE_COLUMNS)
      .eq("visit_id", v.id)
      .eq("kind", "meds")
      .eq("status", "missed")
      .order("at");
    const pets = petsOf(v);
    const missed = missedMeds((data ?? []) as CareRow[], pets);
    if (missed.length === 0) return;
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    await enqueueAppEmail({
      organizationId: v.organization_id,
      clientId: v.client_id,
      templateName: "sit-missed-meds",
      notifyKey: "notify_email_missed_meds",
      // One per visit: a replayed completion is the same completion.
      idempotencyKey: `missed-meds-${v.id}`,
      oncePerKey: true,
      toOverride: one(v.properties)?.visit_contact_email || undefined,
      templateData: {
        pets: petNamesPhrase(pets.map((p) => p.name)),
        day: formatDay(v.scheduled_on),
        missed,
      },
    });
  } catch (e) {
    console.warn("missed medication email failed", v.id, e);
  }
}

/** How far back the nightly catch looks: a stay that ended within the last
 *  week. A summary is sent once per stay whichever path sends it (the
 *  idempotency key is the stay's), so looking back more than one night only
 *  covers a nightly run that failed. */
export const STAY_SUMMARY_LOOKBACK_DAYS = 7;

/** The first day the nightly catch looks at (#747, Brendan via Product,
 *  2026-11-09). With organizations.stay_summary_catch_up on, the full
 *  STAY_SUMMARY_LOOKBACK_DAYS. Off (the default), never before the day the
 *  catch went live for the business (organizations.stay_summaries_live_at,
 *  on its own calendar): no backlog of summaries for stays that ended before
 *  then. A go-live moment that cannot be read is treated as now, which sends
 *  no backlog rather than a week of it. */
export function staySummaryWindowStart(input: {
  today: string;
  catchUp: boolean;
  liveAt: string | null | undefined;
  timezone: string | null | undefined;
}): string {
  const lookback = addDays(input.today, -STAY_SUMMARY_LOOKBACK_DAYS);
  if (input.catchUp) return lookback;
  const live = input.liveAt ? orgLocalDay(input.liveAt, input.timezone || undefined) : "";
  const liveDay = live || input.today;
  return liveDay > lookback ? liveDay : lookback;
}

/** The nightly catch (#411). A stay's summary went out from
 *  afterSitCompleted, which only runs when a visit is COMPLETED. A stay
 *  whose last visit was skipped, or that the nightly job marked missed,
 *  settled with no completion, and its client never got the summary. This
 *  runs after admin_transition_missed_visits on the business's own today,
 *  for stays that ended in the last week, and sends the summary for any
 *  stay with nothing left to do. Pet sitting only; never throws per stay.
 *  Returns how many stays it queued a summary for. */
export async function sendSettledStaySummaries(orgId: string, today: string): Promise<number> {
  const sb = await admin();
  // How far back: the business's choice (migration 20261109170000). Read
  // first, and a failed read sends nothing rather than a backlog.
  const { data: org, error: orgError } = await sb
    .from("organizations")
    .select("timezone, stay_summary_catch_up, stay_summaries_live_at")
    .eq("id", orgId)
    .single();
  if (orgError) throw new Error(orgError.message);
  const from = staySummaryWindowStart({
    today,
    catchUp: org?.stay_summary_catch_up === true,
    liveAt: org?.stay_summaries_live_at ?? null,
    timezone: org?.timezone ?? null,
  });
  const { data: stays, error } = await sb
    .from("stays")
    .select("id")
    .eq("organization_id", orgId)
    .in("status", ["confirmed", "completed"])
    .gte("ends_on", from)
    .lte("ends_on", today);
  if (error) throw new Error(error.message);
  let queued = 0;
  for (const stay of (stays ?? []) as { id: string }[]) {
    try {
      const { data: plans } = await sb.from("subscriptions").select("id").eq("stay_id", stay.id);
      const planIds = ((plans ?? []) as { id: string }[]).map((p) => p.id);
      if (planIds.length === 0) continue;
      const { data: last } = await sb
        .from("visits")
        .select("id")
        .in("subscription_id", planIds)
        .neq("status", "canceled")
        .order("scheduled_on", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!last) continue;
      const v = await readSitVisit(sb, last.id as string);
      if (v && (await sendStaySummaryIfLast(sb, v))) queued++;
    } catch (e) {
      console.warn("settled stay summary failed", stay.id, e);
    }
  }
  return queued;
}

/** True when this call queued the summary; false when the stay is not
 *  settled yet, the summary was already sent, or the email is switched off. */
async function sendStaySummaryIfLast(sb: any, v: Row): Promise<boolean> {
  const stay = stayOf(v);
  if (!stay) return false;
  try {
    const { data: plans } = await sb.from("subscriptions").select("id").eq("stay_id", stay.id);
    const planIds = ((plans ?? []) as { id: string }[]).map((p) => p.id);
    if (planIds.length === 0) return false;
    const { data: visits } = await sb
      .from("visits")
      .select("id, status, scheduled_on")
      .in("subscription_id", planIds)
      .neq("status", "canceled");
    const list = (visits ?? []) as { id: string; status: string; scheduled_on: string }[];
    // Last means nothing left to do: every visit is done, skipped or missed.
    if (
      list.length === 0 ||
      list.some((x) => x.status === "scheduled" || x.status === "in_progress")
    )
      return false;
    const dayOf = new Map(list.map((x) => [x.id, x.scheduled_on]));
    const { data: rows } = await sb
      .from("care_log")
      .select(`visit_id, ${CARE_COLUMNS}`)
      .in(
        "visit_id",
        list.map((x) => x.id),
      )
      .eq("kind", "meds")
      .eq("status", "missed")
      .order("at");
    const pets = petsOf(v);
    const missed = ((rows ?? []) as (CareRow & { visit_id: string })[]).flatMap((r) =>
      missedMeds([r], pets).map((m) => ({ ...m, day: formatDay(dayOf.get(r.visit_id) ?? "") })),
    );
    const { data: client } = await sb
      .from("clients")
      .select("portal_token")
      .eq("id", v.client_id)
      .maybeSingle();
    const { buildPortalLink } = await import("@/lib/portal-links.server");
    const base = await buildPortalLink(v.organization_id, client?.portal_token ?? null);
    const overnight = stay.kind === "overnight";
    const summary: StaySummaryEmail = {
      pets: petNamesPhrase(pets.map((p) => p.name)),
      dates: staySummaryDates(overnight ? "overnight" : "drop_in", stay.starts_on, stay.ends_on),
      visitsDone: list.filter((x) => x.status === "completed").length,
      visitsTotal: list.length,
      overnight,
      missed,
      ...(base ? { portalUrl: `${base}/visits` } : {}),
    };
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const result = await enqueueAppEmail({
      organizationId: v.organization_id,
      clientId: v.client_id,
      templateName: "stay-summary",
      // A summary of visit reports: sent under the same switch they are.
      notifyKey: "notify_email_visit_completed",
      idempotencyKey: `stay-summary-${stay.id}`,
      oncePerKey: true,
      toOverride: one(v.properties)?.visit_contact_email || undefined,
      templateData: summary,
    });
    return result?.ok === true;
  } catch (e) {
    console.warn("stay summary email failed", stay.id, e);
    return false;
  }
}
