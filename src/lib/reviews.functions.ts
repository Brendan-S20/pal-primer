import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

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
      .select("id, organization_id, primary_phone, sms_opt_out, primary_email, email_opt_out, display_name, review_asked_at, comms_paused")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    if (!data.force && client.review_asked_at) {
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000;
      if (new Date(client.review_asked_at).getTime() > ninetyDaysAgo) {
        throw new Error("Review already requested from this client in the last 90 days");
      }
    }

    const { data: org, error: oErr } = await supabase
      .from("organizations")
      .select("name, google_review_url, review_ask_template")
      .eq("id", client.organization_id)
      .single();
    if (oErr) throw new Error(oErr.message);
    if (!org.google_review_url)
      throw new Error("Add a Google review URL in Settings → Reviews & referrals first");

    // Review asks go out on the tenant's OWN connected Twilio number; when they
    // haven't connected one, fall back to email — never the platform SMS number.
    const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
    const tenant = await resolveOrgTwilioConfig(client.organization_id);
    const firstName = (client.display_name ?? "").split(/\s+/)[0] || "there";

    // Consent, not merely the absence of a STOP. Asked through SQL so this
    // path and every other one apply the same rule (30513).
    const { data: mayTextReview } = await (supabase as any).rpc("client_may_be_texted", {
      _client_id: client.id,
    });
    if (tenant && mayTextReview && client.primary_phone) {
      const template =
        org.review_ask_template?.trim() ||
        `Hi {name}, thanks for choosing ${org.name ?? "us"}! If we did a great job, a quick review would mean the world: {link} Reply STOP to opt out.`;
      const body = template.replace(/\{name\}/g, firstName).replace(/\{link\}/g, org.google_review_url);
      const fromNumber = tenant.from ?? null;

      const { data: staff } = await supabase
        .from("staff").select("id").eq("user_id", userId).eq("organization_id", client.organization_id).maybeSingle();

      const { sendTwilioSms } = await import("@/lib/twilio.server");
      let sid: string | null = null;
      let status = "queued";
      let errorText: string | null = null;
      try {
        const res = await sendTwilioSms({
          to: client.primary_phone,
          body,
          from: fromNumber ?? undefined,
          messagingServiceSid: tenant.messagingServiceSid ?? undefined,
          credentials: { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken },
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
        from_number: fromNumber,
        to_number: client.primary_phone,
        twilio_sid: sid,
        status: status as any,
        error: errorText,
      });
      if (errorText) throw new Error(errorText);
      // Explicit user-initiated send → lift the imported comms hold.
      if (client.comms_paused) {
        await supabase.from("clients").update({ comms_paused: false }).eq("id", client.id);
      }
      await supabase.rpc("mark_review_asked", { _client_id: data.clientId });
      return { ok: true, channel: "sms" as const, body };
    }

    // Email fallback (no tenant Twilio connected, or SMS not available).
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const res = await enqueueAppEmail({
      organizationId: client.organization_id,
      clientId: client.id,
      templateName: "review-request",
      notifyKey: "notify_email_review_request",
      idempotencyKey: `review-${client.id}-${new Date().toISOString().slice(0, 10)}`,
      templateData: { reviewUrl: org.google_review_url },
      // Explicit staff action from the client page — bypasses (and on
      // success clears) the imported comms hold.
      manual: true,
    });
    if (!res.ok) {
      const msg =
        res.reason === "no_recipient"
          ? "This client has no email on file and your Twilio isn't connected. Add an email, or connect your Twilio in Settings → SMS."
          : res.reason === "client_opted_out"
            ? "This client has opted out of email."
            : res.reason === "org_toggle_off"
              ? "Review-request emails are turned off in Settings."
              : "Couldn't send the review request.";
      throw new Error(msg);
    }
    await supabase.rpc("mark_review_asked", { _client_id: data.clientId });
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId: client.organization_id,
        clientId: data.clientId,
        actorUserId: context.userId,
        kind: "review.requested",
        summary: "Sent a review request",
      });
    } catch {}
    return { ok: true, channel: "email" as const };
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
    try {
      const { data: c } = await context.supabase
        .from("clients")
        .select("organization_id")
        .eq("id", data.clientId)
        .single();
      if (c) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: c.organization_id,
          clientId: data.clientId,
          actorUserId: context.userId,
          kind: "referral.applied",
          summary: `Applied referral code ${data.code}`,
        });
      }
    } catch {}
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
    // The referral leaderboard lists client names org-wide — a client-directory
    // read, not a technician one (I7).
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );

    const { data, error } = await context.supabase
      .from("clients")
      .select("id, display_name, referred_by_client_id")
      .eq("organization_id", orgId)
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
