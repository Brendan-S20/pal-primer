import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createFileRoute } from "@tanstack/react-router";
import { appUrl } from "@/lib/app-origin";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import { resendAttachments } from "@/lib/email/attachments";
import { invoiceIdFromSendKey } from "@/lib/email/invoice-send-key";

const MAX_RETRIES = 5;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_SEND_DELAY_MS = 200;
const DEFAULT_AUTH_TTL_MINUTES = 15;
const DEFAULT_TRANSACTIONAL_TTL_MINUTES = 60;
// Campaign mail is fed into its lane a batch at a time (see the top-up below),
// so nothing sits in it for long. The TTL is generous anyway because a
// Retry-After cooldown pauses every lane, and a promotion that goes out an
// hour late is fine where a login code that does is not.
const CAMPAIGN_TTL_MINUTES = 24 * 60;

// The order the lanes are read in each tick, which is their priority: a login
// code, then a customer's invoice or reminder, then a promotion.
const QUEUES = ["auth_emails", "transactional_emails", "campaign_emails"] as const;

const RESEND_URL = "https://api.resend.com/emails";

interface SendResult {
  ok: true;
  providerMessageId: string | null;
}

class SendError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null,
    readonly body: string,
  ) {
    super(message);
  }
}

async function sendViaResend(apiKey: string, payload: Record<string, any>): Promise<SendResult> {
  // Build List-Unsubscribe header from the unsubscribe token when present.
  const headers: Record<string, string> = {};
  if (payload.unsubscribe_token) {
    // `unsubscribe_url` points at the endpoint that answers the one-click
    // POST; enqueueAppEmail sets it on everything now. The fallback is for
    // messages queued before that, and points at the same endpoint: the
    // confirmation PAGE answers a POST with 200 and HTML and unsubscribes
    // nobody, which is what one click on an invoice used to do.
    const url =
      typeof payload.unsubscribe_url === "string" && payload.unsubscribe_url
        ? payload.unsubscribe_url
        : appUrl(`/email/unsubscribe?token=${encodeURIComponent(payload.unsubscribe_token)}`);
    headers["List-Unsubscribe"] = `<${url}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const body: Record<string, any> = {
    from: payload.from,
    to: Array.isArray(payload.to) ? payload.to : [payload.to],
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  };
  // BUILD-5: forward the tenant's reply-to so a customer replying to an invoice
  // reaches the business rather than noreply@. Conditional because older
  // messages already sitting in the queue were enqueued without it, and Resend
  // rejects an explicit null.
  if (payload.reply_to) body.reply_to = payload.reply_to;
  // The invoice PDF on "invoice-sent" (enqueue.server.ts). Only well-formed
  // entries go across; see src/lib/email/attachments.ts.
  const attachments = resendAttachments(payload.attachments);
  if (attachments.length) body.attachments = attachments;
  if (Object.keys(headers).length) body.headers = headers;
  if (payload.idempotency_key) {
    // Resend supports Idempotency-Key header for POST /emails
  }

  const fetchHeaders: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (payload.idempotency_key) {
    fetchHeaders["Idempotency-Key"] = String(payload.idempotency_key);
  }

  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: fetchHeaders,
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    let retryAfterSeconds: number | null = null;
    const raHeader = res.headers.get("retry-after");
    if (raHeader) {
      const n = Number(raHeader);
      retryAfterSeconds = Number.isFinite(n)
        ? n
        : Math.max(0, Math.round((new Date(raHeader).getTime() - Date.now()) / 1000));
    }
    throw new SendError(
      `Resend ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      retryAfterSeconds,
      text,
    );
  }

  let providerMessageId: string | null = null;
  try {
    const parsed = JSON.parse(text);
    providerMessageId = typeof parsed?.id === "string" ? parsed.id : null;
  } catch {
    // Non-JSON success? Treat as ok, log nothing to correlate.
  }
  return { ok: true, providerMessageId };
}

function isRateLimited(error: unknown): boolean {
  return error instanceof SendError && error.status === 429;
}

