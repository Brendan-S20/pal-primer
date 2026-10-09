# Intuit app assessment: draft technical answers

Draft answers to the technical questions in Intuit's app assessment
questionnaire for the HoundStack QuickBooks Online integration. Every answer
is taken from the code on branch `claude/quickbooks-for-real` (2026-10-09) and
cites the file and line it rests on.

An answer marked **pending sandbox test** depends on the end-to-end test the
owner runs against an Intuit sandbox company (connect, push invoice, push
payment, disconnect, reconnect). Do not submit it as fact until that test
has passed.

Intuit app settings, as entered by the owner:

| Setting | Value |
|---|---|
| Redirect URI | `https://app.houndstack.com/api/public/hooks/qbo-callback` |
| Launch URL | `https://app.houndstack.com/settings/accounting` |
| Connect/Reconnect URL | `https://app.houndstack.com/settings/accounting?connect=quickbooks` |
| Disconnect URL | `https://app.houndstack.com/settings/accounting?disconnected=quickbooks` |

---

## 1. App information

**Was the app built from scratch, or with an SDK or third-party library?**
From scratch. The integration uses the `fetch` API against Intuit's REST
endpoints and has no Intuit SDK or OAuth library: `package.json` has no
`intuit-oauth`, `node-quickbooks` or similar dependency. The HTTP layer is
`src/lib/qbo-http.server.ts:112` (`qboHttp`), OAuth is
`src/lib/qbo-oauth.server.ts`, and the Accounting API client is
`src/lib/qbo-client.server.ts:106` (`QboClient.request`).

**Platform.**
A web application: TanStack Start (React 19) with server functions, hosted
from the Lovable deployment of `main`, built for a Cloudflare target by
Nitro (`vite.config.ts:3`). Data is in Supabase (Postgres with row level
security). The same web app also ships in iOS and Android wrappers
(Capacitor). The QuickBooks connection runs entirely on the server. The
callback is under `/api`, which Android never opens in the app
(`src/lib/android-app-links.ts:138`). The settings page is an Android App
Link (`src/lib/android-app-links.ts:90`).

**Does the app read, write or delete QuickBooks data?**
Read and write. It never deletes.
- Writes: Customer (create only), Invoice (create and sparse update) and
  Payment (create and sparse update). See `findOrCreateQboCustomer`
  (`src/lib/accounting.server.ts:222`) and `upsertEntity`
  (`src/lib/accounting.server.ts:298`).
- Reads: Customer queries by DisplayName and email
  (`src/lib/accounting.server.ts:232`, `:244`); Invoice and Payment reads for
  the SyncToken before an update; Item and Account lists for the settings
  page (`src/lib/accounting.functions.ts:55`); CompanyInfo to confirm a
  disconnect (`src/lib/accounting.functions.ts:149`).
- Scope: `com.intuit.quickbooks.accounting` only
  (`src/lib/qbo-config.server.ts:49`).

**Public or private app?**
Public. Any HoundStack business (a pet-waste removal company) can connect its
own QuickBooks Online company from Settings → Accounting.

**User types.**
Small-business owners and their office managers. Only those two roles can
connect, sync or disconnect, through the `manage_settings` permission:
- server functions: `src/lib/accounting.functions.ts:12` and
  `src/lib/accounting-oauth.functions.ts:31`;
- RLS: `supabase/migrations/20260801090000_nine-tables-where-the-server-function-was-the-only-gate.sql:110`
  and `supabase/migrations/20261009161500_quickbooks-for-real.sql:120`.

Dispatchers and technicians cannot.

