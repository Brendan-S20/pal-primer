// Server-only helper used to render + enqueue a transactional (app) email
// on behalf of the SYSTEM (webhooks, cron, RPC completion), rather than a
// signed-in user. Bypasses /email/transactional/send auth by writing
// directly to the pgmq queue via supabaseAdmin. Do NOT import from route
// files; import inside handlers with `await import(...)`.

import * as React from "react";
import { render } from "react-email";
import { TEMPLATES } from "@/lib/email-templates/registry";
import { appUrl } from "@/lib/app-origin";
import { emailProviderConfigured } from "@/lib/email/provider.server";

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
  | "notify_email_quote_sent"
  | "notify_email_stay_confirmed"
  | "notify_email_stay_ending"
  | "notify_email_training_package"
  | "notify_email_stay_confirmed"
  | "notify_email_stay_ending"
  | "notify_email_walk_not_done"
  | "notify_email_walk_schedule_change"
  | "notify_email_walk_canceled"
  | "notify_email_missed_meds";

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
  /** Send at most once per `idempotencyKey`, however many times this is
   *  called, on any day. For an email driven by a webhook, which Stripe
   *  delivers at least once and may redeliver days later.
   *
   *  The key alone does not do that. It reaches Resend as an Idempotency-Key
   *  header, which Resend honours for 24 hours, and nothing else reads it. So
   *  with this set the key also names the message: the message_id is derived
   *  from it, the send log is checked for that id before anything is queued,
   *  and /email/queue/process already refuses to send a message_id it has
   *  logged as sent. Three layers on one id, all on tables that exist. */
  oncePerKey?: boolean;
  /** Override the client email lookup (rarely needed). */
  toOverride?: string | null;
  /** Explicit user-initiated send (e.g. the "Send invoice" button, an
   * explicit review request or win-back). Manual sends bypass the imported
   * comms hold AND clear it on success — the org has now initiated contact.
   * Automated/system sends (cron, webhooks, lifecycle hooks) omit this and
   * are skipped for clients with comms_paused = true. */
  manual?: boolean;
  /** Files sent WITH the email: the invoice PDF on "invoice-sent". Base64,
   *  because the payload is jsonb on a pgmq queue until
   *  /email/queue/process hands it to Resend, which takes exactly this shape
   *  ({ filename, content }). Keep them small: the message sits in the queue
   *  (and in the DLQ if it fails) with the file inside it.
   *
   *  A function, called only once every reason NOT to send has been ruled
   *  out, so a nightly loop that re-tries an opted-out client's invoice every
   *  night does not draw that PDF every night for nothing. A throw from it is
   *  caught and the email goes without the file. */
  attachments?: () => Promise<Array<{ filename: string; contentBase64: string }>>;
  /** Refuse to queue when there is no mail provider to hand the message to
   *  (RESEND_API_KEY unset). For a send whose caller tells a person "sent":
   *  a message queued with no provider sits there and the label lies (#612). */
  requireProvider?: boolean;
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
    | "enqueue_failed"
    | "already_sent"
    | "provider_off";
  messageId?: string;
}

function hexToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** A message_id that is the same every time for the same template and key,
 *  shaped like the random UUIDs every other message gets. Exported for the
 *  platform's own once-per-key mail (setup-notify.server.ts), which goes to
 *  the HoundStack team rather than as a tenant and so does not come through
 *  enqueueAppEmail. */
