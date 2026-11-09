// Training in the customer portal, and the two package notices.
//
// Server-only: import inside handlers with `await import(...)`. Every reader
// here runs as the service role, after the portal session check, and filters
// by the session's own client and organization; nothing takes a client id
// from the browser.

import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { isBookableLine, serviceLinesOrDefault } from "@/lib/service-lines";
import { loadServiceLineAvailability } from "@/lib/service-line-availability.server";
import {
  holdsSession,
  packageState,
  sessionsLeft,
  type TrainingPackage,
} from "@/lib/training-packages";
import {
  dueNotices,
  lessonRequestBlock,
  officeNoticeText,
  portalShowsTraining,
} from "@/lib/training-portal";
import { createPackageSale, type TrainingDb } from "@/lib/training-packages.server";
import { skillTrends, type DatedScore } from "@/lib/training-progress";

// The admin client, typed loosely as every portal handler holds it.
type Admin = any;
type Session = { clientId: string; organizationId: string };

type PackageRow = TrainingPackage & {
  id: string;
  name: string;
  dog_id: string | null;
  purchased_on: string;
  price_cents: number;
  invoice_id: string | null;
};
type LessonRow = {
  id: string;
  scheduled_on: string;
  status: string;
  skip_billable: boolean | null;
  client_package_id: string;
  assigned_staff_id: string | null;
  subscriptions: { earliest_time: string | null } | null;
};

const PAYABLE = new Set(["open"]);
const DECIDED_NOT_TO_SEND = new Set([
  "org_toggle_off",
  "client_opted_out",
  "comms_paused",
  "no_recipient",
  "suppressed",
  "already_sent",
]);
const RECENT_LESSONS = 20;
// A client's completed-lesson scores and homework, newest first. Enough for
// a year of weekly lessons for two dogs at five skills.
const PROGRESS_ROWS = 1000;
const HOMEWORK_ROWS = 200;

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

function firstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null;
}

/** Whether a client may buy a package or request a lesson. Training is
 *  Coming soon until the platform switch makes it bookable (#531, read at
 *  runtime), and a Coming soon line is never offered to clients (#506). One
 *  switch for both portal paths. */
export async function trainingIsForSale(): Promise<boolean> {
  return isBookableLine("training", await loadServiceLineAvailability());
}

export type PortalTraining = Awaited<ReturnType<typeof loadPortalTraining>>;

