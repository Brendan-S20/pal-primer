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
| `STRIPE_SECRET_KEY` / `STRIPE_PUBLISHABLE_KEY` / `PLATFORM_STRIPE_WEBHOOK_SECRET` | Platform SaaS billing (bucket A — per-employee plans). **All three from `acct_1U0RifQjJFmqXgZD`.** |
| `STRIPE_CONNECT_SECRET_KEY` / `STRIPE_CONNECT_PUBLISHABLE_KEY` / `STRIPE_CONNECT_WEBHOOK_SECRET` | Connect platform (bucket B — tenant→client charges). **All three from `acct_1U0CVSQUHYdejlaV`.** |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM at rest for QuickBooks/Xero OAuth tokens. `openssl rand -base64 32`. Absent ⇒ storing one hard-fails. **Only the two accounting modules call `encryptSecret()`** — Twilio and BYO-AI keys are not encrypted at rest today, whatever `secret-encryption.server.ts`'s header implies. |
| `AUTH_HOOK_SECRET` | Supabase auth hook verification |
| `RESEND_WEBHOOK_SECRET` | Resend delivery/bounce callbacks |
| `SERVICE_ROLE_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | Service-role DB access; also accepted as cron authorization |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web push. Unset ⇒ web push silently unavailable. |
| `APNS_AUTH_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` / `APNS_ENVIRONMENT` / `FCM_SERVER_KEY` | Native iOS / Android push |
| `GOOGLE_PLACES_API_KEY` | Address autocomplete on signup and property forms |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_ENVIRONMENT` / `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | QuickBooks / Xero OAuth |

**Deliberately unset — setting these breaks things quietly:**

| Secret | Why not |
|--------|---------|
| `PLATFORM_STRIPE_SECRET_KEY` / `PLATFORM_STRIPE_PUBLISHABLE_KEY` | Honoured by only three of the five subscription modules (`platform-billing`, `seat-sync`, `ai-overage-billing`); `billing.functions.ts` and `platform-addons.functions.ts` read `STRIPE_SECRET_KEY` only. Set it to anything different and subscription billing splits across two accounts with nothing reporting it. |
| `STRIPE_WEBHOOK_SECRET` | Legacy fallback, removed from `hooks/stripe.ts`. |

**GitHub Actions secrets (a separate store from Lovable):** `SUPABASE_DB_URL`
and `STRIPE_SECRET_KEY`. The latter arms `check-stripe-catalog.mjs`; a restricted
key with **read on Prices only** is sufficient — one call, `GET /v1/prices` — and
`keyIsLive` accepts `rk_live_…`. Until it resolves, the step prints `NOT ARMED`
and exits 2, and the gate is protecting nothing.
| `PLATFORM_SMS_FROM_NUMBER` | Platform Twilio number for OTP + automated notifications |
| `LOVABLE_API_KEY` / `TWILIO_API_KEY` | Platform Twilio via the connector gateway |
| `TWILIO_AUTH_TOKEN` | **Set this.** Platform Twilio Auth Token. Verifies the signature Twilio puts on every inbound webhook, which is the mechanism built for this job. While it is unset, inbound SMS and voice authenticate on `TWILIO_INBOUND_SECRET` alone. |
| `TWILIO_INBOUND_SECRET` | Fallback inbound-webhook secret, in the query string. Platform-wide: one value authenticates every tenant, and after it passes the org is taken from the attacker-supplied `To` field. It appears in every access, proxy and Twilio log it passes through. Kept only so inbound SMS does not go dark before `TWILIO_AUTH_TOKEN` is set; it logs a warning naming itself whenever it is what let a request through. |
| `RESEND_API_KEY` | All transactional email (OTP email, invoices, review-ask fallback, notifications) |
| `ANTHROPIC_API_KEY` | Optional platform-managed AI fallback (unset ⇒ AI is pure BYOK) |
| `CRON_SECRET` | Authorizes the nightly cron (**required** for autopay — see §5) |
| `PUBLIC_APP_ORIGIN` | Canonical public URL used to validate BYOK inbound Twilio signatures behind a proxy |

**CSP:** the embedded Stripe components need the deployment CSP to allow
`script-src https://js.stripe.com https://connect-js.stripe.com`,
`frame-src https://*.stripe.com`, `connect-src https://api.stripe.com https://*.stripe.com`.

## 2. Webhooks to register

**Two Stripe accounts, one endpoint each.** The scope setting is the part that
fails silently if wrong — an endpoint created "on your account" when it should be
"on connected accounts" leaves `event.account` empty, so `accountMatches()`
rejects everything and every tenant payment is ignored while still returning 200.
Nothing reports that. (A wrong *signing secret* is different: it returns 401 and
does surface as failed deliveries in Stripe's dashboard.)

- **Stripe Connect** (`acct_1U0CVSQUHYdejlaV`) → `POST /api/public/hooks/stripe`,
  secret `STRIPE_CONNECT_WEBHOOK_SECRET`, scope **events on connected accounts**
  (the endpoint object shows `application: ca_…`). Eleven events:
  `account.updated`, `account.application.deauthorized`, `charge.dispute.created`,
  `charge.dispute.updated`, `charge.dispute.closed`, `charge.refunded`,
  `checkout.session.completed`, `payment_intent.succeeded`,
  `payment_intent.payment_failed`, `payment_intent.processing`,
  `setup_intent.succeeded`.

  `checkout.session.completed` is subscribed but nothing in `src/` creates a
  Checkout session in any mode — card saving is `setupIntents.create`. Harmless
  to keep; not load-bearing. `payment_intent.processing` is subscribed and
  deliberately **not** handled: there is nowhere on the invoice to record "bank
  payment in flight", and a column with no reader is what the dead-machinery
  check exists to fail on.

- **Platform SaaS Stripe** (`acct_1U0RifQjJFmqXgZD`) →
  `POST /api/public/hooks/platform-stripe`, secret
  `PLATFORM_STRIPE_WEBHOOK_SECRET`, scope **events on your account**
  (`application: null`). Eleven events: `customer.created`, `customer.updated`,
  `customer.subscription.created`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.created`, `invoice.finalized`,
  `invoice.paid`, `invoice.payment_failed`, `invoice.voided`,
  `invoice.marked_uncollectible`.

**Both live endpoints run API version `2026-07-29.dahlia`.** The installed SDK
(`stripe@22.3.0`) defaults to `2026-06-24.dahlia` and nothing in `src/` pins
`apiVersion`, so outbound calls and inbound payloads are on different versions
and the outbound one moves silently on any dependency bump. Same major, so the
objects consumed here are very unlikely to differ — but it is unverified, and
worth pinning.
- **Twilio** → set the number's "A message comes in" / "A call comes in" to `POST /api/public/hooks/twilio` and `/twilio-voice`. With `TWILIO_AUTH_TOKEN` set, no `?s=` is needed on any number — platform or tenant — because Twilio signs every request. `?s=<TWILIO_INBOUND_SECRET>` still works as a fallback. Voice continuations no longer carry the secret: they carry a token derived from it, scoped to one call and one turn.

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
