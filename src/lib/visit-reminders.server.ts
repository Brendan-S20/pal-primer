// The day-before visit reminder, sent by the nightly job. See
// supabase/migrations/20260928040000_nobody-was-reminded-the-day-before.sql
// for why it is email and why existing organizations start with it off.
//
// Server-only: import inside handlers with `await import(...)`.

import { orgToday } from "@/lib/org-day";

export interface ReminderVisit {
  id: string;
  client_id: string | null;
  scheduled_on: string;
  properties: { street?: string | null; city?: string | null } | null;
}

export interface ReminderBatch {
  clientId: string;
  addresses: string[];
}

/** The org-calendar day after `today`. Noon-anchored so no offset can move it. */
export function tomorrowOf(today: string): string {
  return new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The day the reminders are FOR: tomorrow on the organization's calendar,
 *  not the server's. The job runs at 09:00 UTC, which is already tomorrow in
 *  Sydney and still today in Honolulu. */
export function reminderDay(tz: string, now: Date = new Date()): string {
  return tomorrowOf(orgToday(tz, now));
}

/** One email per client, listing each property visited that day once. */
export function groupRemindersByClient(visits: ReminderVisit[]): ReminderBatch[] {
  const byClient = new Map<string, Set<string>>();
  for (const v of visits) {
    if (!v.client_id) continue;
    const set = byClient.get(v.client_id) ?? new Set<string>();
    const addr = [v.properties?.street, v.properties?.city].filter(Boolean).join(", ");
    if (addr) set.add(addr);
    byClient.set(v.client_id, set);
  }
  return [...byClient.entries()].map(([clientId, set]) => ({
    clientId,
    addresses: [...set],
  }));
}

/** "Tuesday, September 29". formatDay's noon anchor, spelled out in full. */
export function reminderDayLabel(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/**
 * Email every client with a scheduled visit tomorrow. Returns a count for the
 * nightly job's per-org report, with holds and opt-outs broken out so a quiet
 * night reads as a reason rather than a silence.
 */
export async function sendVisitReminderEmails(
  supabaseAdmin: any,
  org: { id: string; timezone?: string | null },
  now: Date = new Date(),
): Promise<number | string> {
  const { DEFAULT_ORG_TIMEZONE } = await import("@/lib/org-day");
  const day = reminderDay(org.timezone || DEFAULT_ORG_TIMEZONE, now);

  const { data: visits, error } = await supabaseAdmin
    .from("visits")
    .select("id, client_id, scheduled_on, properties(street, city)")
    .eq("organization_id", org.id)
    .eq("scheduled_on", day)
    .eq("status", "scheduled")
    .order("id")
    .limit(2000);
  if (error) return `err: ${error.message}`;
  const batches = groupRemindersByClient((visits ?? []) as ReminderVisit[]);
  if (!batches.length) return 0;

  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, portal_token")
    .in(
      "id",
      batches.map((b) => b.clientId),
    );
  const tokenOf = new Map<string, string | null>(
    (clients ?? []).map((c: { id: string; portal_token: string | null }) => [c.id, c.portal_token]),
  );

  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  const { buildPortalLink, ensureOrgSlug } = await import("@/lib/portal-links.server");
  const slug = await ensureOrgSlug(org.id).catch(() => null);
  const dayLabel = reminderDayLabel(day);

  let sent = 0;
  const skipped: Record<string, number> = {};
  for (const b of batches) {
    try {
      const portalUrl = await buildPortalLink(org.id, tokenOf.get(b.clientId), slug);
      const res = await enqueueAppEmail({
        organizationId: org.id,
        clientId: b.clientId,
        templateName: "visit-reminder",
        notifyKey: "notify_email_visit_reminder",
        // Per client per day: a re-run of the job the same day is deduped by
        // the provider, and a visit moved to another day earns a new one.
        idempotencyKey: `visit-reminder-${b.clientId}-${day}`,
        templateData: { dayLabel, addresses: b.addresses, portalUrl },
      });
      if (res.ok) sent++;
      else skipped[res.reason ?? "unknown"] = (skipped[res.reason ?? "unknown"] ?? 0) + 1;
    } catch (e) {
      console.error("visit reminder failed", b.clientId, e);
      skipped.error = (skipped.error ?? 0) + 1;
    }
  }
  const why = Object.entries(skipped)
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
  return why ? `${sent} sent; skipped ${why}` : sent;
}
