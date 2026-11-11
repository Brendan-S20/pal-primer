import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { appOrigin } from "@/lib/app-origin";
import { EMAIL_ALREADY_REGISTERED } from "@/lib/signup-email";
import { SIGNUP_ORG_PENDING } from "@/lib/signup-marker";
import {
  isPasswordRejection,
  passwordRejectionMessage,
  passwordSchema,
} from "@/lib/password-policy";

function appUrl() {
  return appOrigin();
}

// Identifier-first sign-in: given an email, tell the auth screen whether to
// show the password step (account exists) or hand off to the Get-started
// walkthrough (new). Runs server-side with the service role — the underlying
// RPC is not executable by anon/authenticated, so the browser can't probe it
// except through this fn.
export const checkEmailAccount = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ email: z.string().trim().email().max(255) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: exists, error } = await (supabaseAdmin as any).rpc("email_has_account", {
      _email: data.email,
    });
    if (error) throw new Error("Couldn't check that email. Try again.");
    if (exists) return { exists: true, pendingInvite: false };

    // A new address with a pending teammate invitation joins that business;
    // Get started must not ask it for a business name (#651). A yes/no only:
    // which business invited it is not said to an anonymous caller.
    const { data: invites, error: invErr } = await (supabaseAdmin as any)
      .from("org_invites")
      .select("id")
      .ilike("email", likeExactly(data.email))
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    // A failed lookup is "no", and Get started's own accept after sign-up is
    // still the backstop that joins rather than builds.
    return { exists: false, pendingInvite: !invErr && (invites?.length ?? 0) > 0 };
  });

/** An ILIKE pattern that matches `value` and nothing else: `_` is common in
 *  email addresses and is a wildcard to LIKE. */
export function likeExactly(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Frictionless signup: create the user auto-confirmed so they can sign in
// immediately — email verification is tracked as our own to-do (and gates
// Stripe Express) instead of blocking the front door.
export const registerAccount = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        // The same rules every password form shows and checks (#807).
        password: passwordSchema,
        // Absent for an invited teammate, who joins a business instead of
        // naming one.
        orgName: z.string().trim().min(1).max(120).optional(),
        displayName: z.string().trim().min(1).max(120),
        phone: z.string().trim().max(40).optional(),
        smsConsent: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      // A business was named, and is about to be built. Until it is, an empty
      // user_roles means "finish my signup"; after, it means "I was taken off
      // a business" (#765). app_metadata: the person cannot write it.
      app_metadata: data.orgName ? { [SIGNUP_ORG_PENDING]: true } : undefined,
      user_metadata: {
        org_name: data.orgName || undefined,
        display_name: data.displayName,
        phone: data.phone || undefined,
        sms_consent: data.smsConsent && data.phone ? true : undefined,
      },
    });
    if (error) {
      if (/already/i.test(error.message)) {
        throw new Error(EMAIL_ALREADY_REGISTERED);
      }
      // A password the shared rules passed but the auth server still refused
      // (its leaked-password check): marked as being about the password, so
      // Get started shows it on a password field rather than as a dead end.
      if (isPasswordRejection(error)) throw new Error(passwordRejectionMessage(error.message));
      throw new Error(error.message);
    }
    return { ok: true };
  });

/**
 * Clear the signup marker for an account that has a membership (#765).
 *
 * Most joins clear it where they happen (bootstrapOrganization,
 * acceptPlatformInvite). An invitation accepted by the database function
 * cannot write app_metadata, so the first sign-in that finds a membership
 * settles it here. Only ever clears, and only for the caller, and only once
 * the service role has seen the membership itself.
 */
export const settleSignupMarker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", context.userId)
      .limit(1);
    if (!data?.length) return { cleared: false };
    const { clearSignupMarker } = await import("@/lib/signup-marker");
    await clearSignupMarker(supabaseAdmin, context.userId);
    return { cleared: true };
  });

/**
 * Give up the caller's own membership of the business that turned them off
 * (#765), so the address can start a business of its own or join another.
 * As the caller, never the service role: the database function acts only for
 * auth.uid(), refuses anybody who is on, and keeps their staff row and its
 * history. Says nothing about the business beyond what /access-off already
 * showed them.
 */
export const leaveBusinessIWasTurnedOffIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await (context.supabase as any).rpc("leave_business_i_was_turned_off_in");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Mint a verification token and queue the email (same Resend queue the auth
// emails ride). Callable again to re-send.
export const sendEmailVerification = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) throw new Error("No organization for user");
    const { data: userData } = await supabase.auth.getUser();
    const email = userData.user?.email;
    if (!email) throw new Error("No email on account");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await (supabaseAdmin as any)
      .from("email_verifications")
      .insert({ organization_id: role.organization_id, user_id: userId, email })
      .select("token")
      .single();
    if (error) throw new Error(error.message);

    const link = `${appUrl()}/api/public/verify-email?token=${row.token}`;
    const messageId = crypto.randomUUID();
    const html = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;">
        <h2 style="margin:0 0 12px;">Verify your email</h2>
        <p style="color:#444;">Confirm this address to unlock payments (Stripe) on your HoundStack workspace. This link is good for 7 days.</p>
        <p style="margin:24px 0;"><a href="${link}" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Verify email</a></p>
        <p style="color:#888;font-size:12px;">Or paste this link into your browser:<br>${link}</p>
      </div>`;
    await (supabaseAdmin as any).from("email_send_log").insert({
      message_id: messageId,
      template_name: "verify_email",
      recipient_email: email,
      status: "pending",
    });
    const { error: qErr } = await (supabaseAdmin as any).rpc("enqueue_email", {
      queue_name: "auth_emails",
      payload: {
        message_id: messageId,
        to: email,
        from: "HoundStack <noreply@notify.houndstack.com>",
        sender_domain: "notify.houndstack.com",
        subject: "Verify your email",
        html,
        text: `Verify your email to unlock payments on your HoundStack workspace: ${link}`,
        purpose: "transactional",
        label: "verify_email",
        queued_at: new Date().toISOString(),
      },
    });
    if (qErr) throw new Error("Couldn't queue the verification email. Try again.");
    return { ok: true };
  });
