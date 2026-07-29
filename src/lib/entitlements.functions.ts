import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { PLAN_ENTITLEMENTS, type Entitlement, type PlanTier } from "@/lib/entitlements";

// BUILD-1 — what the CURRENT org's plan includes, for rendering.
//
// Read-only and rendering-only. The gate is requireEntitlement() inside each
// feature's own server functions; this exists so a locked screen can say
// "included on Growth" instead of throwing an error at someone who did nothing
// wrong. Any UI built on this is a courtesy, never the enforcement — the
// enforcement has to survive someone calling the server function directly.
//
// No permission requirement beyond membership: every role in an org can be told
// what that org is paying for, and the same list is on the public pricing page.

export type MyEntitlements = {
  tier: PlanTier;
  entitlements: Entitlement[];
};

export const getMyEntitlements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyEntitlements> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { planTierForOrg } = await import("@/lib/entitlements.server");
    const tier = await planTierForOrg(orgId);
    return { tier, entitlements: [...PLAN_ENTITLEMENTS[tier]] };
  });