**Other platforms the app integrates with.**
- Stripe (card payments and HoundStack's own billing)
- Twilio (SMS)
- Google (maps, sign-in)
- Sign in with Apple
- Resend (email)
- Sentry (error monitoring)
- Anthropic (AI features)

Xero was removed on 2026-10-09. QuickBooks Online is the only accounting
integration.

---

## 2. Authorization and authentication

**Have you tested the OAuth flow in the sandbox?**
**Pending sandbox test.** Every OAuth path is unit-tested against a scripted
Intuit (`tests/support/fake-intuit.ts`), but no call has been made to a real
Intuit sandbox:
- `tests/quickbooks-online-for-real.test.ts`
- `tests/quickbooks-connect-and-disconnect.test.ts`

**How often are tokens refreshed?**
On demand, never on a timer. Before each API call the client checks the
access token. If it has less than five minutes left
(`REFRESH_SKEW_MS`, `src/lib/qbo-client.server.ts:26`), the client refreshes
it first (`src/lib/qbo-client.server.ts:69`). It also refreshes once on a 401
(`src/lib/qbo-client.server.ts:134`).

Every refresh response is persisted before it is used, including the rotated
refresh token:
- in the client, `src/lib/qbo-client.server.ts:89`;
- the storage write, `src/lib/qbo-connection.server.ts:101`.

The access token's one-hour life and the refresh token's expiry are both read
from each token response (`src/lib/qbo-oauth.server.ts:129`).

**Do you retry failed calls?**
Yes, but only transient failures. 429 and 5xx responses, and network
failures, are retried with exponential backoff and jitter:
- the retryable statuses, `src/lib/qbo-http.server.ts:54`;
- the backoff, `src/lib/qbo-http.server.ts:60`: 500 ms, then 1 s, then 2 s,
  capped at 8 s, and Retry-After is honoured up to 30 s;
- at most 4 attempts (`src/lib/qbo-http.server.ts:16`).

A 4xx validation error is never retried. It is recorded in the sync log with
Intuit's error code and `intuit_tid` (`src/lib/qbo-http.server.ts:141`,
`src/lib/qbo-sync.server.ts:50`).

Creates carry a `requestid`, so a retried create cannot make a duplicate
(`src/lib/accounting.server.ts:260`, `:316`).

Tests: `tests/quickbooks-online-for-real.test.ts`, the `retries` block.

**Do you prompt the user to reconnect?**
Yes. A refresh token that is expired, or refused with `invalid_grant`, marks
the connection `needs_reconnect`:
- `src/lib/qbo-client.server.ts:76`, `:142`;
- `src/lib/qbo-oauth.server.ts:166`;
- `src/lib/qbo-connection.server.ts:85`.

After that, syncing stops (`src/lib/qbo-connection.server.ts:124`). The user
is asked to reconnect:
- on Settings → Accounting, with a Reconnect button
  (`src/routes/_authenticated/settings.accounting.tsx:226`);
- on the dashboard, for owners and office managers
  (`src/routes/_authenticated/dashboard.tsx:123`).

The Connect/Reconnect URL starts the OAuth flow directly for an owner or
office manager (`src/routes/_authenticated/settings.accounting.tsx:133-142`).

**Do you use the discovery document?**
Yes. The authorize, token and revocation endpoints all come from Intuit's
discovery document for the environment `QBO_ENVIRONMENT` selects:
- the document URLs, `src/lib/qbo-config.server.ts:32`;
- the fetch, `src/lib/qbo-oauth.server.ts:43`.

The document is cached for 24 hours (`src/lib/qbo-oauth.server.ts:24`). If a
refresh of it fails, the last good copy is used
(`src/lib/qbo-oauth.server.ts:65`). Its endpoints must be `https` on
`intuit.com` (`src/lib/qbo-oauth.server.ts:34`).

The Accounting API host is chosen per environment
(`src/lib/qbo-config.server.ts:39`), because the discovery document does not
list it.

**Do you handle an expired access token, an expired refresh token, invalid_grant, and CSRF?**
- **Expired access token:** refreshed before expiry, and on a 401, with the
  call repeated once (`src/lib/qbo-client.server.ts:69`, `:134`).
- **Expired refresh token:** the connection is marked needs-reconnect
  without calling Intuit (`src/lib/qbo-client.server.ts:76`).
- **invalid_grant:** the connection is marked needs-reconnect and syncing
  stops (`src/lib/qbo-oauth.server.ts:166`). During the connect callback it
  is shown as a clean error instead (`src/lib/qbo-callback.server.ts:59`).
- **CSRF:** the `state` is 256 random bits (`src/lib/qbo-redirect.ts:33`).
  It is stored server-side in `oauth_states` with a 10-minute expiry
  (`src/lib/accounting-oauth.functions.ts:47-56`). It is consumed by a single
  `DELETE … RETURNING`, so it works once
  (`src/routes/api/public/hooks/qbo-callback.ts:26`). It is checked for
  existence, provider and expiry before the code is exchanged
  (`src/lib/qbo-callback.server.ts:41-46`). A mismatch redirects to the
  settings page with a plain-language error, and the code is never
  exchanged.

`oauth_states` is unreadable to every signed-in user
(`supabase/migrations/20261009161500_quickbooks-for-real.sql:135`).

