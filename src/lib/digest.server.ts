// Weekly business digest — server-only helpers.
// Computes metrics for the past 7 days for one org and enqueues a digest email
// to the configured recipient. The commentary is built by buildDigestInsights
// (digest-insights.ts) from those metrics; there is no model call here any
// more, see that file for why.

import * as React from "react";
import { orgLocalDay } from "@/lib/org-day";
import { render } from "react-email";
import { EMAIL_TEXT_OPTIONS } from "@/lib/email/plain-text";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { grossReceivedCents, receivedPaymentStatuses } from "@/lib/revenue";
import { buildDigestAlerts } from "@/lib/digest-alerts";

const SITE_NAME = "HoundStack";
const SENDER_DOMAIN = "notify.houndstack.com";
const FROM_DOMAIN = "notify.houndstack.com";

const DAY = 86_400_000;

export interface DigestStat {
  label: string;
  value: string;
  delta?: string;
}

export interface DigestMetrics {
  orgId: string;
  orgName: string;
  weekLabel: string;
  /** The window these figures cover. The commentary compares against "the
   *  previous N days", and the Advisor runs this over 30 and 90 as well as 7. */
  windowDays: AdvisorWindowDays;
  stats: DigestStat[];
  raw: {
    /** NET of the reversals that happened in the same window — see the
     *  deduction in computeDigestMetrics for why this cannot be the gross. */
    revenueCents: number;
    revenueGrossCents: number;
    /** Refunds and lost chargebacks less won disputes, dated to when the money
     *  moved. Carried separately so the digest can SHOW the reversal instead of
     *  handing the owner a figure that quietly shrank. */
    refundsCents: number;
    prevRevenueCents: number;
    prevRevenueGrossCents: number;
    prevRefundsCents: number;
    visitsCompleted: number;
    visitsSkipped: number;
    newClients: number;
    openArCents: number;
    /** What the OVERDUE invoices come to. Distinct from openArCents, which
     *  includes invoices that are open but not yet due — see the alert below
     *  for why the difference is not cosmetic. */
    overdueCents: number;
    atRiskCount: number;
    complaintsCount: number;
    overdueInvoices: number;
    topZones: Array<{ name: string; revenueCents: number }>;
  };
  alerts: string[];
}

