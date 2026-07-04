import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for user");
  return data.organization_id as string;
}

const DAY = 86_400_000;

export type ChurnScored = {
  id: string;
  display_name: string;
  churn_score: number;
  churn_reason: string | null;
  churn_scored_at: string | null;
  last_visit_date: string | null;
  last_winback_sent_at: string | null;
  active: boolean;
};

/**
 * Heuristic churn scoring — no AI required. Weighted signals:
 *  - Days since last completed visit (0-40)
 *  - Skipped visits last 90d (0-20)
 *  - QC complaints last 90d (0-20)
 *  - Autopay failure count (0-15)
 *  - Negative credit balance / overdue (0-5)
 */
export const scoreChurnHeuristic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const now = Date.now();
    const since = new Date(now - 90 * DAY).toISOString().slice(0, 10);

    const { data: clients } = await supabase
      .from("clients")
      .select("id, autopay_failure_count, credit_balance_cents")
      .eq("organization_id", orgId)
      .eq("active", true);

    const { data: visits } = await supabase
      .from("visits")
      .select("client_id, status, scheduled_on, completed_at")
      .eq("organization_id", orgId)
      .gte("scheduled_on", since);

    const { data: tickets } = await supabase
      .from("qc_tickets")
      .select("client_id, created_at")
      .eq("organization_id", orgId)
      .gte("created_at", new Date(now - 90 * DAY).toISOString());

    const byClient = new Map<string, { skipped: number; complaints: number; lastCompleted: string | null }>();
    for (const c of clients ?? []) byClient.set(c.id, { skipped: 0, complaints: 0, lastCompleted: null });
    for (const v of visits ?? []) {
      const rec = byClient.get(v.client_id);
      if (!rec) continue;
      if (v.status === "skipped") rec.skipped++;
      if (v.status === "completed" && v.completed_at) {
        if (!rec.lastCompleted || v.completed_at > rec.lastCompleted) rec.lastCompleted = v.completed_at;
      }
    }
    for (const t of tickets ?? []) {
      const rec = byClient.get(t.client_id);
      if (rec) rec.complaints++;
    }

    let updated = 0;
    for (const c of clients ?? []) {
      const rec = byClient.get(c.id)!;
      const daysSince = rec.lastCompleted ? (now - new Date(rec.lastCompleted).getTime()) / DAY : 999;
      const gapScore = Math.min(40, Math.round((daysSince / 45) * 40));
      const skipScore = Math.min(20, rec.skipped * 5);
      const complaintScore = Math.min(20, rec.complaints * 8);
      const payScore = Math.min(15, (c.autopay_failure_count ?? 0) * 5);
      const balScore = (c.credit_balance_cents ?? 0) < -1000 ? 5 : 0;
      const score = Math.min(100, gapScore + skipScore + complaintScore + payScore + balScore);

      const reasons: string[] = [];
      if (gapScore >= 25) reasons.push(`no visit in ${Math.round(daysSince)}d`);
      if (skipScore > 0) reasons.push(`${rec.skipped} skip${rec.skipped === 1 ? "" : "s"}`);
      if (complaintScore > 0) reasons.push(`${rec.complaints} complaint${rec.complaints === 1 ? "" : "s"}`);
      if (payScore > 0) reasons.push(`${c.autopay_failure_count} payment fail(s)`);
      if (balScore > 0) reasons.push("past-due balance");
      const reason = reasons.join(" · ") || "healthy";

      await supabase
        .from("clients")
        .update({ churn_score: score, churn_reason: reason, churn_scored_at: new Date().toISOString() })
        .eq("id", c.id)
        .eq("organization_id", orgId);
      updated++;
    }
    return { scored: updated };
  });

export const listAtRiskClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("clients")
      .select("id, display_name, churn_score, churn_reason, churn_scored_at, last_winback_sent_at, active")
      .eq("organization_id", orgId)
      .eq("active", true)
      .gte("churn_score", 60)
      .order("churn_score", { ascending: false })
      .limit(200);
    if (error) throw new Error(error.message);

    // Last completed visit per client for context
    const ids = (data ?? []).map((c: any) => c.id);
    const lastVisitByClient = new Map<string, string>();
    if (ids.length) {
      const { data: vs } = await supabase
        .from("visits")
        .select("client_id, completed_at")
        .eq("organization_id", orgId)
        .in("client_id", ids)
        .eq("status", "completed")
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false });
      for (const v of vs ?? []) {
        if (!lastVisitByClient.has(v.client_id)) lastVisitByClient.set(v.client_id, v.completed_at);
      }
    }

    const rows: ChurnScored[] = (data ?? []).map((c: any) => ({
      id: c.id,
      display_name: c.display_name,
      churn_score: c.churn_score,
      churn_reason: c.churn_reason,
      churn_scored_at: c.churn_scored_at,
      last_visit_date: lastVisitByClient.get(c.id) ?? null,
      last_winback_sent_at: c.last_winback_sent_at,
      active: c.active,
    }));
    return { rows };
  });

function makePromoCode(clientName: string, pct: number) {
  const base = (clientName || "COMEBACK")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6) || "COMEBACK";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${pct}-${suffix}`;
}

export const sendWinBack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        discountPercent: z.number().int().min(5).max(50).default(20),
        expiresDays: z.number().int().min(7).max(90).default(30),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: client } = await supabase
      .from("clients")
      .select("id, display_name, primary_email, last_winback_sent_at")
      .eq("id", data.clientId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (!client) throw new Error("Client not found");
    if (!client.primary_email) throw new Error("Client has no email on file");

    // Cooldown: don't spam more than once per 30 days
    if (client.last_winback_sent_at) {
      const gap = (Date.now() - new Date(client.last_winback_sent_at).getTime()) / DAY;
      if (gap < 30) throw new Error(`Win-back already sent ${Math.round(gap)}d ago (30d cooldown).`);
    }

    // Create promo code
    const expiresAt = new Date(Date.now() + data.expiresDays * DAY).toISOString();
    const code = makePromoCode(client.display_name, data.discountPercent);
    const { error: pcErr } = await supabase.from("promo_codes").insert({
      organization_id: orgId,
      code,
      discount_type: "percent",
      discount_percent: data.discountPercent,
      applies_to: "subscription",
      description: `Win-back for ${client.display_name}`,
      expires_at: expiresAt,
      max_redemptions: 1,
      active: true,
      created_by: userId,
    });
    if (pcErr) throw new Error(`Promo create failed: ${pcErr.message}`);

    // Enqueue email
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const res = await enqueueAppEmail({
      organizationId: orgId,
      clientId: client.id,
      templateName: "win-back",
      notifyKey: "notify_email_win_back",
      idempotencyKey: `winback-${client.id}-${new Date().toISOString().slice(0, 10)}`,
      templateData: {
        discountPercent: data.discountPercent,
        promoCode: code,
        expiresOn: new Date(expiresAt).toLocaleDateString(),
      },
    });
    if (!res.ok) throw new Error(`Email not sent: ${res.reason}`);

    await supabase
      .from("clients")
      .update({ last_winback_sent_at: new Date().toISOString() })
      .eq("id", client.id)
      .eq("organization_id", orgId);

    return { ok: true, promoCode: code, expiresAt };
  });
