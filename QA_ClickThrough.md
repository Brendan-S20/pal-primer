# HoundStack QA Click-Through

> **Superseded, kept for history (note added 2026-10-04).** This July script
> predates the retirement of bring-your-own-key AI (there is no tenant API key
> to test any more) and the removal of AI dispatch. What still needs a person
> is in `docs/owner-qa-checklist.md`, which also names the `tests/e2e/` spec
> that now covers each item a machine can prove.

Base URL: **https://app.houndstack.com**

This script covers the items that need a real browser + real credentials to
confirm (they can't be proven by unit tests alone). Each section lists what to
click and the **expected** result. Anything that deviates is a bug — note the
step number and what you saw.

You'll need:
- A **platform admin** login (for impersonation + plans).
- An **owner** login for a test tenant org (for AI Tools, billing, settings).
- A **client/portal** magic link for that org (for portal auth).
- A test **Anthropic or OpenAI API key** (for AI Tools BYOK). A throwaway key
  with a few dollars of credit is enough.
- Stripe test cards (sandbox): success `4242 4242 4242 4242`, any future
  expiry, any CVC/ZIP.

---

## 1. AI Tools — Bring Your Own Key (BYOK)  *(finding #2)*

The AI features now run on **each org's own** Anthropic **or** OpenAI key,
entered in Settings. No key = the tools are disabled with a clear prompt.

**A. Add a key**
1. Log in as the tenant **owner**. Go to **Settings → AI Tools**
   (`/settings/ai`).
2. Before entering anything, confirm the status card reads either *"No AI key
   configured yet…"* or *"Using the platform's default AI key…"* — not an error.
3. Choose a **Provider** (Anthropic or OpenAI).
4. Paste your test API key. Confirm the field is masked (password dots) and
   the placeholder matches the provider (`sk-ant-…` vs `sk-…`).
5. (Optional) leave **Model** blank — confirm the helper text shows the default
   model for the chosen provider.
6. Click **Save key**.
   - **Expected:** green "AI key saved" toast; the key field clears; the status
     card now shows *"<provider> key configured · ····<last 4 digits>"* and the
     model. The full key is **never** shown again.

**B. Use the tools**
7. Go to **AI Tools** (`/ai-tools`). Try each tool:
   - **Marketing content** — enter a prompt, generate. Expect real copy back.
   - **Review reply** — paste a sample review, draft a reply.
   - **Churn scoring** — run it; expect scored clients.
   - **Weekly digest** — generate; expect a summary.
   - **AI dispatch** — run against a day with visits; expect suggestions.
   - **Zone pricing** — run; expect price suggestions.
   - **Expected:** each returns a real result within a few seconds. No blank
     panels, no silent failures.

**C. Error paths (important)**
8. Go back to **Settings → AI**, click **Remove key**. Confirm the status card
   flips back to "no key / platform fallback."
9. Return to **AI Tools** and run any tool with **no key set**.
   - **Expected:** a clear message telling you to *add your Anthropic or OpenAI
     API key in Settings → AI* — **not** a crash or an infinite spinner.
10. Re-add a **deliberately wrong** key (e.g. `sk-ant-broken`) and run a tool.
    - **Expected:** a friendly error telling you to *check your API key* —
      again, no crash.
11. Re-add your real key to leave the org in a working state.

---

## 2. Plans & Billing — per-employee model  *(findings #6 / #51)*

Plans are priced **per employee**: a flat base for a team-size range that
includes N people, plus **$15/mo per extra person** ($150/yr on annual).
Customers are unlimited on every plan. Stripe is in **sandbox**, so there are
no real charges. These are the Oct 9, 2026 numbers (confirmed by Brendan on
Oct 17).

**A. Catalog**
1. As platform admin, open **/platform/plans**. Confirm the three paid plans:
   - **Launch**: $79/mo, teams of 1 to 3, 1 person included.
   - **Growth**: $199/mo, teams of 4 to 15, 5 people included.
   - **Scale**: $449/mo, teams of 16 or more (no cap), 20 people included.
   - **Enterprise**: custom (no fixed price and no extra-person price; the
     overage column reads "By contract").
   Each paid plan should show *"$15/employee/month"* for overage and the
   number of people included.

**B. Checkout (sandbox)**
2. As the tenant **owner**, open **/billing**. Start a subscription / upgrade.
3. On the Stripe checkout page, confirm:
   - The **base** line item matches the plan price ($79 / $199 / $449).
   - **If the org has more active employees than the plan includes**, a second
     line item **"Per additional employee" × (overage count)** at $15 each
     ($150 each on annual) appears. (If the org is at/under the included seats, there's only the base
     line — that's correct.)
4. Pay with test card `4242 4242 4242 4242`.
   - **Expected:** redirect back with an "upgraded" state; **/billing** shows
     the plan as **active** with the correct period end.
5. Click **Manage billing** (Stripe portal) — confirm it opens the portal for
   that customer.

**C. Seat sync (ongoing)**
6. With an active subscription on a per-employee plan, go to
   **Settings → Users & roles** and **deactivate** an employee (or activate a
   previously-inactive one) so the active-employee count crosses the plan's
   included seats.
7. In Stripe (sandbox) open that customer's subscription.
   - **Expected:** the **"Per additional employee"** line item quantity now
     equals `active employees − included seats` (and the item disappears when
     the org drops back to/under the included count). Deactivating removes a
     seat; activating adds one.
8. As a further check, accept a **teammate invite** for that org (new employee
   signs in), then reopen the Stripe subscription.
   - **Expected:** the seat quantity went up by one. (Viewing **/billing** also
     re-reconciles the count if it ever drifts.)

---

## 3. Signup / bootstrap  *(finding #55)*

1. Open the signup link for a test slug: **/signup/<slug>** (use a fresh slug
   your team hasn't used).
2. Complete the signup form and submit.
   - **Expected:** the org bootstraps cleanly — you land in a working
     authenticated app (dashboard loads, no 500, no "organization not found").
3. Log out and log back in with the new credentials.
   - **Expected:** you return to the same org with your data intact.

---

## 4. Client portal auth  *(finding #4)*

1. Get a portal magic link for a test client:
   **/portal/<slug>/<token>**.
2. Open it in a **fresh/incognito** window.
   - **Expected:** you reach the client portal home for the correct client —
     no login wall, correct client's data only.
3. Click through the portal tabs: **Visits**, **Requests**, **Property**,
   **Billing**, **Account**.
   - **Expected:** each loads that client's data only. No other client's info
     is ever visible.
4. Tamper test: change one character in the **token** in the URL and reload.
   - **Expected:** access is **denied** (invalid/expired link) — you do **not**
     get into anyone's portal.
5. Pay an invoice from **Billing → Pay** with test card `4242…`.
   - **Expected:** payment succeeds in sandbox and the invoice reflects paid.

---

## 5. Impersonation  *(finding #5)*

1. As **platform admin**, open a tenant: **/platform/tenants/<id>**.
2. In the impersonation panel, pick a **User to impersonate** and confirm.
   - **Expected:** a new window opens into that user's session, and a visible
     **impersonation banner** is shown at the top the entire time.
3. While impersonating, confirm you're scoped to **that org only** and the
   banner clearly says who you're impersonating.
4. Click **Stop impersonating** (or close per the banner's instruction).
   - **Expected:** you return to your **own** admin session cleanly — your
     admin session was never replaced/hijacked in the original window.
5. Tamper test: try loading **/impersonate** directly without a valid token.
   - **Expected:** denied — no session is granted.

---

## 6. Weather-driven scheduling  *(finding #15)*

1. As owner/dispatcher, open **/weather**.
   - **Expected:** current + forecast conditions load for the org's service
     area (no blank widget, no error).
2. Confirm any weather-based reschedule/skip prompts reference the right dates
   and read sensibly.

---

## Regression sweep (quick)

- **Dashboard** loads with real numbers.
- **Concerns** (`/concerns`), **Analytics** (`/analytics`), **DNA**
  (`/dna`) pages load without errors.
- **Settings** tabs all open (Preferences, Skip rules, Lead form, Blackouts,
  Add-ons, SMS, Emails, **AI Tools**, AI receptionist, Reviews, Automation,
  Deep-clean, Accounting, Promotions, Users & roles).

---

### How to report
For any failure, note: **section + step number**, what you clicked, what you
expected, what actually happened, and a screenshot. Include the org/tenant and
whether you were admin/owner/client at the time.

---

# Part 2 — BYOK integrations, embeds & customization (post-merge)

These flows were added after the original punch-list. They need the deployed app
plus the `STRIPE_CONNECT_*`, `PLATFORM_SMS_FROM_NUMBER`, and Supabase Google-OAuth
config in place.

> **Deployment note (CSP):** the embedded Stripe components load scripts from
> `js.stripe.com` and `connect-js.stripe.com` and render Stripe iframes. If they
> don't appear, the hosting Content-Security-Policy must allow:
> `script-src … https://js.stripe.com https://connect-js.stripe.com`,
> `frame-src … https://*.stripe.com`, `connect-src … https://api.stripe.com https://*.stripe.com`.

## 7. Tenant Stripe via Connect (Express) — embedded

1. As an **owner**, go to **Settings → Payments** → **Set up payments**.
   - **Expected:** an in-app Stripe **onboarding** flow appears (embedded, no
     redirect to stripe.com). Complete the test verification.
2. When onboarding finishes, the page should show **Charges enabled** and an
   **embedded dashboard**: balances, payments, payouts, and account management —
   all in-app.
3. Create an invoice for a client and, from the client portal, **pay it**.
   - **Expected:** the charge succeeds on the connected account, and (per your
     Stripe pricing tool) the **0.25% platform fee** is collected.
4. In **Settings → Payments → Disconnect**, confirm it disconnects and that a
   previously-saved client card now needs re-entering (cutover).

## 8. Embedded payment method (client portal)

1. Open a client's portal → **Billing** → **Add payment method**.
   - **Expected:** an **inline card form** appears in the page (Stripe Payment
     Element) — no redirect. Enter a test card, Save.
2. Confirm the saved card shows (brand + last 4) and **autopay** can be turned on.
3. Pay an open invoice with **Pay with saved card**.

## 9. Tenant Twilio (conversation) + review-ask routing

1. **Settings → SMS → Bring your own Twilio**: enter a Twilio Account SID + Auth
   Token + sender number, Save. Set that number's inbound webhook (shown on the
   page) in the Twilio console.
2. Send a manual message to a client and reply inbound.
   - **Expected:** the conversation uses the **tenant's** number; the AI
     receptionist replies from it.
3. Trigger a **review request** (client detail → Request review).
   - **Expected (Twilio connected):** SMS from the **tenant's** number.
   - **Expected (no Twilio connected):** an **email** review request instead —
     never the platform number.
4. Confirm **OTP + automated notifications** (reminders, on-my-way, overdue) come
   from the **platform** number `+18668063017`, not the tenant's.

## 10. Signup & quote form (#25, merged 2026-10-08)

The lead form and online signup are one form now. `/signup/{slug}` prices the
yard and lets the visitor start service or ask for a quote; `/lead/{slug}`
forwards to it with its query string.

1. **Settings → Signup & quote form → Customize the form**: set a brand color,
   logo URL, headline/intro/confirmation, and toggle off one optional question
   (e.g. Notes). Save. (`/settings/lead-form` forwards here.)
2. With **Accept signups online** OFF, open the form (or `/lead/{slug}?utm_source=test`).
   - **Expected:** the URL ends `/signup/{slug}?utm_source=test`; your branding
     shows; no price and no card; the toggled-off question is gone; after
     **Request a quote**, your confirmation message appears and the request is
     in **Leads** labeled "Quote request".
3. Turn it ON (Stripe connected), enter a ZIP in a priced zone, **Get instant price**.
   - **Expected:** the price, then **Start service** and **Just send me a quote**.
     A ZIP outside every zone shows "We don't have online pricing for that ZIP
     yet" and a **Request a quote** button instead.
4. Start service but stop at the card form.
   - **Expected:** Leads shows the person as "Started signup online, didn't
     pay". Pay with a test card on a second try: the same row turns
     "Started service online" with **Open client**.

## 11. Google sign-in (#17)

1. On the sign-in page, click **Continue with Google**.
   - **Expected:** Google consent → returns signed in; a brand-new Google user
     gets an org bootstrapped, an invited one joins their org with the right role.
