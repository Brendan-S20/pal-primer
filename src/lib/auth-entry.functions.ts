import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

function appUrl() {
  return process.env.APP_URL || "https://app.houndstack.com";
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
    return { exists: !!exists };
  });

// Frictionless signup: create the user auto-confirmed so they can sign in
// immediately — email verification is tracked as our own to-do (and gates
// Stripe Express) instead of blocking the front door.
export const registerAccount = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({
      email: z.string().trim().email().max(255),
      password: z.string().min(8).max(200),
      orgName: z.string().trim().min(1).max(120),
      displayName: z.string().trim().min(1).max(120),
      phone: z.string().trim().max(40).optional(),
      smsConsent: z.boolean().optional(),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: {
        org_name: data.orgName,
        display_name: data.displayName,
        phone: data.phone || undefined,
        sms_consent: data.smsConsent && data.phone ? true : undefined,
      },
    });
    if (error) {
      if (/already/i.test(error.message)) {
        throw new Error("That email already has an account. Sign in instead.");
      }
      throw new Error(error.message);
    }
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

export const getEmailVerificationStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: role } = await context.supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (!role) return { verified: false };
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("organizations")
      .select("email_verified_at")
      .eq("id", role.organization_id)
      .maybeSingle();
    return { verified: !!data?.email_verified_at };
  });
