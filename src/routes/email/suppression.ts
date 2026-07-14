import { createClient } from '@supabase/supabase-js'
import { Webhook, WebhookVerificationError } from 'svix'
import { createFileRoute } from '@tanstack/react-router'

// Resend delivers webhooks via Svix. Signature is verified with the
// signing secret shown in the Resend dashboard when the endpoint is
// created (prefixed `whsec_...`), read from RESEND_WEBHOOK_SECRET.
//
// Events we care about (subscribe these in the Resend dashboard):
//   - email.bounced       → permanent bounce → suppress
//   - email.complained    → spam complaint    → suppress
//   - email.delivered     → delivered ack     → log only
//   - email.delivery_delayed (optional)       → log only
//
// Everything else is ignored (200 OK to avoid unnecessary redelivery).

interface ResendEvent {
  type: string
  created_at?: string
  data: {
    email_id?: string
    to?: string | string[]
    from?: string
    subject?: string
    bounce?: { type?: string; message?: string }
    [k: string]: unknown
  }
}

function firstRecipient(to: string | string[] | undefined): string | null {
  if (!to) return null
  if (Array.isArray(to)) return to[0] ?? null
  return to
}

function mapEventToReason(
  type: string,
): 'bounce' | 'complaint' | null {
  switch (type) {
    case 'email.bounced':
      return 'bounce'
    case 'email.complained':
      return 'complaint'
    default:
      return null
  }
}

function mapReasonToStatus(
  reason: string,
): 'bounced' | 'complained' | 'suppressed' {
  switch (reason) {
    case 'bounce':
      return 'bounced'
    case 'complaint':
      return 'complained'
    default:
      return 'suppressed'
  }
}

function mapReasonToMessage(reason: string): string {
  switch (reason) {
    case 'bounce':
      return 'Permanent bounce: email address is invalid or rejected'
    case 'complaint':
      return 'Spam complaint: recipient marked email as spam'
    default:
      return 'Email suppressed'
  }
}

export const Route = createFileRoute("/email/suppression")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const signingSecret = process.env.RESEND_WEBHOOK_SECRET
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
        const supabaseServiceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY

        if (!supabaseUrl || !supabaseServiceKey) {
          console.error('Missing Supabase environment variables')
          return Response.json({ error: 'Server configuration error' }, { status: 500 })
        }

        // Fail-closed: without the signing secret we cannot verify authenticity,
        // and we refuse to touch the suppression list on unverified input.
        if (!signingSecret) {
          console.error(
            'RESEND_WEBHOOK_SECRET is not configured — refusing to process Resend webhook. ' +
              'Create the webhook endpoint in Resend and add the signing secret (whsec_...) as ' +
              'RESEND_WEBHOOK_SECRET in Project Settings → Secrets.',
          )
          return Response.json(
            { error: 'Webhook endpoint not yet configured (RESEND_WEBHOOK_SECRET missing)' },
            { status: 503 },
          )
        }

        // Raw body is required for signature verification.
        const rawBody = await request.text()

        // Svix expects these three headers.
        const svixHeaders = {
          'svix-id': request.headers.get('svix-id') ?? '',
          'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
          'svix-signature': request.headers.get('svix-signature') ?? '',
        }

        let event: ResendEvent
        try {
          const wh = new Webhook(signingSecret)
          event = wh.verify(rawBody, svixHeaders) as ResendEvent
        } catch (err) {
          if (err instanceof WebhookVerificationError) {
            console.error('Resend webhook signature verification failed', { message: err.message })
            return Response.json({ error: 'Invalid signature' }, { status: 401 })
          }
          console.error('Unexpected error verifying Resend webhook', { err })
          return Response.json({ error: 'Internal error' }, { status: 500 })
        }

        const supabase = createClient(supabaseUrl, supabaseServiceKey)
        const recipient = firstRecipient(event.data?.to)
        const providerMessageId = event.data?.email_id ?? null

        // For non-suppression events (delivered, delivery_delayed, etc.), just
        // log to console and ack. email_send_log's status CHECK doesn't allow
        // 'delivered'/'info' — keep the row-level audit trail focused on
        // outbound sends and suppression events.
        const reason = mapEventToReason(event.type)
        if (!reason) {
          console.log('Resend non-suppression event', {
            type: event.type,
            email_redacted: recipient ? recipient[0] + '***@' + recipient.split('@')[1] : null,
            provider_message_id: providerMessageId,
          })
          return Response.json({ success: true, handled: false, event: event.type })
        }

        if (!recipient) {
          console.warn('Suppression event missing recipient', { type: event.type })
          return Response.json({ success: true, ignored: 'no_recipient' })
        }

        const normalizedEmail = recipient.toLowerCase()

        // 1. Upsert to suppressed_emails (idempotent — safe for Svix redelivery)
        const { error: suppressError } = await supabase
          .from('suppressed_emails')
          .upsert(
            {
              email: normalizedEmail,
              reason,
              metadata: {
                provider: 'resend',
                event: event.type,
                provider_message_id: providerMessageId,
                data: event.data,
              },
            },
            { onConflict: 'email' },
          )

        if (suppressError) {
          console.error('Failed to upsert suppressed email', {
            error: suppressError,
            email_redacted: normalizedEmail[0] + '***@' + normalizedEmail.split('@')[1],
          })
          return Response.json({ error: 'Failed to write suppression' }, { status: 500 })
        }

        // 2. Append a suppression event to email_send_log (never mutate prior rows)
        const { error: insertError } = await supabase.from('email_send_log').insert({
          message_id: providerMessageId,
          template_name: 'resend-webhook',
          recipient_email: normalizedEmail,
          status: mapReasonToStatus(reason),
          error_message: mapReasonToMessage(reason),
          metadata: { provider: 'resend', event: event.type, data: event.data },
        })

        if (insertError) {
          console.warn('Failed to insert email_send_log for suppression', { error: insertError })
        }

        console.log('Resend suppression processed', {
          email_redacted: normalizedEmail[0] + '***@' + normalizedEmail.split('@')[1],
          reason,
          event: event.type,
          has_provider_id: !!providerMessageId,
        })

        return Response.json({ success: true })
      },
    },
  },
})
