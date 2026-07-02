import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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

export type FranchiseRow = {
  organization_id: string;
  organization_name: string;
  active_clients: number;
  visits_today: number;
  visits_completed_today: number;
  revenue_mtd_cents: number;
  ar_open_cents: number;
  tech_count: number;
};

export const getFranchiseContext = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("id, name, is_franchise_parent, parent_organization_id")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    const { data: children } = await context.supabase
      .from("organizations")
      .select("id, name")
      .eq("parent_organization_id", orgId)
      .order("name");
    return {
      org,
      isParent: !!org?.is_franchise_parent || (children ?? []).length > 0,
      children: children ?? [],
    };
  });

export const getFranchiseRollup = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data, error } = await context.supabase.rpc("franchise_rollup", { _parent_org: orgId });
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as FranchiseRow[] };
  });

export const markSelfAsFranchiseParent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("mark_franchise_parent", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return { ok: true, orgId };
  });
