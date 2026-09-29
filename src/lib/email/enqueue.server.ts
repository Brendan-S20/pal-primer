// Server-only helper used to render + enqueue a transactional (app) email
// on behalf of the SYSTEM (webhooks, cron, RPC completion), rather than a
// signed-in user. Bypasses /email/transactional/send auth by writing
// directly to the pgmq queue via supabaseAdmin. Do NOT import from route
// files; import inside handlers with `await import(...)`.

import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { appUrl } from "@/lib/app-origin";

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
  | "notify_email_review_request"
  | "notify_email_visit_reminder"
  | "notify_email_on_my_way"
  | "notify_email_quote_sent";

interface EnqueueParams {
  organizationId: string;
  /** The client the email is for. null ONLY for somebody who is not a client
   *  yet -- a quote sent to a prospect -- and then `toOverride` is the address
   *  and `recipientName` the greeting. With no client row there is no
   *  per-client opt-out or comms hold to honour; the suppression list (which
   *  is where an unsubscribe lands) is still checked below. */
  clientId: string | null;
  /** The name to greet when there is no client row. Ignored otherwise. */
  recipientName?: string | null;
  templateName: string;
  templateData: Record<string, unknown>;
  /** The organization's on/off switch for this kind of email. Omitted ONLY
   *  for a campaign: a campaign is the owner pressing Send on this exact
   *  message, so there is no standing preference for it to consult. */
  notifyKey?: NotifyKey;
  /** Which lane. `campaign_emails` is read after the other two by
   *  /email/queue/process, so a campaign never delays an invoice. */
  queue?: "transactional_emails" | "campaign_emails";
  /** Mint (or reuse) a CLIENT-scoped unsubscribe token, hand the template its
   *  URL as `unsubscribeUrl`, and point List-Unsubscribe at it. Redeeming it
   *  sets email_opt_out on this client in this organization and nothing else;
   *  see client_unsubscribe_tokens. Requires `clientId`. */
  clientUnsubscribe?: boolean;
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
    // BUILD-5: contact_email is the reply-to. Without it a customer who hits
    // Reply on their invoice writes to noreply@ and is never heard from.
    //
    // contact_phone and contact_address join it here because every template
    // now ends in an OrgFooter. They were already on this row and already
    // editable in Settings; nothing had ever put them in an email.
    .select(
      `id, name, contact_email, contact_phone, contact_address${params.notifyKey ? `, ${params.notifyKey}` : ""}`,
    )
    .eq("id", params.organizationId)
    .maybeSingle();
  if (!org || (params.notifyKey && (org as any)[params.notifyKey] === false)) {
    return { ok: false, reason: "org_toggle_off" };
  }

  // Client + opt-out. A prospect (no client row) has neither; see clientId.
  let client: {
    id: string;
    display_name: string;
    primary_email: string | null;
    email_opt_out: boolean | null;
    comms_paused: boolean | null;
  } | null = null;
  if (params.clientId) {
    const { data } = await supabaseAdmin
      .from("clients")
      .select("id, display_name, primary_email, email_opt_out, comms_paused")
      .eq("id", params.clientId)
      .maybeSingle();
    if (!data) return { ok: false, reason: "no_recipient" };
    client = data;
    if (client.email_opt_out) return { ok: false, reason: "client_opted_out" };
    // Imported comms hold: automated sends are skipped until the org initiates
    // contact. Manual sends proceed (and clear the hold below on success).
    if (client.comms_paused && !params.manual) return { ok: false, reason: "comms_paused" };
  } else if (!params.toOverride) {
    return { ok: false, reason: "no_recipient" };
  }

  const recipient = (params.toOverride ?? client?.primary_email ?? "").trim().toLowerCase();
  if (!recipient) return { ok: false, reason: "no_recipient" };

  // Suppression check
  const { data: suppressed } = await supabaseAdmin
    .from("suppressed_emails")
    .select("email")
    .eq("email", recipient)
    .maybeSingle();
  if (suppressed) return { ok: false, reason: "suppressed" };