Tests: `tests/quickbooks-online-for-real.test.ts` (tokens) and
`tests/quickbooks-connect-and-disconnect.test.ts` (the callback's CSRF
check).

**Did you use the OAuth Playground?**
No. The flow was written against Intuit's OAuth 2.0 documentation and the
discovery document. The sandbox test exercises it end to end
(**pending sandbox test**).

---

## 3. API usage

**API categories used.**
Accounting API only (scope `com.intuit.quickbooks.accounting`). The entities
it uses:
- **Customer:** query and create.
- **Invoice:** create, read and sparse update.
- **Payment:** create, read and sparse update. Each Payment is linked to its
  Invoice with `LinkedTxn` (`src/lib/accounting.server.ts:194`).
- **Item and Account:** query only.
- **CompanyInfo:** read only.

No Payments API, Payroll or OpenID scopes are used.

**How often does the app call the API?**
Only when a person acts. Nothing is scheduled:
- **"Send to QuickBooks" on a paid invoice:** one invoice and its payments
  (`src/routes/_authenticated/invoices.$invoiceId.tsx:435`).
- **"Send paid invoices and payments now" in Settings:** up to 50 invoices
  per press (`src/lib/accounting.functions.ts:233`, `:243`).
- **Opening Settings → Accounting:** reads the item and account lists.

Typical cost per invoice:
- 2 to 4 calls the first time: customer lookup or create, invoice create,
  one payment create per payment;
- 2 calls per object on an update (read the SyncToken, then a sparse
  update);
- plus a token refresh at most once an hour.

A full press of 50 is at most a few hundred calls, well inside Intuit's
per-company limit of 500 requests a minute. A 429 is retried with backoff
anyway.

---

## 4. Error handling

**Have you tested API errors?**
Against a scripted Intuit, yes:
- 400 validation faults, including Duplicate Name 6240, Invalid Reference
  2500 and Object Not Found 610;
- 401, 429 with Retry-After, and 500, 502 and 503;
- network failures;
- `invalid_grant` on refresh and on the code exchange.

See `tests/quickbooks-online-for-real.test.ts` and
`tests/quickbooks-connect-and-disconnect.test.ts`. Against a real sandbox
company: **pending sandbox test**.

**Do you capture intuit_tid?**
Yes, from the response header of every call, including failed ones and
token calls (`src/lib/qbo-http.server.ts:135`). It is carried on every error
(`QboApiError.intuitTid`) and stored in `accounting_sync_log.intuit_tid` with
each outcome:
- the column, `supabase/migrations/20261009161500_quickbooks-for-real.sql:106`;
- the writes, `src/lib/qbo-sync.server.ts:50`, and
  `src/lib/qbo-connection.server.ts:72`.

Owners and office managers see recent errors with their Intuit ID on Settings
→ Accounting, under Recent activity
(`src/routes/_authenticated/settings.accounting.tsx:348-380`).

**Do you keep logs?**
Yes. `accounting_sync_log` holds one row per customer, invoice, payment or
connection event. Each row has the status, the QuickBooks Id, the message,
`intuit_tid`, the HTTP status, Intuit's error code and the attempt count.

The server writes it on the service role. Signed-in users can only read it,
and only the office of the same business can
(`supabase/migrations/20261009161500_quickbooks-for-real.sql:120-131`). It
carries the two-step sign-in policy (`:125`).

Tokens and the client secret are never logged:
- error messages are built from Intuit's fault code and text, never from a
  request or a response body (`src/lib/qbo-http.server.ts:74`);
- the callback logs only the status, code and `intuit_tid`
  (`src/lib/qbo-callback.server.ts:59`);
- `tests/quickbooks-credentials-stay-on-the-server.test.ts` checks every
  console call in the QuickBooks modules;
- `tests/quickbooks-online-for-real.test.ts` runs a failing refresh and
  asserts that no token or secret appears in any output.

**How does a customer contact support?**
In the app:
- Settings → Accounting has a Help section with a link to the Knowledge
  Center and `support@houndstack.com`
  (`src/routes/_authenticated/settings.accounting.tsx:38`, `:396`). It asks
  the user to include the Intuit ID from Recent activity.
- The Knowledge Center is also linked from the header of every signed-in
  page (`src/routes/_authenticated/route.tsx:432`).

`support@houndstack.com` is the platform's support inbox
(`src/lib/platform-inbound.server.ts:28`).

---

## 5. Security