export async function messageIdForKey(templateName: string, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${templateName}:${key}`),
  );
  const h = Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function enqueueAppEmail(params: EnqueueParams): Promise<EnqueueResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const entry = TEMPLATES[params.templateName];
  if (!entry) return { ok: false, reason: "unknown_template" };
  if (params.requireProvider && !emailProviderConfigured()) {
    return { ok: false, reason: "provider_off" };
  }

  // Org toggle
  const { data: org } = await supabaseAdmin
    .from("organizations")
    // BUILD-5: contact_email is the reply-to. Without it a customer who hits
    // Reply on their invoice writes to noreply@ and is never heard from.
    //
    // contact_phone and contact_address join it here because every template
    // now ends in an OrgFooter. They were already on this row and already
    // editable in Settings; nothing had ever put them in an email.
    //
    // logo_url and brand_color are the TenantHeader every template opens
    // with (#577), the same two fields the portal and the booking page use.
    .select(
      `id, name, contact_email, contact_phone, contact_address, logo_url, brand_color${params.notifyKey ? `, ${params.notifyKey}` : ""}`,
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

  // Once per key: has a message with this id already gone to the queue?
  //
  // Every status the log can hold except `failed` means it did: `pending` is
  // written as it is queued, `sent`/`dlq`/`bounced`/... come after. A
  // `failed` row on its own is either an enqueue that never reached the
  // queue (marked below, so the next call may try again) or a send attempt
  // the queue is still retrying, which always sits beside its `pending` row.
  const onceKey = params.oncePerKey && params.idempotencyKey ? params.idempotencyKey : null;
  const keyedMessageId = onceKey ? await messageIdForKey(params.templateName, onceKey) : null;
  if (keyedMessageId) {
    const { data: prior } = await supabaseAdmin
      .from("email_send_log")
      .select("status")
      .eq("message_id", keyedMessageId);
    if (((prior ?? []) as Array<{ status: string }>).some((r) => r.status !== "failed")) {
      return { ok: false, reason: "already_sent", messageId: keyedMessageId };
    }
  }

  // A client-scoped unsubscribe link, minted BEFORE rendering because the
  // template prints it. One token per client, reused by every campaign: the
  // unique index on client_id makes a concurrent mint a no-op, and the row is
  // read back either way.
  //
  // Every email to a KNOWN client carries it now, not only campaigns: it is
  // what the one-click List-Unsubscribe header points at, and redeeming it
  // opts that client out at this business and nowhere else. The address-wide
  // token below it adds the address to the platform-wide suppression list,
  // so one click on one business's invoice stopped every business's mail to
  // that person. A campaign cannot go without it; anything else falls back.
  let clientUnsubscribeToken: string | null = null;
  if (params.clientUnsubscribe && !client) return { ok: false, reason: "no_recipient" };
  if (client) {
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
    // No link, no campaign. CAN-SPAM has no "sent it anyway" branch.
    if (!tok?.token && params.clientUnsubscribe) return { ok: false, reason: "enqueue_failed" };
    clientUnsubscribeToken = tok?.token ?? null;
  }

  // Attachments, now that nothing above has declined the send.
  let attachments: Array<{ filename: string; contentBase64: string }> = [];
  if (params.attachments) {
    try {
      attachments = (await params.attachments()) ?? [];
    } catch (e) {
      console.error("email attachment failed", params.templateName, e);
      attachments = [];
    }
  }

  // Render
  // The select above interpolates params.notifyKey, so supabase-js infers
  // nothing about the row. Narrowed once here rather than cast at each field.
  const orgContact = org as {
    contact_phone?: string | null;
    contact_email?: string | null;
    contact_address?: string | null;
    logo_url?: string | null;
    brand_color?: string | null;
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
    orgLogoUrl: orgContact.logo_url ?? null,
    orgBrandColor: orgContact.brand_color ?? null,
    clientName: client?.display_name ?? params.recipientName ?? undefined,
    ...params.templateData,
    // After the spread: the link is minted here, never supplied by a caller.
    ...(clientUnsubscribeToken && params.clientUnsubscribe
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

  // Unsubscribe token: the client-scoped one minted above, or, for mail with
  // no client row (a prospect's quote), the address-wide one. That table
  // holds ONE token per address (email_unsubscribe_tokens_email_key), so the
  // bare insert this used to do failed silently from the second email on and
  // the header carried a token that did not exist. Reuse the address's token.
  let unsubscribeToken: string;
  if (clientUnsubscribeToken) {
    unsubscribeToken = clientUnsubscribeToken;
  } else {
    await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .upsert(
        { email: recipient, token: hexToken() },
        { onConflict: "email", ignoreDuplicates: true },
      );
    const { data: addrTok } = await supabaseAdmin
      .from("email_unsubscribe_tokens")
      .select("token")
      .eq("email", recipient)
      .maybeSingle();
    unsubscribeToken = (addrTok?.token as string | undefined) ?? hexToken();
  }
  const queueName = params.queue ?? "transactional_emails";

  const messageId = keyedMessageId ?? crypto.randomUUID();
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
      // not; /email/unsubscribe does, and sends a browser on to the page. It
      // redeems either kind of token.
      unsubscribe_url: appUrl(`/email/unsubscribe?token=${unsubscribeToken}`),
      queued_at: new Date().toISOString(),
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.contentBase64,
            })),
          }
        : {}),
    },
  });
  if (enqueueError) {
    console.error("enqueue_email failed", enqueueError);
    if (keyedMessageId) {
      // The pending row above claims a message that never reached the queue.
      // Turn it into the failure, so the once-per-key check lets the next
      // call (a webhook redelivery) try again instead of reading a claim.
      await supabaseAdmin
        .from("email_send_log")
        .update({ status: "failed", error_message: enqueueError.message })
        .eq("message_id", messageId)
        .eq("status", "pending");
    } else {
      await supabaseAdmin.from("email_send_log").insert({
        message_id: messageId,
        template_name: params.templateName,
        recipient_email: recipient,
        status: "failed",
        error_message: enqueueError.message,
      });
    }
    return { ok: false, reason: "enqueue_failed", messageId };
  }
  // A successful explicit manual send lifts the imported comms hold —
  // contact has now been initiated by the org.
  if (params.manual && client?.comms_paused) {
    await supabaseAdmin.from("clients").update({ comms_paused: false }).eq("id", client.id);
  }
  return { ok: true, messageId };
}
