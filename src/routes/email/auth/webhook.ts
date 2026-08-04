import * as React from "react";
import { render } from "react-email";
import { Webhook } from "standardwebhooks";
import { createClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { SignupEmail } from "@/lib/email-templates/signup";
import { InviteEmail } from "@/lib/email-templates/invite";
import { MagicLinkEmail } from "@/lib/email-templates/magic-link";
import { RecoveryEmail } from "@/lib/email-templates/recovery";
import { EmailChangeEmail } from "@/lib/email-templates/email-change";
import { ReauthenticationEmail } from "@/lib/email-templates/reauthentication";

// Supabase Auth "Send Email" hook action types
type SupabaseEmailActionType =
  | "signup"
  | "invite"
  | "magiclink"
  | "recovery"
  | "email_change"
  | "email"
  | "reauthentication"
  | "password_changed_notification";

const EMAIL_SUBJECTS: Partial<Record<SupabaseEmailActionType, string>> = {
  signup: "Confirm your email",
  invite: "You've been invited",
  magiclink: "Your login link",
  recovery: "Reset your password",
  email_change: "Confirm your new email",
  email: "Confirm your email",
  reauthentication: "Your verification code",
};

const EMAIL_TEMPLATES: Partial<Record<SupabaseEmailActionType, React.ComponentType<any>>> = {
  signup: SignupEmail,
  invite: InviteEmail,
  magiclink: MagicLinkEmail,
  recovery: RecoveryEmail,
  email_change: EmailChangeEmail,
  email: SignupEmail, // generic email confirmation reuses signup template
  reauthentication: ReauthenticationEmail,
};

const SITE_NAME = "HoundStack";
const SENDER_DOMAIN = "notify.houndstack.com";
const ROOT_DOMAIN = "houndstack.com";
const FROM_DOMAIN = "notify.houndstack.com";

function redactEmail(email: string | null | undefined): string {
  if (!email) return "***";
  const [localPart, domain] = email.split("@");
  if (!localPart || !domain) return "***";
  return `${localPart[0]}***@${domain}`;
}

interface SupabaseAuthHookPayload {
  user: { email: string };
  email_data: {
    token: string;
    token_hash: string;
    redirect_to: string;
    email_action_type: SupabaseEmailActionType;
    site_url: string;
    token_new?: string;
    token_hash_new?: string;
    old_email?: string;
  };
}

export const Route = createFileRoute("/email/auth/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const hookSecret = process.env.AUTH_HOOK_SECRET;
        if (!hookSecret) {
          console.error("AUTH_HOOK_SECRET not configured");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        // Read raw body FIRST — Standard Webhooks verification signs the exact
        // bytes, so a JSON round-trip would break the signature.
        const rawBody = await request.text();

        // Supabase forwards the standard webhook headers (webhook-id,
        // webhook-timestamp, webhook-signature). The standardwebhooks lib
        // expects the secret without the "v1," Supabase-config prefix.
        const wh = new Webhook(hookSecret.replace("v1,whsec_", ""));
        let payload: SupabaseAuthHookPayload;
        try {
          payload = wh.verify(rawBody, {
            "webhook-id": request.headers.get("webhook-id") ?? "",
            "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
            "webhook-signature": request.headers.get("webhook-signature") ?? "",
          }) as SupabaseAuthHookPayload;
        } catch (error) {
          console.error("Auth hook signature verification failed", {
            error: (error as Error).message,
          });
          return Response.json({ error: "Invalid signature" }, { status: 401 });
        }

        const { user, email_data } = payload;
        if (!user?.email || !email_data?.email_action_type) {
          console.error("Auth hook payload missing required fields");
          return Response.json({ error: "Invalid payload" }, { status: 400 });
        }

        const emailType = email_data.email_action_type;
        console.log("Received Supabase auth hook", {
          emailType,
          email_redacted: redactEmail(user.email),
        });

        const EmailTemplate = EMAIL_TEMPLATES[emailType];
        if (!EmailTemplate) {
          // Gracefully skip email types we don't render (e.g.
          // password_changed_notification). Returning success prevents
          // Supabase from blocking the underlying auth flow.
          console.log("No template for email action type — skipping send", { emailType });
          return Response.json({ success: true, skipped: true });
        }

        // Build the confirmation URL. Supabase does NOT provide a ready-made
        // URL in the hook payload — the standard template pattern is
        // `${SUPABASE_URL}/auth/v1/verify?token=<token_hash>&type=<action>&redirect_to=<site>`.
        // The app has no custom /auth/callback route that verifies token_hash
        // via supabase-js, so we point at Supabase's hosted verify endpoint,
        // which will then redirect the user back to redirect_to.
        const supabaseUrl = (process.env.SUPABASE_URL ??
          import.meta.env.VITE_SUPABASE_URL) as string;
        const buildVerifyUrl = (tokenHash: string, type: string) =>
          `${supabaseUrl}/auth/v1/verify?token=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}&redirect_to=${encodeURIComponent(email_data.redirect_to || email_data.site_url)}`;

        // For email_change Supabase fans out to both old and new addresses.
        // The token_hash confirms the old address; token_hash_new confirms
        // the new one. This handler receives one request per recipient with
        // `user.email` set to that recipient, so pick the right token.
        const isNewRecipient =
          emailType === "email_change" &&
          email_data.old_email &&
          user.email !== email_data.old_email;
        const tokenHashForUrl =
          isNewRecipient && email_data.token_hash_new
            ? email_data.token_hash_new
            : email_data.token_hash;
        const confirmationUrl = buildVerifyUrl(tokenHashForUrl, emailType);

        const templateProps = {
          siteName: SITE_NAME,
          siteUrl: `https://${ROOT_DOMAIN}`,
          recipient: user.email,
          email: user.email,
          confirmationUrl,
          token: email_data.token,
          oldEmail: email_data.old_email,
          newEmail: isNewRecipient ? user.email : email_data.old_email ? user.email : user.email,
        };

        const element = React.createElement(EmailTemplate, templateProps);
        const html = await render(element);
        const text = await render(element, { plainText: true });

        const supabaseServiceKey =
          process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supabaseUrl || !supabaseServiceKey) {
          console.error("Missing Supabase environment variables");
          return Response.json({ error: "Server configuration error" }, { status: 500 });
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const messageId = crypto.randomUUID();

        await supabase.from("email_send_log").insert({
          message_id: messageId,
          template_name: emailType,
          recipient_email: user.email,
          status: "pending",
        });

        const { error: enqueueError } = await supabase.rpc("enqueue_email", {
          queue_name: "auth_emails",
          payload: {
            message_id: messageId,
            to: user.email,
            from: `${SITE_NAME} <noreply@${FROM_DOMAIN}>`,
            sender_domain: SENDER_DOMAIN,
            subject: EMAIL_SUBJECTS[emailType] || "Notification",
            html,
            text,
            purpose: "transactional",
            label: emailType,
            queued_at: new Date().toISOString(),
          },
        });

        if (enqueueError) {
          console.error("Failed to enqueue auth email", { error: enqueueError, emailType });
          await supabase.from("email_send_log").insert({
            message_id: messageId,
            template_name: emailType,
            recipient_email: user.email,
            status: "failed",
            error_message: "Failed to enqueue email",
          });
          return Response.json({ error: "Failed to enqueue email" }, { status: 500 });
        }

        console.log("Auth email enqueued", { emailType, email_redacted: redactEmail(user.email) });
        return Response.json({ success: true, queued: true });
      },
    },
  },
});
