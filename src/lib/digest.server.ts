// Weekly business digest — server-only helpers.
// Computes metrics for the past 7 days for one org, calls Lovable AI for
// insights, and enqueues a digest email to the configured recipient.

import * as React from "react";
import { orgLocalDay } from "@/lib/org-day";
import { render } from "react-email";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { grossReceivedCents, receivedPaymentStatuses } from "@/lib/revenue";

const MODEL_ID = "google/gemini-3-flash-preview";
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
      .select("amount_cents, status, paid_at")
      .eq("organization_id", orgId)
      .in("status", receivedPaymentStatuses())
      .gte("paid_at", weekStartIso),
    supabaseAdmin
      .from("payments")
      .select("amount_cents, status, paid_at")
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
    .select("total_cents, credit_applied_cents, due_on, issued_at, status")
    .eq("organization_id", orgId)
    .eq("status", "open");
  const { summarizeAr } = await import("@/lib/ar");
  // `today` was omitted here while `tz` sat in scope ninety lines above, so the
  // weekly digest counted overdue against the SERVER's day and mailed the owner
  // a number that disagreed with their own dashboard.
  const arSummary = summarizeAr((openInvoices ?? []) as any[], orgLocalDate(Date.now(), tz));
  const openArCents = arSummary.arOpenCents;
  const overdueInvoices = arSummary.overdueCount;

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

  const alerts: string[] = [];
  if (overdueInvoices > 0) {
    alerts.push(
      `${overdueInvoices} overdue invoice${overdueInvoices > 1 ? "s" : ""} totaling ${fmt(openArCents)}.`,
    );
  }
  if (complaintsCount > 0) {
    alerts.push(
      `${complaintsCount} client complaint${complaintsCount > 1 ? "s" : ""} logged this week.`,
    );
  }
  if (
    visitsSkipped > 0 &&
    visitsCompleted > 0 &&
    visitsSkipped / (visitsSkipped + visitsCompleted) > 0.1
  ) {
    const rate = Math.round((visitsSkipped / (visitsSkipped + visitsCompleted)) * 100);
    alerts.push(`Skip rate is ${rate}%, above the 10% threshold.`);
  }

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
    { label: "At-risk", value: String(atRiskCount ?? 0) },
    { label: "Complaints", value: String(complaintsCount) },
  ];

  return {
    orgId,
    orgName: (org as any).name,
    weekLabel: fmtRange(weekStart, now),
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
      atRiskCount: atRiskCount ?? 0,
      complaintsCount,
      overdueInvoices,
      topZones,
    },
    alerts,
  };
}

export interface DigestInsights {
  headline: string;
  insights: string[];
  recommendations: string[];
  /** True when the model actually produced this. False means the deterministic
   *  fallback below did — the key was missing, or the call failed. The digest
   *  email ignores this (it must go out either way), but any SCREEN showing this
   *  content has to be able to say which it is, rather than presenting
   *  arithmetic as analysis. */
  aiGenerated: boolean;
}

/**
 * @param feature BUILD-2: which allowance this call spends. The same analysis
 *   engine backs the weekly digest and the on-demand Business Advisor, and an
 *   owner asking "what used my allowance" deserves the two told apart —
 *   especially since one of them fires from cron without being asked.
 */
