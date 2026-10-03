import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { z } from "zod";

// Churn scoring, the at-risk roster, and win-back campaigns (which mint promo
// codes and email clients) are retention/financial operations — gate on
// view_financials so a tech/dispatcher token is rejected by the API, not just
// the route (I7). Matches analytics.functions.ts.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "view_financials")).orgId;
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
 * Churn scoring for Analytics. It had its own weights and wrote the same
 * churn_score / churn_reason columns as the Clients page's scorer, so a
 * client's number depended on which button was pressed last. Both now run
 * churn-run.server.ts, scored by churn-score.ts, which took this scorer's two
 * signals the other lacked: complaints and failed autopay charges.
 */
export const scoreChurnHeuristic = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { runChurnScoring } = await import("@/lib/churn-run.server");
    return runChurnScoring(supabase, orgId);
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

function makePromoCode(clientName: string, dollars: number) {
  const base = (clientName || "COMEBACK")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6) || "COMEBACK";
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${base}${dollars}-${suffix}`;
}

/**
 * Win-back offers are a DOLLAR amount, not a percentage. Two reasons, both
 * found by measuring rather than reasoning:
 *
 * 1. This function inserted `applies_to: "subscription"`, and the column
 *    carries CHECK (applies_to IN ('first_visit','recurring','one_time')).
 *    Every send raised "Promo create failed: new row violates check
 *    constraint". The button had never worked, for anyone, since it shipped.
 *    The insert happens before the email is enqueued, so at least nobody was
 *    ever mailed a code — the feature was simply inert.
 *
 * 2. It also asked for `discount_type: "percent"`, and at the time nothing in
 *    this system applied a percentage — `discount_percent` had no reader at
 *    all. Fixing only the CHECK violation would have started mailing lapsed
 *    customers codes their portal rejects: worse than inert.
 *
 * Percent codes redeem now (migration 20260807030000), against the customer's
 * per-visit plan price. Win-back stays a dollar amount anyway, and that is now
 * a choice rather than a limitation: the base a percentage would resolve
 * against is ONE VISIT, so "20% off" to a lapsed customer is a few dollars, not
 * the month of service the phrase implies. `subscriptions.price_cents` is per
 * visit and no visits-per-cycle rule exists anywhere in this codebase. The
 * offer is the number the sender types, and the sender can see it.
 */
export const sendWinBack = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        // $1 to $200. Credited to the account on redemption, in full.
        discountCents: z.number().int().min(100).max(20000).default(1500),
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
    const dollars = Math.round(data.discountCents / 100);
    const code = makePromoCode(client.display_name, dollars);
    const { error: pcErr } = await supabase.from("promo_codes").insert({
      organization_id: orgId,
      code,
      discount_type: "fixed",
      discount_value_cents: data.discountCents,
      // 'one_time' is one of the three values the CHECK allows, and it is the
      // true one: a win-back is a single credit, not a standing discount.
      applies_to: "one_time",
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
        // The email states the same number the code is worth. It previously
        // said "20% off your next month of service" for a code that credited
        // nothing at all.
        discountAmount: `$${(data.discountCents / 100).toFixed(2).replace(/\.00$/, "")}`,
        promoCode: code,
        expiresOn: new Date(expiresAt).toLocaleDateString(),
      },
      // Explicit staff-initiated win-back — manual send: bypasses and clears
      // the imported comms hold.
      manual: true,
    });
    if (!res.ok) throw new Error(`Email not sent: ${res.reason}`);

    await supabase
      .from("clients")
      .update({ last_winback_sent_at: new Date().toISOString() })
      .eq("id", client.id)
      .eq("organization_id", orgId);

    return { ok: true, promoCode: code, expiresAt };
  });