// 4xx auth/permission errors — retrying won't help. Move to DLQ.
// (Resend uses 401 for missing/invalid key, 403 for domain/permission issues,
// 422 for validation errors that also won't succeed on retry.)
function isPermanentClientError(error: unknown): boolean {
  if (!(error instanceof SendError)) return false;
  const s = error.status;
  return s === 400 || s === 401 || s === 403 || s === 404 || s === 422;
}

function getRetryAfterSeconds(error: unknown): number {
  if (error instanceof SendError && error.retryAfterSeconds != null) {
    return error.retryAfterSeconds;
  }
  return 60;
}

async function moveToDlq(
  supabase: SupabaseClient<any, any>,
  queue: string,
  msg: { msg_id: number; message: Record<string, unknown> },
  reason: string,
): Promise<void> {
  const payload = msg.message;
  await supabase.from("email_send_log").insert({
    message_id: payload.message_id,
    template_name: (payload.label || queue) as string,
    recipient_email: payload.to,
    status: "dlq",
    error_message: reason,
  });
  const { error } = await supabase.rpc("move_to_dlq", {
    source_queue: queue,
    dlq_name: `${queue}_dlq`,
    message_id: msg.msg_id,
    payload,
  });
  if (error) {
    console.error("Failed to move message to DLQ", { queue, msg_id: msg.msg_id, reason, error });
  }
}