  // A client-scoped unsubscribe link, minted BEFORE rendering because the
  // template prints it. One token per client, reused by every campaign: the
  // unique index on client_id makes a concurrent mint a no-op, and the row is
  // read back either way.
  let clientUnsubscribeToken: string | null = null;
  if (params.clientUnsubscribe) {
    if (!client) return { ok: false, reason: "no_recipient" };
    await supabaseAdmin
      .from("client_unsubscribe_tokens")
      .upsert(
        { token: hexToken(), organization_id: params.organizationId, client_id: client.id },
        { onConflict: "client_id", ignoreDuplicates: true },
      );
    const { data: tok } = await supabaseAdmin
      .from("client_unsubscribe_tokens")
      .select("token")
      .eq("client_id", client.id)
      .eq("organization_id", params.organizationId)
      .maybeSingle();
    // No link, no email. CAN-SPAM has no "sent it anyway" branch.
    if (!tok?.token) return { ok: false, reason: "enqueue_failed" };
    clientUnsubscribeToken = tok.token;
  }

  // Render
  // The select above interpolates params.notifyKey, so supabase-js infers
  // nothing about the row. Narrowed once here rather than cast at each field.
  const orgContact = org as {
    contact_phone?: string | null;
    contact_email?: string | null;
    contact_address?: string | null;
  };
  const mergedData = {
    siteName: (org as any).name || SITE_NAME,
    orgName: (org as any).name,
    // Spread BEFORE params.templateData so a caller can still override, but
    // no caller has to remember to pass them — the failure mode this replaces
    // is exactly "the data was available and nobody wired it up".
    orgPhone: orgContact.contact_phone ?? null,
    orgEmail: orgContact.contact_email ?? null,
    orgAddress: orgContact.contact_address ?? null,
    clientName: client?.display_name ?? params.recipientName ?? undefined,
    ...params.templateData,
    // After the spread: the link is minted here, never supplied by a caller.
    ...(clientUnsubscribeToken
      ? { unsubscribeUrl: appUrl(`/unsubscribe?token=${clientUnsubscribeToken}`) }
      : {}),
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
  const subject = typeof entry.subject === "function" ? entry.subject(mergedData) : entry.subject;

  // Unsubscribe token. A campaign's is the client-scoped one minted above;
  // everything else keeps the address-wide token it always had.
  let unsubscribeToken: string;
  if (clientUnsubscribeToken) {
    unsubscribeToken = clientUnsubscribeToken;
  } else {
    unsubscribeToken = hexToken();
    await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .insert({ email: recipient, token: unsubscribeToken });
  }
  const queueName = params.queue ?? "transactional_emails";

  const messageId = crypto.randomUUID();
  const idempotencyKey = params.idempotencyKey || messageId;

  await supabaseAdmin.from("email_send_log").insert({
    message_id: messageId,
    template_name: params.templateName,
    recipient_email: recipient,
    status: "pending",
  });

  const { error: enqueueError } = await supabaseAdmin.rpc("enqueue_email", {
    queue_name: queueName,
    payload: {
      message_id: messageId,
      to: recipient,
      from: `${(org as any).name || SITE_NAME} <noreply@${FROM_DOMAIN}>`,
      // BUILD-5. The `from` display name has always been the tenant's business,
      // so a customer sees "Detroit Doo Disposal" and reasonably hits Reply —
      // and every reply went to noreply@notify.houndstack.com, a mailbox nobody
      // reads. Questions about a bill, a missed visit, a wrong charge: all
      // silently discarded, and the business never knew they were sent.
      //
      // Omitted rather than defaulted when the org has no contact email. A
      // reply-to pointing somewhere wrong is worse than none: the customer gets
      // no bounce and still believes they have been in touch.
      ...((org as any).contact_email ? { reply_to: (org as any).contact_email } : {}),
      sender_domain: SENDER_DOMAIN,
      subject,
      html,
      text,
      purpose: queueName === "campaign_emails" ? "marketing" : "transactional",
      label: params.templateName,
      idempotency_key: idempotencyKey,
      unsubscribe_token: unsubscribeToken,
      // One-click (RFC 8058) needs a URL that answers a POST. The page does
      // not; /email/unsubscribe does, and sends a browser on to the page.
      ...(clientUnsubscribeToken
        ? { unsubscribe_url: appUrl(`/email/unsubscribe?token=${clientUnsubscribeToken}`) }
        : {}),
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
  if (params.manual && client?.comms_paused) {
    await supabaseAdmin.from("clients").update({ comms_paused: false }).eq("id", client.id);
  }
  return { ok: true, messageId };
}