/** Everything the portal's Training page draws, for one client. */
export async function loadPortalTraining(sb: Admin, session: Session) {
  const { clientId, organizationId: orgId } = session;
  const [org, packs, forSale, dogs, props] = await Promise.all([
    sb
      .from("organizations")
      .select("timezone, service_lines, training_share_progress")
      .eq("id", orgId)
      .maybeSingle(),
    sb
      .from("client_packages")
      .select(
        "id, name, dog_id, sessions_count, sessions_used, expires_on, status, purchased_on, price_cents, invoice_id",
      )
      .eq("client_id", clientId)
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false }),
    sb
      .from("service_packages")
      .select(
        "id, name, sessions_count, price_cents, expires_after_days, services!service_packages_service_id_fkey(name, active)",
      )
      .eq("organization_id", orgId)
      .eq("active", true)
      .gt("price_cents", 0)
      .order("name"),
    sb
      .from("dogs")
      .select("id, name, properties!inner(client_id)")
      .eq("properties.client_id", clientId)
      .eq("organization_id", orgId)
      .eq("active", true),
    sb
      .from("properties")
      .select("id, label, street, city")
      .eq("client_id", clientId)
      .eq("organization_id", orgId)
      .is("archived_at", null)
      .order("created_at"),
  ]);
  for (const r of [org, packs, forSale, dogs, props]) if (r.error) throw new Error(r.error.message);

  const today = orgToday(org.data?.timezone || DEFAULT_ORG_TIMEZONE);
  const runsTraining = serviceLinesOrDefault(org.data?.service_lines).includes("training");
  const packages = (packs.data ?? []) as PackageRow[];
  // Nothing is for sale while training is Coming soon (#506): a client who
  // already holds a package still sees it, its lessons and its invoice.
  const forSaleNow = await trainingIsForSale();
  const catalog =
    runsTraining && forSaleNow
      ? (
          (forSale.data ?? []) as Array<{
            id: string;
            name: string;
            sessions_count: number;
            price_cents: number;
            expires_after_days: number | null;
            services:
              { name: string; active: boolean } | { name: string; active: boolean }[] | null;
          }>
        )
          .filter((p) => one(p.services)?.active !== false)
          .map((p) => ({
            id: p.id,
            name: p.name,
            serviceName: one(p.services)?.name ?? null,
            sessionsCount: p.sessions_count,
            priceCents: p.price_cents,
            expiresAfterDays: p.expires_after_days,
          }))
      : [];
  if (
    !portalShowsTraining({
      hasPackage: packages.length > 0,
      runsTraining,
      forSale: catalog.length,
    })
  )
    return { visible: false as const };

  const share = org.data?.training_share_progress !== false;
  const ids = packages.map((p) => p.id);
  const invoiceIds = packages.map((p) => p.invoice_id).filter((v): v is string => !!v);
  const [lessons, invoices, requests] = await Promise.all([
    ids.length
      ? sb
          .from("visits")
          .select(
            "id, scheduled_on, status, skip_billable, client_package_id, assigned_staff_id, subscriptions(earliest_time)",
          )
          .in("client_package_id", ids)
          .eq("organization_id", orgId)
          .order("scheduled_on")
      : { data: [], error: null },
    invoiceIds.length
      ? sb
          .from("invoices")
          .select("id, status, total_cents")
          .in("id", invoiceIds)
          .eq("client_id", clientId)
      : { data: [], error: null },
    ids.length
      ? sb
          .from("qc_tickets")
          .select("id, client_package_id, requested_on, requested_time, message, booked_visit_id")
          .eq("category", "training_lesson_request")
          .eq("client_id", clientId)
          .eq("organization_id", orgId)
          .neq("status", "resolved")
          .order("requested_on")
      : { data: [], error: null },
  ]);
  for (const r of [lessons, invoices, requests]) if (r.error) throw new Error(r.error.message);

  const allLessons = (lessons.data ?? []) as LessonRow[];
  const recent = allLessons
    .filter((l) => ["completed", "skipped", "missed"].includes(l.status) && l.scheduled_on <= today)
    .sort((a, b) => b.scheduled_on.localeCompare(a.scheduled_on))
    .slice(0, RECENT_LESSONS);
  const upcoming = allLessons.filter(
    (l) => (l.status === "scheduled" || l.status === "in_progress") && l.scheduled_on >= today,
  );
  const recentIds = recent.map((l) => l.id);
  const staffIds = [
    ...new Set(upcoming.map((l) => l.assigned_staff_id).filter((v): v is string => !!v)),
  ];
  // Scores and homework are read for the client's completed lessons, not only
  // the recent package lessons: they make each dog's progress over time and
  // the homework it is on now, whichever lesson set it (R2-26).
  const [scores, notes, homework, staff] = await Promise.all([
    sb
      .from("session_progress")
      .select(
        "visit_id, dog_id, score, training_skills(name, sort_order), visits!inner(scheduled_on, status, client_id)",
      )
      .eq("organization_id", orgId)
      .eq("visits.client_id", clientId)
      .eq("visits.status", "completed")
      .lte("visits.scheduled_on", today)
      .order("created_at", { ascending: false })
      .limit(PROGRESS_ROWS),
    share && recentIds.length
      ? // Through the portal function, never the table: its RETURNS TABLE is
        // (visit_id, dog_id, note), so the staff-only note cannot come back, and it
        // returns only this client's visits.
        // rpc-role: service (sb is admin(); granted to service_role only)
        sb.rpc("portal_training_lesson_notes", {
          _organization_id: orgId,
          _client_id: clientId,
          _visit_ids: recentIds,
        })
      : { data: [], error: null },
    share
      ? sb
          .from("homework")
          .select("visit_id, dog_id, body, due_on, visits!inner(scheduled_on, status, client_id)")
          .eq("organization_id", orgId)
          .eq("visits.client_id", clientId)
          .eq("visits.status", "completed")
          .lte("visits.scheduled_on", today)
          .order("created_at", { ascending: false })
          .limit(HOMEWORK_ROWS)
      : { data: [], error: null },
    staffIds.length
      ? sb.from("staff").select("id, display_name").in("id", staffIds).eq("organization_id", orgId)
      : { data: [], error: null },
  ]);
  for (const r of [scores, notes, homework, staff]) if (r.error) throw new Error(r.error.message);

  type Visited = { scheduled_on: string } | { scheduled_on: string }[] | null | undefined;
  const scoreRows = (scores.data ?? []) as Array<{
    visit_id: string;
    dog_id: string | null;
    score: number;
    training_skills: { name: string; sort_order: number } | { name: string; sort_order: number }[];
    visits?: Visited;
  }>;
  // `note` only: portal_training_lesson_notes returns nothing else.
  const noteRows = (notes.data ?? []) as {
    visit_id: string;
    dog_id?: string | null;
    note: string | null;
  }[];
  const homeworkRows = (homework.data ?? []) as Array<{
    visit_id: string;
    dog_id?: string | null;
    body: string;
    due_on: string | null;
    visits?: Visited;
  }>;
  const dated: Array<DatedScore & { dogId: string | null }> = scoreRows.map((s) => {
    const skill = one(s.training_skills);
    return {
      visitId: s.visit_id,
      dogId: s.dog_id ?? null,
      scheduledOn: one(s.visits ?? null)?.scheduled_on ?? "",
      skill: skill?.name ?? "",
      sortOrder: skill?.sort_order ?? 0,
      score: s.score,
    };
  });
  /** One lesson's records, one per dog (or one for the whole lesson). */
  const recordsFor = (visitId: string, dogName: Map<string, string>) => {
    const dogIds = new Set<string | null>();
    for (const r of dated) if (r.visitId === visitId) dogIds.add(r.dogId);
    if (share) {
      for (const n of noteRows) if (n.visit_id === visitId) dogIds.add(n.dog_id ?? null);
      for (const h of homeworkRows) if (h.visit_id === visitId) dogIds.add(h.dog_id ?? null);
    }
    return [...dogIds]
      .map((dogId) => {
        const note = noteRows.find((n) => n.visit_id === visitId && (n.dog_id ?? null) === dogId);
        const work = homeworkRows.find(
          (h) => h.visit_id === visitId && (h.dog_id ?? null) === dogId,
        );
        return {
          dogName: dogId ? (dogName.get(dogId) ?? null) : null,
          scores: dated
            .filter((r) => r.visitId === visitId && r.dogId === dogId)
            .sort((a, b) => a.sortOrder - b.sortOrder || a.skill.localeCompare(b.skill))
            .map(({ skill, score }) => ({ skill, score })),
          // Null both when nothing was written and when the business keeps
          // notes and homework to itself.
          note: share ? (note?.note ?? null) : null,
          homework: share && work ? { body: work.body, dueOn: work.due_on } : null,
        };
      })
      .sort((a, b) => (a.dogName ?? "").localeCompare(b.dogName ?? ""));
  };
  const staffName = new Map(
    ((staff.data ?? []) as { id: string; display_name: string }[]).map((s) => [
      s.id,
      firstName(s.display_name),
    ]),
  );
  const invoiceBy = new Map(
    ((invoices.data ?? []) as { id: string; status: string; total_cents: number }[]).map((i) => [
      i.id,
      i,
    ]),
  );
  const openRequests = (requests.data ?? []) as Array<{
    id: string;
    client_package_id: string;
    requested_on: string;
    requested_time: string | null;
    message: string | null;
    booked_visit_id: string | null;
  }>;
  const dogList = ((dogs.data ?? []) as { id: string; name: string }[]).map((d) => ({
    id: d.id,
    name: d.name,
  }));
  const dogName = new Map(dogList.map((d) => [d.id, d.name]));
  const startOf = (l: LessonRow) => one(l.subscriptions)?.earliest_time?.slice(0, 5) ?? null;
  // Each dog's skills over time and the homework from its latest lesson that
  // set any. A dog with neither is left out.
  const dogProgress = dogList
    .map((d) => {
      const latest = homeworkRows
        .filter((h) => h.dog_id === d.id)
        .sort((a, b) =>
          (one(b.visits ?? null)?.scheduled_on ?? "").localeCompare(
            one(a.visits ?? null)?.scheduled_on ?? "",
          ),
        )[0];
      return {
        dogId: d.id,
        dogName: d.name,
        skills: skillTrends(dated.filter((r) => r.dogId === d.id && r.scheduledOn)),
        homework:
          share && latest
            ? {
                body: latest.body,
                dueOn: latest.due_on,
                setOn: one(latest.visits ?? null)?.scheduled_on ?? null,
              }
            : null,
      };
    })
    .filter((p) => p.skills.length > 0 || p.homework);

  return {
    visible: true as const,
    today,
    shareProgress: share,
    dogs: dogList,
    dogProgress,
    properties: (props.data ?? []) as Array<{
      id: string;
      label: string | null;
      street: string;
      city: string | null;
    }>,
    forSale: catalog,
    packages: packages.map((p) => {
      const own = allLessons.filter((l) => l.client_package_id === p.id);
      const held = own.filter((l) =>
        holdsSession({ status: l.status, skip_billable: l.skip_billable }),
      ).length;
      const asked = openRequests.filter((r) => r.client_package_id === p.id && !r.booked_visit_id);
      const invoice = p.invoice_id ? (invoiceBy.get(p.invoice_id) ?? null) : null;
      return {
        id: p.id,
        name: p.name,
        dogName: p.dog_id ? (dogName.get(p.dog_id) ?? null) : null,
        sessionsCount: p.sessions_count,
        sessionsUsed: p.sessions_used,
        left: sessionsLeft(p),
        // Sessions not yet booked, used, or asked for: what a request can still take.
        free: Math.max(0, p.sessions_count - held - asked.length),
        expiresOn: p.expires_on,
        purchasedOn: p.purchased_on,
        state: packageState(p, today),
        requestBlock: lessonRequestBlock(p, held, asked.length, today, forSaleNow),
        invoice: invoice
          ? {
              id: invoice.id,
              totalCents: invoice.total_cents,
              status: invoice.status,
              payable: PAYABLE.has(invoice.status),
            }
          : null,
        requests: asked.map((r) => ({
          id: r.id,
          requestedOn: r.requested_on,
          requestedTime: r.requested_time?.slice(0, 5) ?? null,
          message: r.message,
        })),
        upcoming: upcoming
          .filter((l) => l.client_package_id === p.id)
          .map((l) => ({
            id: l.id,
            scheduledOn: l.scheduled_on,
            startTime: startOf(l),
            trainer: l.assigned_staff_id ? (staffName.get(l.assigned_staff_id) ?? null) : null,
          })),
        recent: recent
          .filter((l) => l.client_package_id === p.id)
          .map((l) => ({
            id: l.id,
            scheduledOn: l.scheduled_on,
            status: l.status,
            records: recordsFor(l.id, dogName),
          })),
      };
    }),
  };
}

