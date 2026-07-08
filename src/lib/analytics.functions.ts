import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

// Analytics is aggregate financial/business data — every function in this
// file is gated on view_financials, matching the /analytics route boundary.
async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await requirePermission(supabase, userId, "view_financials")).orgId;
}

export const getCohortRetention = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ monthsBack: z.number().int().min(1).max(24).default(12) }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("client_cohort_retention", {
      _org_id: orgId,
      _months_back: data.monthsBack,
    });
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as Array<{ cohort_month: string; months_since: number; cohort_size: number; retained: number }> };
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
    return { rows: (rows ?? []) as Array<{ client_id: string; display_name: string; tenure_days: number; revenue_cents: number; monthly_avg_cents: number; active: boolean }> };
  });

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
    return { rows: (rows ?? []) as Array<{ zone_id: string; zone_name: string; visit_count: number; completed_count: number; revenue_cents: number; avg_revenue_per_visit_cents: number }> };
  });

export const getChurnDrivers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("churn_drivers", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { rows: (rows ?? []) as Array<{ reason: string; client_count: number; avg_score: number; revenue_at_risk_cents: number }> };
  });