**Where are the client ID and secret stored?**
Only in the server's environment (`QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`,
`QBO_ENVIRONMENT`). They are read in exactly one server-only file
(`src/lib/qbo-config.server.ts:23`).

They are never prefixed `VITE_` and never read from `import.meta.env`, so
they cannot reach the browser bundle. Settings → Accounting receives only a
yes or no for "configured" (`src/lib/accounting.functions.ts:19`).

Enforced by `tests/quickbooks-credentials-stay-on-the-server.test.ts`.

**How are OAuth tokens stored?**
Encrypted at rest with AES-256-GCM. The key is held only in the app's
environment (`CREDENTIAL_ENCRYPTION_KEY`), so the database holds ciphertext
it cannot read. This is the mechanism the Twilio and webhook secrets already
use (`src/lib/secret-encryption.server.ts:26`, `:70`).

- Writes: `src/lib/qbo-connection.server.ts:107` and `:168`.
- Reads (decrypted only in server memory): `src/lib/qbo-connection.server.ts:132`.

Signed-in users cannot SELECT the token columns at all. They are granted
every other column, and UPDATE on the three mapping columns only
(`supabase/migrations/20261009161500_quickbooks-for-real.sql:144-152`).

Any token stored before encryption is deleted, and the owner is asked to
reconnect (`:96`). On disconnect, the token is revoked at Intuit's
revocation endpoint and deleted locally
(`src/lib/qbo-connection.server.ts:197-218`).

**MFA.**
Optional two-step sign-in with an authenticator app, per user
(`src/components/TwoStepCard.tsx:76`, on the Profile page). Once a user turns
it on:
- a session signed in with the password alone is sent to `/two-step` before
  any business data loads (`src/routes/_authenticated/route.tsx:81`);
- every RLS table carries a RESTRICTIVE policy that refuses that session at
  the database, through `require_mfa_policy`
  (`supabase/migrations/20261002010000_a-password-was-the-only-lock.sql:59`).

The three QuickBooks tables have it:
`supabase/migrations/20261009161500_quickbooks-for-real.sql:125`, `:134` and
`:140`. MFA is not mandatory for every user.

**CAPTCHA.**
None. No CAPTCHA is used on sign-in or sign-up. Sign-in relies on Supabase
Auth's built-in rate limits and optional two-step sign-in.

**WebSockets.**
None. The app does not use Supabase Realtime or any other WebSocket. There
is no `.channel(` or `postgres_changes` in `src/`. Every QuickBooks
interaction is a request from the user's browser to our server, or from our
server to Intuit.

**Is Intuit data shown to anyone other than that customer?**
No. QuickBooks data (the connection, the sync log, and the QuickBooks Ids
stored on clients, invoices and payments) is shown only to the business that
connected it, and within it only to the owner and office managers. This is
enforced by row level security in the database, not only by the app:
- the connection: `supabase/migrations/20260801090000_nine-tables-where-the-server-function-was-the-only-gate.sql:110`;
- the sync log: `supabase/migrations/20261009161500_quickbooks-for-real.sql:120`.

Proved against a real Postgres by `tests/sql/quickbooks-for-real.proof.sql`,
run by `tests/quickbooks-data-stays-with-its-business.test.ts`. An owner of
one business sees only that business's connection and log. A technician of
the same business sees neither. No browser session can read a token or a
CSRF state, or forge a log row.

Server code that runs on the service role scopes every query by the org
(`src/lib/qbo-connection.server.ts`).

---

## Known limits, stated rather than hidden

- **Sync is manual.** Nothing pushes on a schedule. The old "auto-sync
  nightly" checkbox did nothing and was removed.
- **Refunds and voids are not sent.** A refunded payment, or a voided
  invoice, is not reflected in QuickBooks.
- **Account credit is not sent.** When account credit paid part of an
  invoice in HoundStack, the QuickBooks invoice is left with that balance
  open, and the sync log says so
  (`src/lib/qbo-sync.server.ts`, the message on the invoice row).
- **Sales tax goes across as its own line.** QuickBooks' automated sales tax
  is not used. The owner chooses a non-taxable service item, and a separate
  item for tax whose account is the sales-tax liability. Whether a US
  company with automated sales tax adds tax of its own on top is **pending
  sandbox test**.
- **Disconnect URL.** The page marks the connection disconnected only after
  QuickBooks confirms it no longer accepts the token. Without that check, a
  link anyone could send would cut a working connection.