export async function generateDigestInsights(
  m: DigestMetrics,
  feature: import("@/lib/ai-usage").AiFeature = "weekly_digest",
): Promise<DigestInsights> {
  const key = process.env.LOVABLE_API_KEY;
  const fallback: DigestInsights = {
    aiGenerated: false,
    headline: `Revenue of ${fmt(m.raw.revenueCents)} across ${m.raw.visitsCompleted} completed visits.`,
    insights: [
      `Compared to last week, revenue moved ${pct(m.raw.revenueCents, m.raw.prevRevenueCents)}.`,
      `You added ${m.raw.newClients} new client${m.raw.newClients === 1 ? "" : "s"} and completed ${m.raw.visitsCompleted} visit${m.raw.visitsCompleted === 1 ? "" : "s"}.`,
    ],
    recommendations: m.alerts.length
      ? m.alerts.slice(0, 3)
      : [
          "Confirm next week's schedule and send route reminders to techs.",
          m.raw.atRiskCount > 0
            ? `Review the ${m.raw.atRiskCount} at-risk client${m.raw.atRiskCount === 1 ? "" : "s"} in Analytics → Win-back.`
            : "Ask a happy client this week for a review.",
        ],
  };
  if (!key) return fallback;

  // BUILD-7: AI is paid-only, and this runs unattended from cron. Skipping into
  // the fallback the function already builds means a trial org still gets its
  // digest — with real metrics and rule-based advice — just without the model.
  // Throwing here would fail the whole weekly run for every org behind the
  // first trial account in the loop.
  const { orgMayUseAi } = await import("@/lib/ai-access.server");
  if (!(await orgMayUseAi(m.orgId))) return fallback;

  try {
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = [
      `You are analyzing business performance for ${m.orgName}, a residential dog-waste cleanup business.`,
      `Period: ${m.weekLabel}.`,
      `Metrics:`,
      `- Revenue (net of refunds): ${fmt(m.raw.revenueCents)} (prev week ${fmt(m.raw.prevRevenueCents)}, ${pct(m.raw.revenueCents, m.raw.prevRevenueCents)})`,
      // Given the components, the model can say a drop was a dispute rather
      // than lost business. Given only the net it would invent a reason.
      m.raw.refundsCents !== 0 || m.raw.prevRefundsCents !== 0
        ? `- Of which refunds/chargebacks: ${fmt(m.raw.refundsCents)} this week off ${fmt(m.raw.revenueGrossCents)} collected (prev week ${fmt(m.raw.prevRefundsCents)} off ${fmt(m.raw.prevRevenueGrossCents)})`
        : "",
      `- Visits completed: ${m.raw.visitsCompleted}`,
      `- Visits skipped/no-show: ${m.raw.visitsSkipped}`,
      `- New clients: ${m.raw.newClients}`,
      `- Open A/R: ${fmt(m.raw.openArCents)} across ${m.raw.overdueInvoices} overdue invoices`,
      `- At-risk clients (churn score ≥ 60): ${m.raw.atRiskCount}`,
      `- Complaints logged: ${m.raw.complaintsCount}`,
      m.raw.topZones.length
        ? `- Top zones by visit volume: ${m.raw.topZones.map((z) => `${z.name} (${z.revenueCents})`).join(", ")}`
        : "",
      "",
      "Return concise, plain-language output for the owner:",
      "- headline: one sentence, ≤ 120 chars, the single most important takeaway.",
      "- insights: 2-3 short bullet points, each ≤ 140 chars, quantitative when possible.",
      "- recommendations: 2-3 specific next actions the owner can take now, each ≤ 140 chars.",
      "Do not restate every metric. Avoid hype. Be direct.",
    ]
      .filter(Boolean)
      .join("\n");

    const result = (await generateText({
      model: gateway(MODEL_ID),
      prompt,
      experimental_output: Output.object({
        schema: z.object({
          headline: z.string().min(3).max(200),
          insights: z.array(z.string().min(3).max(200)).min(1).max(4),
          recommendations: z.array(z.string().min(3).max(200)).min(1).max(4),
        }),
      }),
    } as any)) as any;
    const { experimental_output } = result;

    // BUILD-2. After the call, so a provider failure that drops into the
    // deterministic fallback below spends no allowance — the org got
    // arithmetic, not analysis, and billing for that would be charging for the
    // thing we failed to deliver.
    void (async () => {
      const [{ tokensFromAiSdkResult }, { recordAiUsage }] = await Promise.all([
        import("@/lib/ai-usage"),
        import("@/lib/ai-usage.server"),
      ]);
      await recordAiUsage({
        orgId: m.orgId,
        feature,
        provider: "lovable-gateway",
        model: MODEL_ID,
        ...tokensFromAiSdkResult(result),
      });
    })().catch((e) => console.error("[digest] metering failed", e));

    if (experimental_output) {
      return {
        headline: experimental_output.headline,
        insights: experimental_output.insights,
        recommendations: experimental_output.recommendations,
        aiGenerated: true,
      };
    }
    return fallback;
  } catch (e) {
    console.error("digest AI failed", e);
    return fallback;
  }
}

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
  insights: DigestInsights;
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

  const data = {
    siteName: SITE_NAME,
    orgName: params.metrics.orgName,
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
    text = await render(element, { plainText: true });
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
