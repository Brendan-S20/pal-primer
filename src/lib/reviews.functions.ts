import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Send an SMS asking the client to leave a Google review. Idempotent (90-day window). */
export const sendReviewRequest = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        visitId: z.string().uuid().optional(),
        force: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, primary_phone, sms_opt_out, display_name, review_asked_at")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (!client.primary_phone) throw new Error("Client has no phone number on file");
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS");

    if (!data.force && client.review_asked_at) {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000;
      if (new Date(client.review_asked_at).getTime() > ninetyDaysAgo) {
        throw new Error("Review already requested from this client in the last 90 days");
      }
    }

    const { data: org, error: oErr } = await supabase
      .from("organizations")
      .select("name, sms_from_number, google_review_url, review_ask_template")
      .eq("id", client.organization_id)
      .single();
    if (oErr) throw new Error(oErr.message);
    // Review asks are automated notifications → PLATFORM Twilio sender.
    const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
    const reviewFrom = platformTwilioFrom() ?? org.sms_from_number ?? null;
    if (!reviewFrom)
      throw new Error("No SMS sender is configured for notifications (Settings → SMS)");
    if (!org.google_review_url)
      throw new Error("Add a Google review URL in Settings → Reviews first");

    const firstName = (client.display_name ?? "").split(/\s+/)[0] || "there";
    const template =
      org.review_ask_template?.trim() ||
      `Hi {name}, thanks for choosing ${org.name ?? "us"}! If we did a great job, a quick review would mean the world: {link} — Reply STOP to opt out.`;
    const body = template.replace(/\{name\}/g, firstName).replace(/\{link\}/g, org.google_review_url);

    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", client.organization_id)
      .maybeSingle();

    const { sendTwilioSms } = await import("@/lib/twilio.server");
    let sid: string | null = null;
    let status = "queued";
    let errorText: string | null = null;
    try {
      const res = await sendTwilioSms({
        from: reviewFrom,
        to: client.primary_phone,
        body,
      });
      sid = res.sid;
      status = res.status || "sent";
    } catch (e: any) {
      errorText = e?.message ?? String(e);
      status = "failed";
    }

    await supabase.from("messages").insert({
      organization_id: client.organization_id,
      client_id: client.id,
      visit_id: data.visitId ?? null,
      staff_id: staff?.id ?? null,
      direction: "outbound",
      body,
      from_number: reviewFrom,
      to_number: client.primary_phone,
      twilio_sid: sid,
      status: status as any,
      error: errorText,
    });

    if (errorText) throw new Error(errorText);

    await supabase.rpc("mark_review_asked", { _client_id: data.clientId });
    return { ok: true, body };
  });

/** Redeem a referral code for an existing client — grants credit to both parties. */
export const applyReferralCode = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ clientId: z.string().uuid(), code: z.string().trim().min(3).max(24) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: result, error } = await context.supabase.rpc("apply_referral_code", {
      _new_client_id: data.clientId,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    return result as { referrer_id: string; reward_cents: number };
  });

/** Save org-level review settings. */
export const updateReviewSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        organizationId: z.string().uuid(),
        googleReviewUrl: z.string().trim().url().max(500).nullable(),
        reviewAskEnabled: z.boolean(),
        referralRewardCents: z.number().int().min(0).max(1_000_00),
        reviewAskTemplate: z.string().trim().max(500).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("organizations")
      .update({
        google_review_url: data.googleReviewUrl,
        review_ask_enabled: data.reviewAskEnabled,
        referral_reward_cents: data.referralRewardCents,
        review_ask_template: data.reviewAskTemplate,
      })
      .eq("id", data.organizationId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getReviewSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: staff } = await context.supabase
      .from("staff")
      .select("organization_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!staff) return null;
    const { data, error } = await context.supabase
      .from("organizations")
      .select("id, name, google_review_url, review_ask_enabled, referral_reward_cents, review_ask_template, sms_from_number")
      .eq("id", staff.organization_id)
      .single();
    if (error) throw new Error(error.message);
    return data;
  });

/** Referrals leaderboard for the org (top referrers by count). */
export const getReferralStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: staff } = await context.supabase
      .from("staff")
      .select("organization_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!staff) return { top: [] as Array<{ id: string; display_name: string; count: number }> };

    const { data, error } = await context.supabase
      .from("clients")
      .select("id, display_name, referred_by_client_id")
      .eq("organization_id", staff.organization_id)
      .not("referred_by_client_id", "is", null);
    if (error) throw new Error(error.message);

    const counts = new Map<string, number>();
    for (const row of data ?? []) {
      const k = row.referred_by_client_id as string;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ids = [...counts.keys()];
    if (!ids.length) return { top: [] };
    const { data: refs } = await context.supabase
      .from("clients")
      .select("id, display_name")
      .in("id", ids);
    const top = (refs ?? [])
      .map((r) => ({ id: r.id, display_name: r.display_name, count: counts.get(r.id) ?? 0 }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    return { top };
  });