function fmt(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

function pct(a: number, b: number) {
  if (!b) return a > 0 ? "+∞" : "0%";
  const change = ((a - b) / b) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${Math.round(change)}% WoW`;
}

function fmtRange(startMs: number, endMs: number) {
  const s = new Date(startMs);
  const e = new Date(endMs - DAY);
  const m = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${m(s)} - ${m(e)}`;
}

/** Windows the advisor can analyze. The weekly digest email uses 7, which is
 *  why that stays the default — this parameter widens the same engine rather
 *  than forking it, so the email and the in-app advisor can never disagree. */
export type AdvisorWindowDays = 7 | 30 | 90;

/** A date in the ORG's timezone, not the database's.
 *
 *  `scheduled_on` is a DATE column, so comparing it against a UTC-derived
 *  "today" is the BUG-12 mistake: for an org west of UTC the boundary lands up
 *  to a day early, quietly shifting which visits count as inside the window.
 *  en-CA formats as YYYY-MM-DD, which is what the column wants. */
function orgLocalDate(ms: number, tz: string): string {
  // The third copy of this was about to be written, so it is one definition
  // now. See src/lib/org-day.ts for why the server's clock is the wrong clock.
  return orgLocalDay(ms, tz);
}

export async function computeDigestMetrics(
  orgId: string,
  windowDays: AdvisorWindowDays = 7,
): Promise<DigestMetrics | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("id, name, timezone")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return null;

  const { DEFAULT_TIMEZONE } = await import("@/lib/route-window");
  const tz = (org as { timezone?: string | null }).timezone || DEFAULT_TIMEZONE;

  const now = Date.now();
  const weekStart = now - windowDays * DAY;
  const prevStart = now - 2 * windowDays * DAY;
  const weekStartIso = new Date(weekStart).toISOString();
  const prevStartIso = new Date(prevStart).toISOString();
  // Timestamp columns stay in UTC (they are instants); DATE columns are
  // compared in org-local terms.
  const weekStartDate = orgLocalDate(weekStart, tz);
  const todayDate = orgLocalDate(now, tz);

  // Revenue received — this week & previous week for WoW.
  //
  // IMP-10: `.in(RECEIVED)` rather than `.eq("succeeded")`. A refund flips the
  // original payment to 'refunded', so filtering on 'succeeded' would erase it
  // from LAST week's figure too — and the advisor's whole job is comparing this
  // week against last. A single refund would show up as a week-over-week
  // improvement, which is the opposite of what happened.
  const [{ data: payThis }, { data: payPrev }] = await Promise.all([
    supabaseAdmin
      .from("payments")
      .select("amount_cents, tax_cents, status, paid_at")
      .eq("organization_id", orgId)
      .in("status", receivedPaymentStatuses())
      .gte("paid_at", weekStartIso),
    supabaseAdmin
      .from("payments")
      .select("amount_cents, tax_cents, status, paid_at")
      .eq("organization_id", orgId)
      .in("status", receivedPaymentStatuses())
      .gte("paid_at", prevStartIso)
      .lt("paid_at", weekStartIso),
  ]);
  const revenueGrossCents = grossReceivedCents(payThis ?? []);
  const prevRevenueGrossCents = grossReceivedCents(payPrev ?? []);

  // IMP-10, the other half of the rule. Keeping the receipt in the period it
  // arrived is only truthful if the reversal is deducted in the period IT
  // happened, and nothing above does that — `refunded` payments are counted at
  // full value and the refund itself is never subtracted anywhere. A $5,000
  // dispute would therefore leave last week's revenue untouched AND leave this
  // week's untouched, so the advisor reads a chargeback as flat or, once the
  // replacement sale lands, as a GAIN, and then says so in plain English.
  //
  // The previous window gets the identical treatment because the entire point
  // of this function is the week-over-week delta; netting only the current side
  // would compare two different definitions of revenue and put the error into
  // the one number the owner actually reads.
  //
  // Windows are org-local DAYS (what review_items can be bucketed by), so the
  // previous one ends the day BEFORE the current one starts — adjacent, never
  // overlapping, so no reversal is deducted twice.
  const { loadOrgReversals, totalReversals } = await import("@/lib/reversals.server");
  const prevStartDate = orgLocalDate(prevStart, tz);
  const prevEndDate = orgLocalDate(weekStart - DAY, tz);
  const [thisReversals, prevReversals] = await Promise.all([
    loadOrgReversals(supabaseAdmin, {
      orgId,
      timezone: tz,
      from: weekStartDate,
      to: todayDate,
    }),
    loadOrgReversals(supabaseAdmin, {
      orgId,
      timezone: tz,
      from: prevStartDate,
      to: prevEndDate,
    }),
  ]);
  const refundsCents = totalReversals(thisReversals).netCents;
  const prevRefundsCents = totalReversals(prevReversals).netCents;
  const revenueCents = revenueGrossCents - refundsCents;
  const prevRevenueCents = prevRevenueGrossCents - prevRefundsCents;

  // Visits this week
  const { data: visits } = await supabaseAdmin
    .from("visits")
    .select("id, status, scheduled_on")
    .eq("organization_id", orgId)
    .gte("scheduled_on", weekStartDate)
    .lte("scheduled_on", todayDate);
  const visitsCompleted = (visits ?? []).filter((v: any) => v.status === "completed").length;
  const visitsSkipped = (visits ?? []).filter(
    (v: any) => v.status === "skipped" || v.status === "no_show",
  ).length;

  // New clients this week
  const { count: newClients } = await supabaseAdmin
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .gte("created_at", weekStartIso);

  // Open AR — same shared math as Dashboard/Reports/Invoices (B1): balances
  // net of applied credit, overdue by due_on.
  const { data: openInvoices } = await supabaseAdmin
    .from("invoices")
    .select(
      "total_cents, credit_applied_cents, amount_paid_cents, deposit_for_invoice_id, due_on, issued_at, status",
    )
    .eq("organization_id", orgId)
    .eq("status", "open");
  const { summarizeAr } = await import("@/lib/ar");
  // `today` was omitted here while `tz` sat in scope ninety lines above, so the
  // weekly digest counted overdue against the SERVER's day and mailed the owner
  // a number that disagreed with their own dashboard.
  const arSummary = summarizeAr((openInvoices ?? []) as any[], orgLocalDate(Date.now(), tz));
  const openArCents = arSummary.arOpenCents;
  const overdueInvoices = arSummary.overdueCount;
  // QA-P3: this was never read, and the alert below paired the overdue COUNT
  // with the total open balance instead. summarizeAr has returned both figures
  // all along.
  const overdueCents = arSummary.overdueCents;

  // At-risk (churn score >= 60)
  const { count: atRiskCount } = await supabaseAdmin
    .from("clients")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .eq("active", true)
    .gte("churn_score", 60);

  // Complaints — count QC tickets opened this week
  const { count: complaintsCountRaw } = await supabaseAdmin
    .from("qc_tickets")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .gte("created_at", weekStartIso);
  const complaintsCount = complaintsCountRaw ?? 0;

  // Top zones intentionally omitted — visits schema has no zone_id.
  const topZones: Array<{ name: string; revenueCents: number }> = [];

  // QA-P3: these sentences live in lib/digest-alerts.ts now, pure and tested.
  // The one that was wrong — the overdue figure — was wrong in an EMAILED
  // report with nothing able to notice, because computeDigestMetrics needs a
  // database and a live org to run, so every string it produced was only ever
  // checked by reading it.
  const alerts = buildDigestAlerts({
    overdueCount: overdueInvoices,
    // Was `openArCents`. The count of overdue invoices with the total of ALL
    // open ones attached: "10 overdue invoices totaling $2,725.00" when the
    // ten came to $2,550.00.
    overdueCents,
    complaintsCount,
    visitsSkipped,
    visitsCompleted,
  });

  // The refund gets its own tile whenever there is one, the same way /reports
  // splits gross / refunds / net. A single number that is simply smaller this
  // week tells an owner nothing about WHY, and "revenue fell" and "a customer
  // disputed a charge" call for completely different responses.
  const hadReversals = refundsCents !== 0 || prevRefundsCents !== 0;
  const stats: DigestStat[] = [
    {
      label: hadReversals ? "Revenue (net)" : "Revenue",
      value: fmt(revenueCents),
      delta: pct(revenueCents, prevRevenueCents),
    },
    ...(hadReversals
      ? [
          {
            label: "Refunds & chargebacks",
            value:
              refundsCents === 0
                ? "-"
                : refundsCents > 0
                  ? `-${fmt(refundsCents)}`
                  : `+${fmt(-refundsCents)}`,
          },
        ]
      : []),
    { label: "Visits done", value: String(visitsCompleted) },
    { label: "New clients", value: String(newClients ?? 0) },
    { label: "Open A/R", value: fmt(openArCents) },
    // Shown alongside Open A/R rather than instead of it. With the alert now
    // quoting the overdue figure and the table quoting the open one, an owner
    // reading "$2,550.00 overdue" above "$2,725.00 open" would otherwise have
    // two numbers and no way to tell whether they disagree. Only rendered when
    // something IS overdue, so a healthy week does not grow a "$0.00" row.
    ...(overdueInvoices > 0 ? [{ label: "Of which overdue", value: fmt(overdueCents) }] : []),
    { label: "At-risk", value: String(atRiskCount ?? 0) },
    { label: "Complaints", value: String(complaintsCount) },
  ];

  return {
    orgId,
    orgName: (org as any).name,
    weekLabel: fmtRange(weekStart, now),
    windowDays,
    stats,
    raw: {
      revenueCents,
      revenueGrossCents,
      refundsCents,
      prevRevenueCents,
      prevRevenueGrossCents,
      prevRefundsCents,
      visitsCompleted,
      visitsSkipped,
      newClients: newClients ?? 0,
      openArCents,
      overdueCents,
      atRiskCount: atRiskCount ?? 0,
      complaintsCount,
      overdueInvoices,
      topZones,
    },
    alerts,
  };
}

