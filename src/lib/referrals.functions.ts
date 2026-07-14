import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Feature 2 (tenant side): the "Refer a business" program. A tenant shares
// /sign-up?ref=<code>; when the referred business becomes a paying customer
// they earn a percentage of its first payment (paid out manually in Phase 1).

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

export type MyReferralProgram = {
  code: string;
  rewardPercent: number;
  holdingDays: number;
  referrals: Array<{
    id: string;
    referred_org_name: string;
    status: string;
    flagged: boolean;
    reward_cents: number | null;
    eligible_at: string | null;
    paid_at: string | null;
    created_at: string;
  }>;
};

export const getMyReferralProgram = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyReferralProgram> => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);

    const { data: code, error: codeErr } = await supabase.rpc("get_or_create_org_referral_code", {
      _org_id: orgId,
    });
    if (codeErr) throw new Error(codeErr.message);

    const { data: settings } = await supabase
      .from("platform_referral_settings")
      .select("reward_percent, holding_days")
      .maybeSingle();

    const { data: referrals, error: refErr } = await supabase.rpc("get_my_tenant_referrals");
    if (refErr) throw new Error(refErr.message);

    return {
      code: code as string,
      rewardPercent: Number(settings?.reward_percent ?? 20),
      holdingDays: Number(settings?.holding_days ?? 45),
      referrals: referrals ?? [],
    };
  });
