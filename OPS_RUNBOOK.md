# HoundStack Ops Runbook

Operational reference for the BYOK integrations (AI, Twilio, Stripe Connect),
billing, and the background jobs. Aimed at whoever runs the platform.

## 1. Environment / secrets (where they live)

App server secrets live in **Lovable project secrets** (the app reads them via
`process.env` in TanStack server functions / API routes). **Supabase** holds the
DB + auth only; Supabase secrets feed Edge Functions, which this app does not use
for these paths.

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` / `PLATFORM_STRIPE_WEBHOOK_SECRET` | Platform SaaS billing (bucket A — per-employee plans) |
| `STRIPE_CONNECT_SECRET_KEY` / `STRIPE_CONNECT_PUBLISHABLE_KEY` / `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect platform (bucket B — tenant→client charges) |
| `PLATFORM_SMS_FROM_NUMBER` | Platform Twilio number for OTP + automated notifications |
| `LOVABLE_API_KEY` / `TWILIO_API_KEY` | Platform Twilio via the connector gateway |
| `TWILIO_INBOUND_SECRET` | Shared inbound-webhook secret for platform-managed numbers |
| `RESEND_API_KEY` | All transactional email (OTP email, invoices, review-ask fallback, notifications) |
| `ANTHROPIC_API_KEY` | Optional platform-managed AI fallback (unset ⇒ AI is pure BYOK) |
| `CRON_SECRET` | Authorizes the nightly cron (**required** for autopay — see §5) |
| `PUBLIC_APP_ORIGIN` | Canonical public URL used to validate BYOK inbound Twilio signatures behind a proxy |

**CSP:** the embedded Stripe components need the deployment CSP to allow
`script-src https://js.stripe.com https://connect-js.stripe.com`,
`frame-src https://*.stripe.com`, `connect-src https://api.stripe.com https://*.stripe.com`.

## 2. Webhooks to register

- **Stripe Connect** → `POST /api/public/hooks/stripe`, secret `STRIPE_CONNECT_WEBHOOK_SECRET`. Events: `account.updated`, `checkout.session.completed`, `payment_intent.succeeded`, `payment_intent.payment_failed`.
- **Platform SaaS Stripe** → `POST /api/public/hooks/platform-stripe`, secret `PLATFORM_STRIPE_WEBHOOK_SECRET`. Events: invoice.* + customer.subscription.*.
- **Twilio (per BYOK tenant)** → the tenant sets their number's "A message comes in" / "A call comes in" to `POST /api/public/hooks/twilio` and `/twilio-voice` (no `?s=` — verified by their Auth Token signature). Platform-managed numbers use `?s=<TWILIO_INBOUND_SECRET>`.

## 3. Migrations

DDL is applied to the live Supabase project (ref `vsxzrbxublqrcfnxfwcu`) and each
migration is committed under `supabase/migrations/`. Migrations are additive +
idempotent (safe to re-run). Apply via the Supabase MCP `apply_migration` or paste
into the SQL editor; then verify the column/table exists before relying on it.

## 4. Failure-mode playbook

**AI key revoked / invalid (BYOK).** Symptom: AI Tools error with "check your API
key." The org owner re-enters a valid key in **Settings → AI Tools** and clicks
**Test key** (runs a live probe). If no platform `ANTHROPIC_API_KEY` is set, AI is
unavailable until they add their own — by design.

**Stripe account disconnected / onboarding incomplete.** Symptom: charges error
with "hasn't connected a Stripe account" or "can't accept charges yet." Owner goes
to **Settings → Payments**, completes the embedded onboarding, clicks **Refresh**.
Disconnecting (or connecting a *different* account) clears saved client cards —
clients must re-enter a card next time they pay. Charges never fall back to the
platform account.

**Twilio deauth / creds changed mid-use (BYOK).** Symptom: conversational SMS fails
with a Twilio 401/auth error (surfaced on the message). Owner re-enters the SID +
Auth Token in **Settings → SMS**. Note: OTP + automated notifications keep working
(they're on the platform number, not the tenant's).

**Toll-free / A2P 10DLC not registered.** Symptom: a BYOK tenant's outbound SMS is
filtered by carriers. The tenant registers their own brand/campaign in their Twilio
account (attach a Messaging Service SID in Settings → SMS). Until then, they can
leave BYOK Twilio disconnected to use the platform sender.

**BYOK inbound suddenly 401s after a deploy.** Cause: proxy host/scheme mismatch in
the Twilio signature URL. Ensure `PUBLIC_APP_ORIGIN` matches the exact public URL
tenants configured in their Twilio console.

**Email not delivering.** Confirm `notify.houndstack.com` shows verified in Resend
(DKIM/SPF/MX) and `RESEND_API_KEY` is set. Per-send outcomes are recorded in
`email_send_log` (queryable by `message_id`).

**Duplicate / missing charges.** Autopay is idempotent per invoice+amount; a
webhook-lagged re-run won't double-charge. If an invoice shows paid but no client
was charged, check for a webhook `account.updated`/account-mismatch log line
(cross-account events are ignored by design).

## 5. Background jobs

`POST /api/public/hooks/nightly` runs auto-visit generation, auto-invoicing,
overdue reminders, franchise royalty (1st of month), and **autopay**. Authorize
with `x-cron-secret: <CRON_SECRET>` (or `?s=`). **Autopay charges run only under
`CRON_SECRET`** — the anon-key path is accepted for the non-charging automation but
will not move money (security fix C2). Schedule it once daily.

## 6. Security posture (as of the pre-pilot review)

- Tenant charges are isolated per connected account; the Connect webhook verifies
  every metadata-referenced invoice/client belongs to `event.account` before acting.
- BYOK credential columns (`org_ai_credentials`, `org_twilio_credentials`) are
  service-role-only (RLS on, no policies); settings endpoints return only masked
  last-4s.
- In-app notifications are per-recipient (`recipient_user_id = auth.uid()`).
- A Twilio sender number is unique to one org (no inbound-blackholing by squatting).