export const Route = createFileRoute("/email/queue/process")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const resendApiKey = process.env.RESEND_API_KEY;
        // Cannot be undefined, and that is the fix: this guard used to test
        // `import.meta.env.VITE_SUPABASE_URL`, which Vite INLINES at build. The
        // variable was absent when the bundle was built, so the compiled output
        // held `undefined` and no secret added to a runtime store afterwards
        // could change it. `.env` is untracked (deliberately — it was committed
        // once and removing it was a security fix), so the deployed build had no
        // source for it, and nothing else in the product revealed the gap because
        // the browser client hard-codes its own copy of this same public URL.
        // This processor 500'd at the guard below every minute for hours and every
        // invoice, OTP, reminder and welcome email went silently undelivered.
        const supabaseUrl = resolveSupabaseUrl();
        const supabaseServiceKey =
          process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!resendApiKey || !supabaseServiceKey) {
          // NAME the missing variable. The old guard ran every minute for hours
          // returning an identical opaque 500, so `net._http_response` showed
          // 360/360 failures with nothing to say WHICH variable was absent. An
          // operator reading the log could not tell a missing Resend key from a
          // missing Supabase URL.
          const missing = [
            !resendApiKey && "RESEND_API_KEY (runtime secret)",
            !supabaseServiceKey && "SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY (runtime secret)",
          ].filter(Boolean);
          console.error(`email queue processor not configured, missing: ${missing.join(", ")}`);
          return Response.json({ error: "Server configuration error", missing }, { status: 500 });
        }

        // Verify the caller is authorized with the service role key.
        // pg_cron sends the service role key as a Bearer token.
        const authHeader = request.headers.get("Authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const token = authHeader.slice("Bearer ".length).trim();
        if (token !== supabaseServiceKey) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }

        const supabase: SupabaseClient<any, any> = createClient(supabaseUrl, supabaseServiceKey);

        // 1. Check rate-limit cooldown and read queue config
        const { data: state } = await supabase
          .from("email_send_state")
          .select(
            "retry_after_until, batch_size, send_delay_ms, auth_email_ttl_minutes, transactional_email_ttl_minutes",
          )
          .single();

        if (state?.retry_after_until && new Date(state.retry_after_until) > new Date()) {
          return Response.json({ skipped: true, reason: "rate_limited" });
        }

        const batchSize = state?.batch_size ?? DEFAULT_BATCH_SIZE;
        const sendDelayMs = state?.send_delay_ms ?? DEFAULT_SEND_DELAY_MS;
        const ttlMinutes: Record<string, number> = {
          auth_emails: state?.auth_email_ttl_minutes ?? DEFAULT_AUTH_TTL_MINUTES,
          transactional_emails:
            state?.transactional_email_ttl_minutes ?? DEFAULT_TRANSACTIONAL_TTL_MINUTES,
          campaign_emails: CAMPAIGN_TTL_MINUTES,
        };

        // 2. Top up the campaign lane to one batch from the recipients a
        //    campaign has frozen. At most batch_size a tick, never more than
        //    the lane has room for: if sending stalls, the backlog waits in
        //    email_campaign_recipients instead of piling into the queue to
        //    expire. A failure here is logged and never stops the lanes below,
        //    which carry the mail that matters more.
        let campaignsFed = 0;
        try {
          const { data: depth } = await supabase.rpc("email_queue_depth", {
            queue_name: "campaign_emails",
          });
          const room = Math.max(0, batchSize - Number(depth ?? 0));
          if (room > 0) {
            const { feedCampaignLane } = await import("@/lib/campaigns.server");
            campaignsFed = (await feedCampaignLane(room)).queued;
          }
        } catch (e) {
          console.error("Failed to top up the campaign lane", { error: String(e) });
        }

        let totalProcessed = 0;

        // 3. Read each lane in priority order: auth, then transactional, then
        //    campaigns.
        for (const queue of QUEUES) {
          const { data: messages, error: readError } = await supabase.rpc("read_email_batch", {
            queue_name: queue,
            batch_size: batchSize,
            vt: 30,
          });

          if (readError) {
            console.error("Failed to read email batch", { queue, error: readError });
            continue;
          }

          if (!messages?.length) continue;

          // Retry budget is based on real send failures, not pgmq read_ct.
          const messageIds = Array.from(
            new Set(
              messages
                .map((msg: any) =>
                  msg?.message?.message_id && typeof msg.message.message_id === "string"
                    ? msg.message.message_id
                    : null,
                )
                .filter((id: string | null): id is string => Boolean(id)),
            ),
          );
          const failedAttemptsByMessageId = new Map<string, number>();
          if (messageIds.length > 0) {
            const { data: failedRows, error: failedRowsError } = await supabase
              .from("email_send_log")
              .select("message_id")
              .in("message_id", messageIds)
              .eq("status", "failed");

            if (failedRowsError) {
              console.error("Failed to load failed-attempt counters", {
                queue,
                error: failedRowsError,
              });
            } else {
              for (const row of failedRows ?? []) {
                const messageId = row?.message_id;
                if (typeof messageId !== "string" || !messageId) continue;
                failedAttemptsByMessageId.set(
                  messageId,
                  (failedAttemptsByMessageId.get(messageId) ?? 0) + 1,
                );
              }
            }
          }

          for (let i = 0; i < messages.length; i++) {
            const msg = messages[i];
            const payload = msg.message;
            const failedAttempts =
              payload?.message_id && typeof payload.message_id === "string"
                ? (failedAttemptsByMessageId.get(payload.message_id) ?? 0)
                : (msg.read_ct ?? 0);

            // Drop expired messages (TTL exceeded).
            const queuedAt = payload.queued_at ?? msg.enqueued_at;
            if (queuedAt) {
              const ageMs = Date.now() - new Date(queuedAt).getTime();
              const maxAgeMs = ttlMinutes[queue] * 60 * 1000;
              if (ageMs > maxAgeMs) {
                console.warn("Email expired (TTL exceeded)", {
                  queue,
                  msg_id: msg.msg_id,
                  queued_at: queuedAt,
                  ttl_minutes: ttlMinutes[queue],
                });
                await moveToDlq(
                  supabase,
                  queue,
                  msg,
                  `TTL exceeded (${ttlMinutes[queue]} minutes)`,
                );
                continue;
              }
            }

            // Move to DLQ if max failed send attempts reached.
            if (failedAttempts >= MAX_RETRIES) {
              await moveToDlq(
                supabase,
                queue,
                msg,
                `Max retries (${MAX_RETRIES}) exceeded (attempted ${failedAttempts} times)`,
              );
              continue;
            }

            // Guard: skip if another worker already sent this message (VT expired race)
            if (payload.message_id) {
              const { data: alreadySent } = await supabase
                .from("email_send_log")
                .select("id")
                .eq("message_id", payload.message_id)
                .eq("status", "sent")
                .maybeSingle();

              if (alreadySent) {
                console.warn("Skipping duplicate send (already sent)", {
                  queue,
                  msg_id: msg.msg_id,
                  message_id: payload.message_id,
                });
                const { error: dupDelError } = await supabase.rpc("delete_email", {
                  queue_name: queue,
                  message_id: msg.msg_id,
                });
                if (dupDelError) {
                  console.error("Failed to delete duplicate message from queue", {
                    queue,
                    msg_id: msg.msg_id,
                    error: dupDelError,
                  });
                }
                continue;
              }
            }

            try {
              const result = await sendViaResend(resendApiKey, payload);

              // Log success — store Resend's provider id for later bounce/complaint correlation.
              await supabase.from("email_send_log").insert({
                message_id: payload.message_id,
                template_name: payload.label || queue,
                recipient_email: payload.to,
                status: "sent",
                metadata: { provider: "resend", provider_message_id: result.providerMessageId },
              });

              // An invoice is "Sent" from here, the moment the provider took
              // it, and not from when it was queued (#612). Only the first
              // stamp counts: a resend does not move the date.
              const sentInvoiceId = invoiceIdFromSendKey(payload.idempotency_key);
              if (sentInvoiceId) {
                const { error: stampError } = await supabase
                  .from("invoices")
                  .update({ sent_at: new Date().toISOString() })
                  .eq("id", sentInvoiceId)
                  .is("sent_at", null);
                if (stampError) {
                  console.error("Failed to stamp invoice sent_at", {
                    invoice_id: sentInvoiceId,
                    error: stampError,
                  });
                }
              }

              // Delete from queue
              const { error: delError } = await supabase.rpc("delete_email", {
                queue_name: queue,
                message_id: msg.msg_id,
              });
              if (delError) {
                console.error("Failed to delete sent message from queue", {
                  queue,
                  msg_id: msg.msg_id,
                  error: delError,
                });
              }
              totalProcessed++;
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : String(error);
              const status = error instanceof SendError ? error.status : undefined;
              console.error("Email send failed", {
                queue,
                msg_id: msg.msg_id,
                read_ct: msg.read_ct,
                failed_attempts: failedAttempts,
                status,
                error: errorMsg,
              });

              if (isRateLimited(error)) {
                await supabase.from("email_send_log").insert({
                  message_id: payload.message_id,
                  template_name: payload.label || queue,
                  recipient_email: payload.to,
                  status: "failed",
                  error_message: errorMsg.slice(0, 1000),
                });

                const retryAfterSecs = getRetryAfterSeconds(error);
                await supabase
                  .from("email_send_state")
                  .update({
                    retry_after_until: new Date(Date.now() + retryAfterSecs * 1000).toISOString(),
                    updated_at: new Date().toISOString(),
                  })
                  .eq("id", 1);

                return Response.json({ processed: totalProcessed, stopped: "rate_limited" });
              }

              // 4xx auth/permission/validation — retrying won't help. Straight to DLQ.
              if (isPermanentClientError(error)) {
                await moveToDlq(supabase, queue, msg, errorMsg.slice(0, 1000));
                // Keep processing the rest of the batch — a bad recipient shouldn't
                // block sends to other recipients (unlike a 401/403 which will).
                if (status === 401 || status === 403) {
                  return Response.json({ processed: totalProcessed, stopped: "auth_error" });
                }
                continue;
              }

              // Log 5xx / transient failures — message stays invisible until VT expires.
              await supabase.from("email_send_log").insert({
                message_id: payload.message_id,
                template_name: payload.label || queue,
                recipient_email: payload.to,
                status: "failed",
                error_message: errorMsg.slice(0, 1000),
              });
              if (payload?.message_id && typeof payload.message_id === "string") {
                failedAttemptsByMessageId.set(payload.message_id, failedAttempts + 1);
              }
            }

            // Small delay between sends to smooth bursts
            if (i < messages.length - 1) {
              await new Promise((r) => setTimeout(r, sendDelayMs));
            }
          }
        }

        return Response.json({ processed: totalProcessed, campaignsFed });
      },
    },
  },
});
