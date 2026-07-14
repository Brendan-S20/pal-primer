import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Feature 2 (platform side): the operational backbone for the Phase-1 manual
// payout process — who referred whom, conversion status, reward owed, payout
// bookkeeping, and the program's tunable settings.

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

async function audit(
  supabaseAdmin: any,
  actor_user_id: string,
  organization_id: string | null,
  action: string,
  before_json: any,
  after_json: any,
) {
  try {
    await supabaseAdmin.from("platform_admin_audit").insert({
      actor_user_id,
      organization_id,
      action,
      before_json,
      after_json,
    });
  } catch {
    /* ignore */
  }
}

export type PlatformReferralRow = {
  id: string;
  referrer_org_id: string;
  referrer_org_name: string;
  referred_org_id: string;
  referred_org_name: string;
  referred_plan_status: string | null;
  code_used: string;
  status: string;
  flagged: boolean;
  flag_reason: string | null;
  converted_at: string | null;
  first_payment_cents: number | null;
  reward_percent: number | null;
  reward_cents: number | null;
  eligible_at: string | null;
  paid_at: string | null;
  paid_note: string | null;
  created_at: string;
};

export type ReferralSettings = {
  reward_percent: number;
  holding_days: number;
  volume_flag_threshold: number;
};

export const listPlatformReferrals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{ referrals: PlatformReferralRow[]; settings: ReferralSettings }> => {
      await assertPlatformAdmin(context.supabase, context.userId);
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

      const [refRes, settingsRes] = await Promise.all([
        supabaseAdmin
          .from("tenant_referrals")
          .select("*")
          .order("created_at", { ascending: false }),
        supabaseAdmin
          .from("platform_referral_settings")
          .select("reward_percent, holding_days, volume_flag_threshold")
          .maybeSingle(),
      ]);
      if (refRes.error) throw new Error(refRes.error.message);

      const rows = refRes.data ?? [];
      const orgIds = [...new Set(rows.flatMap((r: any) => [r.referrer_org_id, r.referred_org_id]))];
      const { data: orgs } = orgIds.length
        ? await supabaseAdmin.from("organizations").select("id, name, plan_status").in("id", orgIds)
        : { data: [] as any[] };
      const orgById = new Map((orgs ?? []).map((o: any) => [o.id, o]));

      return {
        referrals: rows.map((r: any) => ({
          ...r,
          referrer_org_name: orgById.get(r.referrer_org_id)?.name ?? "(deleted)",
          referred_org_name: orgById.get(r.referred_org_id)?.name ?? "(deleted)",
          referred_plan_status: orgById.get(r.referred_org_id)?.plan_status ?? null,
        })),
        settings: {
          reward_percent: Number(settingsRes.data?.reward_percent ?? 20),
          holding_days: Number(settingsRes.data?.holding_days ?? 45),
          volume_flag_threshold: Number(settingsRes.data?.volume_flag_threshold ?? 5),
        },
      };
    },
  );

export const updateReferralSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        rewardPercent: z.number().min(0).max(100),
        holdingDays: z.number().int().min(0).max(365),
        volumeFlagThreshold: z.number().int().min(1).max(1000),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before } = await supabaseAdmin
      .from("platform_referral_settings")
      .select("*")
      .maybeSingle();
    const { error } = await supabaseAdmin
      .from("platform_referral_settings")
      .update({
        reward_percent: data.rewardPercent,
        holding_days: data.holdingDays,
        volume_flag_threshold: data.volumeFlagThreshold,
        updated_at: new Date().toISOString(),
      })
      .eq("id", true);
    if (error) throw new Error(error.message);
    await audit(supabaseAdmin, context.userId, null, "referral_settings_update", before, data);
    return { ok: true };
  });

const referralActionSchema = z.object({
  referralId: z.string().uuid(),
  action: z.enum(["mark_paid", "reject", "unflag"]),
  note: z.string().max(500).optional(),
});

export const actOnReferral = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => referralActionSchema.parse(d))
  .handler(async ({ data, context }) => {
    await assertPlatformAdmin(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: before, error: readErr } = await supabaseAdmin
      .from("tenant_referrals")
      .select("*")
      .eq("id", data.referralId)
      .maybeSingle();
    if (readErr) throw new Error(readErr.message);
    if (!before) throw new Error("Referral not found");

    const nowIso = new Date().toISOString();
    let patch: {
      status?: string;
      paid_at?: string;
      paid_note?: string | null;
      flag_reason?: string | null;
      flagged?: boolean;
      updated_at: string;
    };
    if (data.action === "mark_paid") {
      if (before.status !== "converted")
        throw new Error("Only converted referrals can be marked paid");
      patch = { status: "paid", paid_at: nowIso, paid_note: data.note ?? null, updated_at: nowIso };
    } else if (data.action === "reject") {
      if (before.status === "paid") throw new Error("Already paid — can't reject");
      patch = {
        status: "rejected",
        flag_reason: data.note ?? before.flag_reason,
        updated_at: nowIso,
      };
    } else {
      patch = { flagged: false, flag_reason: null, updated_at: nowIso };
    }

    const { error } = await supabaseAdmin
      .from("tenant_referrals")
      .update(patch)
      .eq("id", data.referralId);
    if (error) throw new Error(error.message);
    await audit(
      supabaseAdmin,
      context.userId,
      before.referrer_org_id,
      `referral_${data.action}`,
      before,
      patch,
    );
    return { ok: true };
  });