/**
 * A client buys one of the business's active packages. The same sale the
 * office makes (createPackageSale: the checks, the open invoice, the cleanup
 * if the package insert fails), with no user, for the session's own client.
 * The client then pays the invoice on the existing pay page.
 */
export async function buyPackageFromPortal(
  sb: Admin,
  session: Session,
  input: { servicePackageId: string; dogId?: string; requestId: string },
) {
  const { data: org, error } = await sb
    .from("organizations")
    .select("service_lines")
    .eq("id", session.organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (
    !serviceLinesOrDefault(org?.service_lines).includes("training") ||
    !(await trainingIsForSale())
  )
    throw new Error("Training packages are not offered here.");
  const sale = await createPackageSale(sb as TrainingDb, {
    ...input,
    orgId: session.organizationId,
    userId: null,
    clientId: session.clientId,
  });
  try {
    const { data: client } = await sb
      .from("clients")
      .select("display_name")
      .eq("id", session.clientId)
      .maybeSingle();
    const { notifyRoles } = await import("@/lib/notify-center.server");
    await notifyRoles(["owner", "office_manager"], {
      orgId: session.organizationId,
      type: "training_package",
      title: `Training package bought: ${client?.display_name ?? "a client"}`,
      body: `${sale.package.name}, invoice ${sale.invoiceNumber}. Not paid yet.`,
      link: `/clients/${session.clientId}`,
      eventKey: `training-bought:${sale.package.id}`,
    });
  } catch (e) {
    console.error("training package office notification failed", (e as Error).message);
  }
  return { packageId: sale.package.id, invoiceId: sale.invoiceId };
}

/** "Friday, October 30", on the org's calendar. */
function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Send the notices due on an organization's training packages: one session
 * left, and 14 days before expiry. The client gets an email, the owner and
 * office managers an in-app notification.
 *
 * Each notice is claimed in training_package_notices before anything is sent,
 * so the nightly job and a lesson completed at the same moment cannot both
 * send it. If every channel fails the claim is released and the next run
 * tries again. The email and the in-app row each carry the same key as well
 * (oncePerKey, eventKey), so a second claim could not double-send either.
 *
 * Pass `clientPackageId` to look at one package, as the lesson paths do.
 * Returns a count, or a reason, for the nightly report.
 */
export async function sendTrainingPackageNotices(
  sb: Admin,
  org: { id: string; timezone?: string | null },
  opts: { clientPackageId?: string; now?: Date } = {},
): Promise<number | string> {
  const today = orgToday(org.timezone || DEFAULT_ORG_TIMEZONE, opts.now);
  let q = sb
    .from("client_packages")
    .select(
      "id, client_id, name, sessions_count, sessions_used, expires_on, status, clients(display_name, portal_token)",
    )
    .eq("organization_id", org.id)
    .eq("status", "active");
  if (opts.clientPackageId) q = q.eq("id", opts.clientPackageId);
  const { data, error } = await q.limit(2000);
  if (error) return `err: ${error.message}`;
  const rows = (data ?? []) as Array<
    TrainingPackage & {
      id: string;
      client_id: string;
      name: string;
      clients:
        | { display_name: string; portal_token: string | null }
        | { display_name: string; portal_token: string | null }[]
        | null;
    }
  >;
  const due = rows.flatMap((p) => dueNotices(p, today).map((n) => ({ ...n, pkg: p })));
  if (!due.length) return 0;

  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  const { notifyRoles } = await import("@/lib/notify-center.server");
  const { buildPortalLink, ensureOrgSlug } = await import("@/lib/portal-links.server");
  const slug = await ensureOrgSlug(org.id).catch(() => null);

  let sent = 0;
  for (const { kind, key, pkg } of due) {
    const { data: claimed, error: claimError } = await sb
      .from("training_package_notices")
      .upsert(
        { dedupe_key: key, organization_id: org.id, client_package_id: pkg.id, kind },
        { onConflict: "dedupe_key", ignoreDuplicates: true },
      )
      .select("dedupe_key");
    if (claimError) {
      console.error("training notice claim failed", key, claimError.message);
      continue;
    }
    if (!claimed || claimed.length === 0) continue;

    const client = one(pkg.clients);
    const left = sessionsLeft(pkg);
    let delivered = false;
    try {
      const base = await buildPortalLink(org.id, client?.portal_token, slug);
      const res = await enqueueAppEmail({
        organizationId: org.id,
        clientId: pkg.client_id,
        templateName: "training-package-notice",
        notifyKey: "notify_email_training_package",
        idempotencyKey: key,
        oncePerKey: true,
        templateData: {
          kind,
          packageName: pkg.name,
          left,
          expiresLabel: pkg.expires_on ? longDay(pkg.expires_on) : null,
          portalUrl: base ? `${base}/training` : undefined,
        },
      });
      // A switched-off email or an opted-out client is a decision, not a failure.
      delivered = res.ok || DECIDED_NOT_TO_SEND.has(res.reason ?? "");
    } catch (e) {
      console.error("training notice email failed", key, (e as Error).message);
    }
    try {
      const text = officeNoticeText(kind, {
        clientName: client?.display_name ?? "a client",
        packageName: pkg.name,
        left,
        expiresOn: pkg.expires_on,
      });
      await notifyRoles(["owner", "office_manager"], {
        orgId: org.id,
        type: "training_package",
        ...text,
        link: `/clients/${pkg.client_id}`,
        eventKey: key,
      });
      delivered = true;
    } catch (e) {
      console.error("training notice in-app failed", key, (e as Error).message);
    }
    if (delivered) sent++;
    else await sb.from("training_package_notices").delete().eq("dedupe_key", key);
  }
  return sent;
}

/**
 * After a lesson's status changes on any path that can use a session
 * (completed, skipped, missed, or the office's override), look at its
 * package once. Best-effort: a notice must never fail the lesson.
 */
export async function afterLessonSessionChange(visitId: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: v } = await (supabaseAdmin as Admin)
      .from("visits")
      .select("client_package_id, organization_id, organizations(timezone)")
      .eq("id", visitId)
      .maybeSingle();
    if (!v?.client_package_id) return;
    await sendTrainingPackageNotices(
      supabaseAdmin,
      {
        id: v.organization_id,
        timezone: one(v.organizations as { timezone: string | null })?.timezone,
      },
      { clientPackageId: v.client_package_id },
    );
  } catch (e) {
    console.error("training notice after lesson failed", visitId, (e as Error).message);
  }
}
