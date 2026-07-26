// Server-only helper used to render + enqueue a transactional (app) email
// on behalf of the SYSTEM (webhooks, cron, RPC completion), rather than a
// signed-in user. Bypasses /email/transactional/send auth by writing
// directly to the pgmq queue via supabaseAdmin. Do NOT import from route
// files; import inside handlers with `await import(...)`.

import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";

const SITE_NAME = "HoundStack";
const SENDER_DOMAIN = "notify.houndstack.com";
const FROM_DOMAIN = "notify.houndstack.com";

type NotifyKey =
  | "notify_email_invoice_sent"
  | "notify_email_payment_received"
  | "notify_email_visit_completed"
  | "notify_email_weather_reschedule"
  | "notify_email_welcome"
  | "notify_email_overdue"
  | "notify_email_win_back"
  | "notify_email_review_request";


interface EnqueueParams {
  organizationId: string;
  clientId: string;
  templateName: string;
  templateData: Record<string, unknown>;
  notifyKey: NotifyKey;
  idempotencyKey?: string;
  /** Override the client email lookup (rarely needed). */
  toOverride?: string | null;
  /** Explicit user-initiated send (e.g. the "Send invoice" button, an
   * explicit review request or win-back). Manual sends bypass the imported
   * comms hold AND clear it on success — the org has now initiated contact.
   * Automated/system sends (cron, webhooks, lifecycle hooks) omit this and
   * are skipped for clients with comms_paused = true. */
  manual?: boolean;
}

interface EnqueueResult {
  ok: boolean;
  reason?:
    | "org_toggle_off"
    | "client_opted_out"
    | "comms_paused"
    | "no_recipient"
    | "suppressed"
    | "unknown_template"
    | "render_failed"
    | "enqueue_failed";
  messageId?: string;
}

function hexToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function enqueueAppEmail(params: EnqueueParams): Promise<EnqueueResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const entry = TEMPLATES[params.templateName];
  if (!entry) return { ok: false, reason: "unknown_template" };

  // Org toggle
  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select(`id, name, ${params.notifyKey}`)
    .eq("id", params.organizationId)
    .maybeSingle();
  if (!org || (org as any)[params.notifyKey] === false) {
    return { ok: false, reason: "org_toggle_off" };
  }

  // Client + opt-out
  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("id, display_name, primary_email, email_opt_out, comms_paused")
    .eq("id", params.clientId)
    .maybeSingle();
  if (!client) return { ok: false, reason: "no_recipient" };
  if (client.email_opt_out) return { ok: false, reason: "client_opted_out" };
  // Imported comms hold: automated sends are skipped until the org initiates
  // contact. Manual sends proceed (and clear the hold below on success).
  if (client.comms_paused && !params.manual) return { ok: false, reason: "comms_paused" };

  const recipient = (params.toOverride ?? client.primary_email ?? "").trim().toLowerCase();
  if (!recipient) return { ok: false, reason: "no_recipient" };

  // Suppression check
  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails")
    .select("email")
    .eq("email", recipient)
    .maybeSingle();
  if (suppressed) return { ok: false, reason: "suppressed" };

  // Render
  const mergedData = {
    siteName: (org as any).name || SITE_NAME,
    orgName: (org as any).name,
    clientName: client.display_name,
    ...params.templateData,
  };
  let html: string, text: string;
  try {
    const element = React.createElement(entry.component, mergedData);
    html = await render(element);
    text = await render(element, { plainText: true });
  } catch (e) {
    console.error("email render failed", params.templateName, e);
    return { ok: false, reason: "render_failed" };
  }
  const subject =
    typeof entry.subject === "function" ? entry.subject(mergedData) : entry.subject;

  // Unsubscribe token
  const unsubscribeToken = hexToken();
  await supabaseAdmin
    .from("email_unsubscribe_tokens")
    .insert({ email: recipient, token: unsubscribeToken });

  const messageId = crypto.randomUUID();
  const idempotencyKey = params.idempotencyKey || messageId;

  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: params.templateName,
    recipient_email: recipient,
    status: "pending",
  });

  const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to: recipient,
      from: `${(org as any).name || SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text,
      purpose: "transactional",
      label: params.templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      queued_at: new Date().toISOString(),
    },
  });
  if (enqueueError) {
    console.error("enqueue_email failed", enqueueError);
    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId,
      template_name: params.templateName,
      recipient_email: recipient,
      status: "failed",
      error_message: enqueueError.message,
    });
    return { ok: false, reason: "enqueue_failed", messageId };
  }
  // A successful explicit manual send lifts the imported comms hold —
  // contact has now been initiated by the org.
  if (params.manual && client.comms_paused) {
    await supabaseAdmin
      .from("clients")
      .update({ comms_paused: false })
      .eq("id", client.id);
  }
  return { ok: true, messageId };
}
