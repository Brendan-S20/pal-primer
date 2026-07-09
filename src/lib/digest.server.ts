// Weekly business digest — server-only helpers.
// Computes metrics for the past 7 days for one org, calls Lovable AI for
// insights, and enqueues a digest email to the configured recipient.

import * as React from "react";
import { render } from "react-email";
import { generateText, Output } from "ai";
import { z } from "zod";
import { createLovableAiGatewayProvider } from "@/lib/ai-gateway.server";
import { TEMPLATES } from "@/lib/email-templates/registry";

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
    revenueCents: number;
    prevRevenueCents: number;
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
  return `${m(s)} – ${m(e)}`;
}

export async function computeDigestMetrics(orgId: string): Promise<DigestMetrics | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  if (!org) return null;

  const now = Date.now();
  const weekStart = now - 7 * DAY;
  const prevStart = now - 14 * DAY;
  const weekStartIso = new Date(weekStart).toISOString();
  const prevStartIso = new Date(prevStart).toISOString();
  const weekStartDate = new Date(weekStart).toISOString().slice(0, 10);
  const prevStartDate = new Date(prevStart).toISOString().slice(0, 10);
  const todayDate = new Date(now).toISOString().slice(0, 10);

  // Revenue (paid payments) — this week & previous week for WoW
  const [{ data: payThis }, { data: payPrev }] = await Promise.all([
    supabaseAdmin
      .from("payments")
      .select("amount_cents, paid_at")
      .eq("organization_id", orgId)
      .eq("status", "succeeded")
      .gte("paid_at", weekStartIso),
    supabaseAdmin
      .from("payments")
      .select("amount_cents, paid_at")
      .eq("organization_id", orgId)
      .eq("status", "succeeded")
      .gte("paid_at", prevStartIso)
      .lt("paid_at", weekStartIso),
  ]);
  const revenueCents = (payThis ?? []).reduce((s: number, p: any) => s + (p.amount_cents ?? 0), 0);
  const prevRevenueCents = (payPrev ?? []).reduce(
    (s: number, p: any) => s + (p.amount_cents ?? 0),
    0,
  );

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

  // Open AR
  const { data: openInvoices } = await supabaseAdmin
    .from("invoices")
    .select("total_cents, issued_at, status")
    .eq("organization_id", orgId)
    .eq("status", "open");
  const openArCents = (openInvoices ?? []).reduce(
    (s: number, i: any) => s + (i.total_cents ?? 0),
    0,
  );
  const overdueInvoices = (openInvoices ?? []).filter(
    (i: any) => i.issued_at && new Date(i.issued_at).getTime() < now - 7 * DAY,
  ).length;

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
  if (visitsSkipped > 0 && visitsCompleted > 0 && visitsSkipped / (visitsSkipped + visitsCompleted) > 0.1) {
    const rate = Math.round((visitsSkipped / (visitsSkipped + visitsCompleted)) * 100);
    alerts.push(`Skip rate is ${rate}% — above the 10% threshold.`);
  }

  const stats: DigestStat[] = [
    { label: "Revenue", value: fmt(revenueCents), delta: pct(revenueCents, prevRevenueCents) },
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
      prevRevenueCents,
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
}

export async function generateDigestInsights(m: DigestMetrics): Promise<DigestInsights> {
  const key = process.env.LOVABLE_API_KEY;
  const fallback: DigestInsights = {
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

  try {
    const gateway = createLovableAiGatewayProvider(key);
    const prompt = [
      `You are analyzing weekly performance for ${m.orgName}, a residential dog-waste cleanup business.`,
      `Week: ${m.weekLabel}.`,
      `Metrics:`,
      `- Revenue: ${fmt(m.raw.revenueCents)} (prev week ${fmt(m.raw.prevRevenueCents)}, ${pct(m.raw.revenueCents, m.raw.prevRevenueCents)})`,
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
      "- recommendations: 2-3 specific next actions the owner can take THIS week, each ≤ 140 chars.",
      "Do not restate every metric. Avoid hype. Be direct.",
    ]
      .filter(Boolean)
      .join("\n");

    const { experimental_output } = (await generateText({
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

    if (experimental_output) {
      return {
        headline: experimental_output.headline,
        insights: experimental_output.insights,
        recommendations: experimental_output.recommendations,
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
