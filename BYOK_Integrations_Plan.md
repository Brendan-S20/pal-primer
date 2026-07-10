# BYOK Integrations Plan — Stripe & Twilio (per-tenant)

**Status:** 📋 Planned, not started (held at plan per Brendan, July 10, 2026). Two new work items (#58 Stripe, #59 Twilio) scoped from a full read-only audit of the current integrations. Decisions locked below; open questions flagged.

**Principle:** the **platform** keeps its own Stripe + Twilio for platform-level jobs (billing tenants, auth/OTP, automated notifications). Each **tenant/owner** connects their own Stripe + Twilio for the tenant↔client relationship (charging their clients, conversing with their clients). This mirrors the AI-Tools BYOK already shipped (`org_ai_credentials` + `src/lib/ai-credentials.server.ts`).

**Three distinct Stripe roles — kept on separate env vars so they can never collide (noted per Brendan, July 10, 2026):**
| Role | Purpose | Keys |
|------|---------|------|
| **Platform billing (bucket A)** | HoundStack charges tenants for Launch/Growth/Scale subscriptions (the per-employee plans + seat-sync already shipped) | `PLATFORM_STRIPE_SECRET_KEY` / `PLATFORM_STRIPE_WEBHOOK_SECRET` |
| **Connect platform (bucket B)** | The platform-of-record for Stripe Connect; makes tenant→client charges on connected accounts and receives Connect webhooks | `STRIPE_CONNECT_SECRET_KEY` / `STRIPE_CONNECT_CLIENT_ID` (OAuth) / `STRIPE_CONNECT_WEBHOOK_SECRET` |
| **Tenant (connected) accounts** | Each owner's own Stripe, authorized via Connect OAuth; funds settle here | `organizations.stripe_connect_account_id` (`acct_…`), no secret stored |

Platform billing and the Connect platform are a **separate Stripe connection** each — bucket A is untouched by this work and never shares keys with bucket B. The bare `STRIPE_SECRET_KEY` (currently doing both) is retired: bucket A moves fully to `PLATFORM_*`, bucket B moves to Connect.

---

## Audit baseline (what exists today)

**Stripe — one account, two jobs.** There is a single `STRIPE_SECRET_KEY`. Both the platform's SaaS billing of tenants (checkout, seat-sync — bucket A) *and* every tenant-charging-their-clients flow (invoice pay, portal card entry, autopay, signup prepay — bucket B) authenticate with it. A `PLATFORM_STRIPE_SECRET_KEY` pair exists but every platform reader falls back to `STRIPE_SECRET_KEY`, and `billing.functions.ts` uses the bare key with no prefix. **No Stripe Connect, no `stripe_account_id` column.** Per-tenant identity today is only `clients.stripe_customer_id` / `default_payment_method_id` — minted on the shared account.

Bucket-B touchpoints to migrate: `invoices.functions.ts:149`, `portal.functions.ts:249/441/462/512/547/823`, `nightly.ts:304` (autopay), `signup.functions.ts:98`, tenant webhook `api/public/hooks/stripe.ts:120`. Bucket A (leave on platform key): `billing.functions.ts`, `seat-sync.server.ts`, `platform-billing.functions.ts`, `api/public/hooks/platform-stripe.ts`.

**Twilio — not even direct.** All SMS goes through the **Lovable connector gateway** (`src/lib/twilio.server.ts`) with platform-wide `LOVABLE_API_KEY` + `TWILIO_API_KEY`. The only per-org value is `organizations.sms_from_number`. No account SID/token columns. Inbound SMS/voice webhooks (`api/public/hooks/twilio.ts`, `twilio-voice.ts`) authenticate with a single shared `TWILIO_INBOUND_SECRET` and route to an org by matching the `To` number against `sms_from_number`. The AI receptionist (`ai-receptionist.server.ts`) generates replies via the AI gateway and rides Twilio only as transport (stock TwiML `<Gather>`/`<Say>`).

Send-callers: `messages.functions.ts` (manual `sendSmsToClient`, templated `sendVisitStatusSms`), `reviews.functions.ts`/`my-day.functions.ts` (review asks), `nightly.ts` (overdue reminders), `portal-auth.server.ts` (OTP).

---

## Item #58 — Tenant Stripe via **Stripe Connect (OAuth)**

**Decision (locked):** Stripe **Connect**, not pasted raw keys. Owners click "Connect with Stripe" (OAuth) and authorize their own Stripe account; HoundStack never stores their secret key. Enables an optional platform application fee and keeps key-liability on Stripe/​the tenant.

**Why Connect also simplifies the hard part:** with Connect, tenant charges run against the connected account using the **platform** secret key plus the account context (`{ stripeAccount: "acct_…" }` for direct charges, or `on_behalf_of`/`transfer_data` for destination charges). That means **one platform webhook endpoint with one signing secret** receives events for all connected accounts (each event carries an `account` field) — no per-tenant webhook secret or per-org URL needed, which was the ugliest part of the raw-keys design. The platform publishable key also works client-side by passing the connected account to Stripe.js (`Stripe(pk, { stripeAccount })`), so no per-tenant publishable key.

**Build:**
1. **Schema:** `organizations.stripe_connect_account_id text` (acct_…), `stripe_connect_status text` (pending/active/restricted), `stripe_connect_charges_enabled bool`. Migration + backfill null.
2. **OAuth connect flow:** a "Connect with Stripe" action in Settings → Payments that starts Stripe Connect OAuth (Standard recommended: tenant gets their own Stripe dashboard, bears liability) and a callback route (`/api/public/hooks/stripe-connect-callback`) that stores the returned `acct_…` and calls `accounts.retrieve` to record `charges_enabled`. A "Disconnect" action (`oauth/deauthorize`).
3. **Resolver:** `src/lib/stripe-connect.server.ts` → `resolveOrgStripeAccount(orgId)` returns `{ accountId, chargesEnabled } | null`. **No fallback to the platform account** for bucket B — if the org hasn't connected, tenant-charging flows return a clear "connect your Stripe account in Settings → Payments" error (same shape as the AI BYOK "add your key" prompt).
4. **Refactor bucket-B call sites** to run charges on the connected account: `invoices.functions.ts`, `portal.functions.ts` (×5 — customers, setup, detach, saved-card PI, inline Payment Element), `nightly.ts` autopay, `signup.functions.ts`. Customers, PaymentMethods, and PaymentIntents must be created **on the connected account** (`{ stripeAccount }`). Return the platform publishable key + `stripeAccount` to the one client-side path (`portal.$slug.$token.pay.$invoiceId.tsx`).
5. **Connect webhook:** add a Connect-events endpoint (or extend `platform-stripe.ts`) that keys off the event's `account` field to find the org; move any tenant-charge event handling (`checkout.session.completed`, `payment_intent.*`, portal setup finalize, dunning) here, and **remove the bucket-A `customer.subscription.*` branch from the tenant webhook `stripe.ts:353-387`** (that's platform-billing logic that must not run on tenant events).
6. **UI:** Settings → Payments (Connect button + status: connected / restricted / charges-not-enabled), and update the onboarding "Connect Stripe" step (`onboarding.functions.ts:74`) to key off `stripe_connect_account_id` instead of the SaaS `stripe_customer_id`.
7. **Cleanup (do regardless):** give `billing.functions.ts` the `PLATFORM_` prefix and drop the `?? STRIPE_SECRET_KEY` fallbacks so platform (A) and tenant (B) can never collide.

