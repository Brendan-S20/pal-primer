import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const bootstrapSchema = z.object({
  orgName: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
});

export const bootstrapOrganization = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => bootstrapSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: orgId, error } = await supabase.rpc("bootstrap_organization", {
      _org_name: data.orgName,
      _display_name: data.displayName,
    });
    if (error) throw new Error(error.message);
    return { organizationId: orgId as string };
  });

export const getMyOrg = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: role, error: roleErr } = await supabase
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (roleErr) throw new Error(roleErr.message);
    if (!role) return { organization: null as null };

    const { data: org, error: orgErr } = await supabase
      .from("organizations")
      .select("id, name, active_client_count, billing_tier, plan_status, current_period_end, stripe_customer_id, stripe_subscription_id")
      .eq("id", role.organization_id)
      .single();
    if (orgErr) throw new Error(orgErr.message);

    return { organization: { ...org, role: role.role as string } };
  });

