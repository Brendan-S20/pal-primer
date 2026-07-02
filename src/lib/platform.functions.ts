import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export type PlatformOrgRow = {
  organization_id: string;
  organization_name: string;
  billing_tier: string | null;
  plan_status: string | null;
  active_clients: number;
  users_count: number;
  revenue_mtd_cents: number;
  ar_open_cents: number;
  created_at: string;
};

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const getPlatformContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("is_platform_admin", {
      _user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    return { isPlatformAdmin: !!data };
  });

export const getPlatformStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("platform_org_stats");
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as PlatformOrgRow[] };
  });

const updatePlanSchema = z.object({
  organization_id: z.string().uuid(),
  billing_tier: z.string().min(1).max(50).nullable(),
  plan_status: z.enum(["trialing", "active", "past_due", "canceled", "paused"]).nullable(),
});

export const updateOrgPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => updatePlanSchema.parse(data))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const patch: { billing_tier?: string; plan_status?: any } = {};
    if (data.billing_tier !== null) patch.billing_tier = data.billing_tier;
    if (data.plan_status !== null) patch.plan_status = data.plan_status;
    const { error } = await supabaseAdmin
      .from("organizations")
      .update(patch)
      .eq("id", data.organization_id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