**⚠️ Cutover caveat (must plan):** every existing `clients.stripe_customer_id` and `default_payment_method_id` lives on the *platform* account and is invalid on a newly-connected account — saved cards and autopay will error ("No such customer") until re-saved. Cutover must, when an org connects: clear stale `clients.stripe_customer_id`/`default_payment_method_id`/autopay flags (forcing clients to re-save a card), or run a Stripe customer migration to the connected account. Open invoices carrying a `stripe_payment_intent_id`/`checkout_url` from the old account are likewise stranded.

**Open questions for Brendan:** Connect **Standard vs Express** (Standard = tenant self-manages, least platform liability; Express = HoundStack-branded onboarding, more control)? Charge an **application fee** (platform revenue share) or pass 100% to the tenant? Direct vs destination charges (direct is simplest for "tenant charges their own client").

**Model:** Fable 5 (multi-file, security-critical, greenfield Connect).

---

## Item #59 — Tenant Twilio for tenant↔client **conversation** (BYOK)

**Decision (locked):** platform Twilio sends **OTP + all automated notifications**; the tenant's own BYOK Twilio is used **only for two-way tenant↔client conversation**. This narrows tenant-Twilio scope to: manual staff↔client SMS, inbound SMS replies, and the AI receptionist (SMS + voice). Everything automated/auth stays on the platform's (A2P-registered, reliable) number.