export type { DigestInsights } from "@/lib/digest-insights";

function hexToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sendDigestEmail(params: {
  orgId: string;
  recipient: string;
  metrics: DigestMetrics;
  insights: import("@/lib/digest-insights").DigestInsights;
}): Promise<{ ok: boolean; reason?: string; messageId?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const entry = TEMPLATES["weekly-digest"];
  if (!entry) return { ok: false, reason: "unknown_template" };

  const recipient = params.recipient.trim().toLowerCase();
  if (!recipient) return { ok: false, reason: "no_recipient" };

  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails")
    .select("email")
    .eq("email", recipient)
    .maybeSingle();
  if (suppressed) return { ok: false, reason: "suppressed" };

  // The business's logo and colour for the digest's header (#577). A read
  // that fails sends the digest without them rather than not at all.
  const { data: brand } = await supabaseAdmin
    .from("organizations")
    .select("logo_url, brand_color")
    .eq("id", params.orgId)
    .maybeSingle();

  const data = {
    siteName: SITE_NAME,
    orgName: params.metrics.orgName,
    orgLogoUrl: brand?.logo_url ?? null,
    orgBrandColor: brand?.brand_color ?? null,
    weekLabel: params.metrics.weekLabel,
    stats: params.metrics.stats,
    alerts: params.metrics.alerts,
    headline: params.insights.headline,
    insights: params.insights.insights,
    recommendations: params.insights.recommendations,
  };
  let html: string, text: string;
  try {
    const element = React.createElement(entry.component, data);
    html = await render(element);
    text = await render(element, EMAIL_TEXT_OPTIONS);
  } catch (e) {
    console.error("digest render failed", e);
    return { ok: false, reason: "render_failed" };
  }
  const subject = typeof entry.subject === "function" ? entry.subject(data) : entry.subject;

  const unsubscribeToken = hexToken();
  await supabaseAdmin
    .from("email_unsubscribe_tokens")
    .insert({ email: recipient, token: unsubscribeToken });

  const messageId = crypto.randomUUID();
  const idempotencyKey = `digest-${params.orgId}-${params.metrics.weekLabel}`;

  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: "weekly-digest",
    recipient_email: recipient,
    status: "pending",
  });

  const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to: recipient,
      from: `${params.metrics.orgName || SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text,
      purpose: "transactional",
      label: "weekly-digest",
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  });
  if (enqueueError) {
    console.error("digest enqueue failed", enqueueError);
    return { ok: false, reason: "enqueue_failed", messageId };
  }

  await supabaseAdmin
    .from("organizations")
    .update({ last_digest_sent_at: new Date().toISOString() })
    .eq("id", params.orgId);

  return { ok: true, messageId };
}
