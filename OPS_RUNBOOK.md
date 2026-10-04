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
| `APNS_AUTH_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` / `APNS_ENVIRONMENT` | Native iOS push, token auth. **Set 2026-10-03.** `APNS_AUTH_KEY` is the whole `.p8` (newlines may be real, literal `\n`, or flattened — normalised before use; a certificate is refused by name). `APNS_TOPIC` = `consulting.thenorth.houndstack` (also the default if unset). `APNS_ENVIRONMENT` = `production` for TestFlight/App Store; `sandbox` only while testing an Xcode cable build. Unset or unreadable ⇒ iOS push is skipped with one log line, never an error. The `.p8` can be downloaded once: if lost, revoke it in Apple Developer › Keys and make another. Setup and test steps: `docs/ios-build.md` › Push notifications. |
| `FCM_SERVICE_ACCOUNT` | Native Android push — the whole service-account JSON from Firebase → Project settings → Service accounts. Replaces `FCM_SERVER_KEY`, whose legacy endpoint Google decommissioned; setting the old name now does nothing. |
| `GOOGLE_PLACES_API_KEY` | Address autocomplete on signup and property forms |
| `QBO_CLIENT_ID` / `QBO_CLIENT_SECRET` / `QBO_ENVIRONMENT` / `XERO_CLIENT_ID` / `XERO_CLIENT_SECRET` | QuickBooks / Xero OAuth |

**Deliberately unset — setting these breaks things quietly:**

| Secret | Why not |
|--------|---------|
| `PLATFORM_STRIPE_SECRET_KEY` / `PLATFORM_STRIPE_PUBLISHABLE_KEY` | Honoured by only three of the five subscription modules (`platform-billing`, `seat-sync`, `ai-overage-billing`); `billing.functions.ts` and `platform-addons.functions.ts` read `STRIPE_SECRET_KEY` only. Set it to anything different and subscription billing splits across two accounts with nothing reporting it. |
| `STRIPE_WEBHOOK_SECRET` | Legacy fallback, removed from `hooks/stripe.ts`. |

**GitHub Actions secrets (a separate store from Lovable):** `SUPABASE_DB_URL`,
`STRIPE_SECRET_KEY` and `BACKUP_PASSPHRASE` (encrypts the nightly backup; see §7 —
keep a copy in a password manager, because GitHub will never show it again). The latter arms `check-stripe-catalog.mjs`; a restricted
key with **read on Prices only** is sufficient — one call, `GET /v1/prices` — and
`keyIsLive` accepts `rk_live_…`. Until it resolves, the step prints `NOT ARMED`
and exits 2, and the gate is protecting nothing.
| `PLATFORM_SMS_FROM_NUMBER` | Platform Twilio number for OTP + automated notifications |
| `LOVABLE_API_KEY` / `TWILIO_API_KEY` | Platform Twilio via the connector gateway |
| `TWILIO_AUTH_TOKEN` | **Set this.** Platform Twilio Auth Token. Verifies the signature Twilio puts on every inbound webhook, which is the mechanism built for this job. While it is unset, inbound SMS and voice authenticate on `TWILIO_INBOUND_SECRET` alone. |
| `TWILIO_INBOUND_SECRET` | Fallback inbound-webhook secret, in the query string. Platform-wide: one value authenticates every tenant, and after it passes the org is taken from the attacker-supplied `To` field. It appears in every access, proxy and Twilio log it passes through. Kept only so inbound SMS does not go dark before `TWILIO_AUTH_TOKEN` is set; it logs a warning naming itself whenever it is what let a request through. |
| `RESEND_API_KEY` | All transactional email (OTP email, invoices, review-ask fallback, notifications) |
| `ANTHROPIC_API_KEY` | Required for the AI tools. All AI runs on HoundStack's own key; there is no customer key any more (IMP-9). Unset, the tools say AI is unavailable. The receptionist, digest and Business Advisor use `LOVABLE_API_KEY` instead. |
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

**Both live endpoints run API version `2026-07-29.dahlia`, and so does the
app.** `src/lib/stripe-client.server.ts` pins `STRIPE_API_VERSION` and passes it
to every Stripe constructor; `makeStripe` is the only place a client is built,
guarded by `tests/one-stripe-api-version.test.ts`.

The constant is typed off the SDK's own constructor signature, so upgrading
`stripe` without bumping it does not compile — that is not a convention, it is
the type. Upgrading is therefore two deliberate steps: bump the SDK, bump the
constant.

An endpoint's `api_version` is fixed at CREATION — Stripe rejects it on update
("Received unknown parameter: api_version") — so if the SDK ever moves ahead of
the live endpoints, closing the gap means recreating the endpoint, which mints a
NEW SIGNING SECRET and drops events until it is pasted in.
`warnOnApiVersionMismatch` logs the delta on every delivery so that state is
visible rather than silent.

*(This section previously told an operator to go and pin something that was
already pinned, and named `stripe@22.3.0` after the upgrade.)*
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
- BYOK credential columns (`org_twilio_credentials`) are
  service-role-only (RLS on, no policies); settings endpoints return only masked
  last-4s.