**Channel split (each current send-caller assigned):**
| Flow | File | Sender |
|------|------|--------|
| Portal login OTP | `portal-auth.server.ts` | **Platform** (auth) |
| Visit reminder / on-my-way / completion | `messages.functions.ts` `sendVisitStatusSms` | **Platform** (notification) |
| Overdue-invoice reminder (cron) | `nightly.ts` | **Platform** (notification) |
| Review-request SMS (auto + manual) | `my-day.functions.ts`, `reviews.functions.ts` | **Platform** (notification) — *confirm: acceptable that the review ask comes from the platform number, not the tenant's?* |
| Manual staff → client message | `messages.functions.ts` `sendSmsToClient` | **Tenant** (conversation) |
| Inbound SMS + AI receptionist reply | `api/public/hooks/twilio.ts` | **Tenant** (conversation) |
| Inbound voice AI receptionist | `api/public/hooks/twilio-voice.ts` | **Tenant** (conversation) |

**Build:**
1. **Schema:** `org_twilio_credentials` (mirror `org_ai_credentials`, service-role-only, RLS on / no policies): `organization_id PK`, `account_sid`, `auth_token`, `sms_from_number` (the conversational number), `messaging_service_sid` (optional, needed for A2P), `updated_at/by`. Keep the platform's own Twilio in env for the notification/OTP path.
2. **Resolver:** `src/lib/twilio-credentials.server.ts` → `resolveOrgTwilioConfig(orgId)` returns the tenant's `{ accountSid, authToken, from | messagingServiceSid }` or null. A separate `platformTwilioConfig()` for the notification/OTP path.
3. **Rewrite `twilio.server.ts` `sendTwilioSms`** to call the **Twilio REST API directly** (`POST /2010-04-01/Accounts/{Sid}/Messages.json`, Basic auth) with an explicit credentials arg — bypassing the Lovable gateway, which is the point of BYOK. Notification/OTP callers pass the platform config; conversational callers pass the resolved tenant config.
4. **Inbound webhooks (`twilio.ts`, `twilio-voice.ts`):** resolve the org from the `To` number (still unique per org even across accounts), then **validate `X-Twilio-Signature` with that org's auth token** (the shared `?s=` secret can't authenticate N tenant accounts). AI receptionist replies go back out on the tenant's number.
5. **UI:** extend Settings → SMS to collect Account SID + Auth Token (+ optional Messaging Service SID) alongside the conversational sender number; `get/set/clearOrgTwilioSettings` gated on `manage_settings`, returning only a masked token last-4 (mirror `ai-settings.functions.ts`). Show the per-org inbound webhook URL for the tenant to paste into *their* Twilio console.

**⚠️ Caveats:**
- **A2P 10DLC:** each tenant must register their own 10DLC brand/campaign in their own Twilio account or US carriers filter their conversational SMS. UI must warn; resolver should let the tenant keep the platform number for conversation until their registration clears (a `messaging_service_sid` is where A2P attaches, hence the column).
- **Two-sender UX (accepted):** clients will see automated reminders/OTP from the platform number and conversation from the tenant's number. Accepted per decision; worth a line in the tenant's client-facing comms so the two numbers aren't confusing.
- **Cron has no session:** `nightly.ts` / `my-day.functions.ts` run under service role — resolvers must work from an `orgId` alone (like `resolveOrgAiConfig`). (These are platform-notification sends anyway, so they use the platform config.)

**Open question for Brendan:** confirm review-request SMS should come from the **platform** number (classified as a notification) rather than the tenant's conversational number — it's the one send that's arguably "tenant→client" but is automated/templated.

**Model:** Fable 5 (webhook-auth rework + direct Twilio integration across many callers).

---

## Suggested sequencing
Twilio (#59) has a smaller blast radius than payments and no cutover-of-stranded-financial-state; Stripe Connect (#58) is higher value but needs the customer-migration cutover planned first. Recommend **#59 → #58**, each behind its own commit, with the Stripe cutover script written and reviewed before any org is switched.
