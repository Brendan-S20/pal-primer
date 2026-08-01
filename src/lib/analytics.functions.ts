import { createServerFn } from "@tanstack/react-start";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Analytics is aggregate financial/business data — every function in this
// file is gated on view_financials, matching the /analytics route boundary.
//
// BUILD-1: and on the plan. These four are exactly what the pricing page sells
// as "Advanced analytics: cohort retention, zone profitability, churn drivers",
// included on Growth and above — the app was serving all of it on Launch. Both
// checks run on every call, in this one funnel, because a paywall the client
// can skip by calling the server function directly is not a paywall
// (guardrail 10.4).
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { orgId } = await requirePermission(supabase, userId, "view_financials");
  const { requireEntitlement } = await import("@/lib/entitlements.server");
  await requireEntitlement(orgId, "advanced_analytics");
  return orgId;
}

export const getCohortRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ monthsBack: z.number().int().min(1).max(24).default(12) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("client_cohort_retention", {
      _org_id: orgId,
      _months_back: data.monthsBack,
    });
    if (error) throw new Error(error.message);
    return {
      rows: (rows ?? []) as Array<{
        cohort_month: string;
        months_since: number;
        cohort_size: number;
        retained: number;
      }>,
    };
  });

export const getClientLtv = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ limit: z.number().int().min(1).max(200).default(25) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("client_ltv", {
      _org_id: orgId,
      _limit: data.limit,
    });
    if (error) throw new Error(error.message);

    type LtvRow = {
      client_id: string;
      display_name: string;
      tenure_days: number;
      revenue_cents: number;
      monthly_avg_cents: number;
      active: boolean;
    };
    const base = (rows ?? []) as LtvRow[];

    // IMP-10: lifetime value is the one figure where a refund matters most and
    // was least visible. `client_ltv` sums paid invoices with no date bound at
    // all, so a customer who was refunded in full still reads as the most
    // valuable account on the page — and "who are our best customers" is a
    // question people act on.
    //
    // Netted in TypeScript rather than in the RPC on purpose: reversals live in
    // review_items and are already read by one shared module. Teaching the SQL
    // to join them would be a second implementation of the same rule, which is
    // precisely what BUG-21 came from.
    //
    // The window is the whole life of the organization, because so is the
    // metric. Anything narrower would net a subset of refunds against the full
    // lifetime revenue and produce a number that is neither.
    const { loadOrgReversals, reversalsByClient } = await import("@/lib/reversals.server");
    const { data: org } = await context.supabase
      .from("organizations")
      .select("timezone, created_at")
      .eq("id", orgId)
      .maybeSingle();
    // "UTC" here while every other layer defaults to America/Chicago is a
    // disagreement in itself, and the window's end was the server's day.
    const timezone = (org as any)?.timezone || DEFAULT_ORG_TIMEZONE;
    const from = ((org as any)?.created_at ?? "2000-01-01").slice(0, 10);
    const to = orgToday(timezone);

    const reversalRows = await loadOrgReversals(context.supabase, { orgId, timezone, from, to });
    const byClient = await reversalsByClient(context.supabase, orgId, reversalRows);

    return {
      rows: base.map((r) => {
        const refunds = byClient.get(r.client_id)?.netCents ?? 0;
        const net = Math.max(Number(r.revenue_cents ?? 0) - refunds, 0);
        const months = Math.max(Number(r.tenure_days ?? 0) / 30.44, 1);
        return {
          ...r,
          refunds_cents: refunds,
          net_revenue_cents: net,
          // Recomputed from net rather than scaled: the RPC's monthly average
          // divides gross by tenure, so leaving it alone would put a corrected
          // total next to an uncorrected average of itself.
          net_monthly_avg_cents: Math.round(net / months),
        };
      }),
    };
  });

// IMP-10: this one is NOT revenue and deliberately gets no refunds line.
//
// `zone_profitability` sums `subscriptions.price_cents` for completed visits —
// the LIST PRICE of work done, not money that moved. It has never known about
// payment, discounts, credits, voided invoices or non-payment, so deducting
// refunds from it would imply a payment basis it does not have and make it
// look more authoritative than it is.
//
// The honest fix is the label, not the arithmetic: the UI now calls it booked
// service value. Same for the per-tech figure on /routes, which is the same
// formula computed a second time.
export const getZoneProfitability = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ from: z.string(), to: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("zone_profitability", {
      _org_id: orgId,
      _from: data.from,
      _to: data.to,
    });
    if (error) throw new Error(error.message);
    return {
      rows: (rows ?? []) as Array<{
        zone_id: string;
        zone_name: string;
        visit_count: number;
        completed_count: number;
        revenue_cents: number;
        avg_revenue_per_visit_cents: number;
      }>,
    };
  });

// IMP-10: `churn_drivers` groups by REASON, not by client, so a per-client
// refunds map cannot be joined to it without redoing the grouping in SQL — a
// second implementation of the netting rule, for a number that is an estimate
// driving retention outreach rather than anything reported. The label carries
// the caveat instead: gross, before refunds. Precision here is worth less than
// having one netting implementation.
export const getChurnDrivers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("churn_drivers", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return {
      rows: (rows ?? []) as Array<{
        reason: string;
        client_count: number;
        avg_score: number;
        revenue_at_risk_cents: number;
      }>,
    };
  });
