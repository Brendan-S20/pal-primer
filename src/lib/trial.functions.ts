import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { aiAvailableFor, trialStateFor, type TrialState } from "@/lib/trial";

// BUILD-7 — the trial state, for the banner and anything that needs to know
// whether AI is available before offering it.
//
// Deliberately NOT gated on a permission. Every role sees the banner: a tech
// who cannot open billing still benefits from knowing why the AI button is
// disabled, and "your trial ends in 3 days" is not confidential. What it does
// not expose is any money figure — that stays behind view_financials on the
// billing page.

export type TrialView = TrialState & {
  aiAvailable: boolean;
  /** Whether this caller can act on the banner's call to action. Owners see
   *  "Add a payment method"; everyone else is told who to ask, rather than
   *  being handed a button that will refuse them. */
  canManageBilling: boolean;
};

export const getTrialState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<TrialView | null> => {
    const { supabase, userId } = context;
    const { orgId, role } = await resolveCaller(supabase, userId);
    if (!orgId) return null;

    const { data } = await supabase
      .from("organizations")
      .select("plan_status, billing_status, trial_ends_at, stripe_subscription_id, created_at")
      .eq("id", orgId)
      .maybeSingle();
    if (!data) return null;

    const org = data as {
      plan_status: string | null;
      billing_status: string | null;
      trial_ends_at: string | null;
      stripe_subscription_id: string | null;
      created_at: string | null;
    };
    const state = trialStateFor({
      planStatus: org.plan_status,
      billingStatus: org.billing_status,
      trialEndsAt: org.trial_ends_at,
      hasSubscription: !!org.stripe_subscription_id,
      createdAt: org.created_at,
    });

    const { hasPermission } = await import("@/lib/permissions");
    return {
      ...state,
      aiAvailable: aiAvailableFor(state),
      canManageBilling: hasPermission(role, "manage_org_billing"),
    };
  });