- In-app notifications are per-recipient (`recipient_user_id = auth.uid()`).
- A Twilio sender number is unique to one org (no inbound-blackholing by squatting).

## 7. Backups and restore

Supabase Pro keeps 7 daily snapshots (no point-in-time recovery: up to 24 hours
can be lost), restorable only as a whole-project rollback. A second, encrypted
copy is made nightly by `.github/workflows/backup.yml` (07:30 UTC, kept 30
days as a GitHub artifact) and restored into a throwaway database every Sunday
to prove it works. It needs the `BACKUP_PASSPHRASE` repository secret, which
must also be kept in a password manager — without it the backups cannot be
opened.

How to restore the whole project, into a new project, or one tenant's rows
without touching anyone else's: **`docs/backups-and-restore.md`**. Storage files
(photos, receipts) are in neither backup.

## 8. Error monitoring (Sentry)

Errors from the web app, the iOS and Android apps, and the server (server
functions, SSR, and the cron/webhook endpoints under `/api/public/hooks/*`) go
to the HoundStack project in Sentry (org `o4512195773792256`, project
`4512195827007488`, platform React, errors only).

**Nothing to configure.** The DSN is the default in
`src/lib/monitoring/config.ts`. A DSN is not a secret: it only permits sending
events to that one project and ships in every browser bundle by design. So
every production build reports with no variable set anywhere: Lovable's hosted
build, the Worker at runtime, and Xcode Cloud's native build.

**When it sends.** Production builds only. `npm run dev`, the Playwright
sweeps (which run against the dev server) and vitest send nothing.

| Variable | Read by | Effect |
|----------|---------|--------|
| `VITE_SENTRY_DSN` | browser + native bundle, at **build** time | unset: default DSN in production, off in dev. `off` (or `0`/`false`/`none`): off everywhere. Another DSN: that DSN, in production and in dev (how to try it from `npm run dev`). |
| `SENTRY_DSN` | the Worker, at **runtime** (Lovable project secret) | same rules, for the server half |
| `SENTRY_ENVIRONMENT` | the Worker | optional label override (e.g. `preview`); default `production` |
| `SENTRY_RELEASE` | `vite.config.ts`, at build | optional. Default: `houndstack@<commit>` from Xcode Cloud's `CI_COMMIT`, `GITHUB_SHA`, or the checkout |

Under vitest it is off whatever these say, so a DSN left in a shell cannot make
the suite phone home.

**What is reported.** Unhandled errors and promise rejections in the browser;
anything the router's error boundaries catch (`RouteError`, the root
`ErrorComponent`); every server function's **unexpected** exception; anything
thrown out of SSR or a server route; and any 5xx from `/api/public/hooks/*`
(the Stripe and announcement-email hooks also send the exception behind it).

**What is not.** Deliberate refusals the user is meant to read: "Not
authorized", "Client not found", "Invoice already paid", validation failures,
plan gates, declined cards, redirects, 4xx. Also browser network failures
("Failed to fetch"), which are a phone in a dead zone. The rule is
`isExpectedError` in `src/lib/monitoring/policy.ts`: a plain `Error` whose
message reads like a sentence is a refusal unless it says something failed,
is missing, timed out or answered 5xx; a lowercase message (Postgres,
PostgREST) and every `TypeError`-like class is a fault. If a refusal turns up in
Sentry, add it there rather than ignoring it in Sentry.

**What never leaves.** User: id only, org id as the `org_id` tag; never email,
name or IP. Requests: no cookies, no headers except User-Agent, no body, no
query string; token path segments (portal, pay link, quote, tracking, invite,
calendar feed) become `[token]`. Free text has emails, phone numbers, JWTs,
bearer tokens and API keys masked. No session replay, no tracing, no DOM or
console breadcrumbs, no form values. `tests/error-monitoring.test.ts` pins all
of this against the events actually built.

**Recommended Sentry project settings** (Settings > Security & Privacy):
turn on *Prevent Storing of IP Addresses* and leave *Data Scrubber* on. Both are
belt and braces; the app already sends neither.

**Verify after a deploy.** Sign in as a platform admin, open
**/platform/health**, press **Send a test error**. It reports
`Browser: sent. Server: sent.` and two issues tagged `test_event=yes` appear in
Sentry within a minute, one with `platform` web/ios/android and one with
`platform: server`. "monitoring is off here" means that half was built or run
in dev, or its DSN is set to `off`. Do it once on the web and once in the iOS
app.

**Source maps (not uploaded yet).** Stack traces from the browser bundle are
minified. Uploading source maps needs a Sentry auth token at build time, and no
build step here may require a secret (Lovable builds with none), so it is not
wired. To add it later: `npm i -D @sentry/vite-plugin`, add
`sentryVitePlugin({ org, project, authToken: process.env.SENTRY_AUTH_TOKEN })`
to `vite.plugins` **only when `SENTRY_AUTH_TOKEN` is set** (so a build without
it still passes), set `build.sourcemap: "hidden"` in the same condition, and
put `SENTRY_AUTH_TOKEN` in the build environment that should upload (Xcode
Cloud, or a CI release job). The release name must match `SENTRY_RELEASE`
above.
