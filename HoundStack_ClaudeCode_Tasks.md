# HoundStack QA Punch List — Claude Code Track

> **Historical (note added 2026-10-04).** This is the July 2026 QA punch list.
> Its findings were worked through and tracked in `docs/MASTER_BRIEF.md`'s
> status ledger; model names and the AI items here describe that time, not the
> product today (AI is now only the receptionist and marketing posts, both
> coming soon). Current owner actions: `docs/owner-actions-before-submission.md`.

**Generated:** July 8, 2026 &nbsp;|&nbsp; **Last updated:** July 10, 2026 (post-migration retouch) &nbsp;|&nbsp; **Items in this file:** 38 of 57 total findings &nbsp;|&nbsp; **Source:** Consolidated Master QA Report (HoundStack_QA_Findings_Consolidated_Master.docx)

## How to use this file

This is one of two execution-track files split from the 57-finding consolidated QA punch list (53 original findings + 4 discovered in a post-migration engineering pass on July 10, 2026). This file contains every finding assigned to the **Claude Code track** — work involving security, financial calculations, data integrity, permission/auth logic, or new backend/feature capability, where correctness matters more than iteration speed. The companion file, `HoundStack_Lovable_Tasks.md`, contains the remaining findings: lower-risk UI copy, styling, and cosmetic fixes suited to Lovable's fast iteration loop.

Each item below is self-contained: severity, affected role(s), the area of the app, what QA found, the specific fix to build, and which Claude model to run it with. Feed each item's "What to build/fix" text directly to the assigned model as the task prompt — it already has full context baked in, so it doesn't need to reference this document or any other report.

**July 10, 2026 update:** HoundStack's backend has been migrated off Lovable Cloud onto an independently-owned Supabase project (ref `vsxzrbxublqrcfnxfwcu`), and the email pipeline was rebuilt to call Resend directly. This retroactively removed the reason items #2 (AI Tools) and #32 (Email invoice feedback) were routed to the Lovable track — neither depends on a Lovable-exclusive secret anymore, so both moved back into this file. Four new findings from a post-migration engineering/QA pass were also added to the master list: #54 and #56 are informational/already-resolved (not assigned to either track, see the master report), #55 is a new Critical item in this file, and #57 is an ops checklist item (also not assigned to either track).

## Model assignment key

- **Claude Fable 5** — used for large, multi-step, or new-feature work: permission-model overhauls, new backend capabilities, algorithmic/scheduling features, or anything spanning many files or requiring a long autonomous session. Fable 5 is Anthropic's current recommendation for large migrations, complex implementations, and multi-day autonomous work.
- **Claude Opus 4.8** — used for narrower, contained bug fixes and logic corrections: a single broken calculation, a form that doesn't load data, a missing validation check. These don't need a long autonomous run — Opus 4.8's precision is the better fit.

**Split in this file:** 13 items → Fable 5, 25 items → Opus 4.8.

## Sequencing

Run this track **before** the Lovable track (see `HoundStack_Lovable_Tasks.md` for the full reasoning). Lovable's own documented best practice warns against simultaneous Lovable-editor and GitHub-based edits on the same project — doing Claude Code work first, merging it, and letting Lovable sync from GitHub avoids that conflict. Within this file, do the Critical items first, in order; #1 (permission model) and #47 (Dashboard KPI exposure) share a root cause and should be done together since #47 is a direct application of #1's fix. Likewise #6 (Plans catalog rebuild) and #51 (duplicate free tiers) should be done together. #55 (signup/bootstrap gap) is a live-verification task with a fix already implemented — cheap to run early and close out, since a broken signup path is the highest-leverage thing to rule out first.

**File-overlap risks with the Lovable track** (full audit, July 9, 2026, re-checked July 10, 2026 after #2/#32 moved into this file — see `HoundStack_Lovable_Tasks.md` for the complete list with reasoning): `my-day.tsx` is the highest-traffic shared file — this track's #34, #18, #35 land there alongside Lovable's #49 and #33. The New Client wizard shell is shared between this track's #13 and Lovable's #42. `/auth` is shared between #17 (ops item, not code) and Lovable's #44. Lower-risk: Routes/Board view (#9/#10/#26/#27/#28 here vs. Lovable's #48) and the sidebar (#50 here, possibly, vs. Lovable's #37/#43). If any of #34/#18/#35/#13 land while Lovable is mid-work on the same file, tell Lovable to re-sync from GitHub before it continues. Note: `ai-tools.functions.ts` (touched by both #1 and now #2) is no longer a cross-track risk — both items are on this track as of July 10, 2026, so no inter-track GitHub-sync step is needed there; just sequence #1 before #2 within this file since #2's provider swap should build on #1's permission-gating, not race it.

## Deployment workflow — read before touching any finding with a migration

**Lovable does not apply git-pushed database migrations automatically.** This was learned the hard way during finding #4: code pushed to `main` deploys normally, but any accompanying SQL migration file does not run against the live database on its own — it has to be pasted and run manually in the database's own SQL editor. This caused a full live outage on finding #4 (the deployed code called database functions/tables that didn't exist yet) and, discovered at the same time, meant finding #1's DB-layer RLS/RPC hardening had *also* silently never applied to live, even though it had been reported as shipped — only its TypeScript-layer checks were actually protecting anything live until the gap was found and fixed.

**July 10, 2026 update — this workflow may be about to change; verify before assuming either way.** The backend has since moved off Lovable Cloud onto an independently-owned Supabase project (ref `vsxzrbxublqrcfnxfwcu`), and a Supabase-management MCP connection (with `apply_migration`, `list_migrations`, `execute_sql`, and related tools) is now available in-session. That's a real opportunity to apply migrations directly and immediately instead of routing every SQL script through Brendan — but that MCP connection has not actually been exercised against this project yet, so don't assume it works end-to-end (auth scope, project targeting, and whether it's pointed at the right environment are all unconfirmed). On the next finding with a migration, try `list_migrations`/`apply_migration` first and confirm the change actually landed (query the affected table/column afterward), but keep the idempotent-SQL-script handoff ready in case the MCP path doesn't behave as expected.

Standing rule for every future finding with a migration: generate a single idempotent SQL script (safe to re-run), and either apply it directly via the Supabase MCP tools (confirming it landed) or hand it to Brendan to paste into the SQL editor, exactly as was done for #4. Do not report a migration-containing finding as "shipped" until that SQL has been run and verified against production — a green local build and a successful `git push` are necessary but not sufficient.

**Second standing rule, also learned on #4:** local test suites cannot prove everything. Cookie-scoping bugs, cross-route session behavior, and anything depending on exclusive live secrets can pass every local test and still be broken live. Treat "tests green" as proof of the logic being tested, not proof the feature works end to end — for anything auth- or delivery-related, drive the actual flow in a real browser (or ask for it to be driven live) before calling it done. (This is also the exact gap behind #55: the signup/bootstrap fix passed code review and a simulated webhook call, but hasn't yet been driven through a real signup in a browser.)

## Not in this file: Items #17, #54, #56, #57

Four findings are **not assigned to either execution track**:

- **#17 (Google OAuth branding)** requires no application code change — it's an account/console action item for Brendan: creating a Google Cloud project, configuring OAuth consent, and entering credentials into the right dashboard. July 10, 2026 update: this now happens in the independently-owned Supabase project's own dashboard (Authentication → Providers → Google, project ref `vsxzrbxublqrcfnxfwcu`), not inside Lovable's Cloud panel — the backend is no longer Lovable-managed even though the app is still built in the Lovable editor for lower-risk UI/copy work. See the full checklist in the Consolidated Master Report (finding #17).
- **#54 (`portal_reschedule_visit` column bug)** is already fixed and verified at the database level — logged for the audit trail, with one recommended live click-through test noted in the master report, but no build task to assign.
- **#56 (subscriptions RLS)** was investigated during post-migration testing and closed as not a bug — logged for the audit trail only.
- **#57 (Resend domain verification + Supabase signup rate limit)** is an ops/console checklist for Brendan, not a coding task — see the master report for the two items to check.

---

## Critical Findings

### #1 — Role-based permission model gates page navigation, not the sensitive actions and data reachable through pages that remain open — confirmed across three roles

**Status:** ✅ Shipped and verified live (July 9, 2026) — do not restart this work.

**Severity:** Critical  
**Role(s) affected:** Office Manager, Dispatcher, Technician  
**Area:** Access control — Role design  
**Model to use:** Claude Fable 5  

**What we found:**  The same architectural gap was independently confirmed in three separate role-QA passes, each catching a different symptom of it. Office Manager: the role's permission model is very coarse, granting near-total administrative access that differs from Owner by only two pages (Franchise, Import) — the role has almost no boundary to begin with. Dispatcher: the opposite extreme — the most locked-down role tested, with Leads, Inventory, Invoices, Billing, Reports, Analytics, AI tools, Franchise, Import, and Settings all correctly blocked server-side — yet Dispatcher retains full, unrestricted access to two financially significant capabilities simply because they live inside pages that remain open: full create/edit/delete access to pricing Zones, and full client-billing control (generate invoices from unbilled visits, add one-time/recurring paid add-ons, void pending charges) via a client's Billing tab, even though the equivalent aggregate Invoices page is correctly blocked. Technician: the Clients page itself is entirely blocked, yet the full client roster — name and complete home address — is exposed through the DNA compliance and Neighbor canvassing pages; separately, Technician can bill real add-on charges to a client's account directly from My day with no cap, no confirmation, and zero visibility into the resulting invoice, and can independently set a DNA compliance fine dollar amount and mark a sample "Billed" — the same billing-exposure pattern via a different open page. Across all three roles, the common root cause is the same: the access-control design gates which top-level pages/routes a role can navigate to, not the sensitive reads and writes reachable from whichever pages happen to stay open for that role.

**What to build/fix:**  This is a Critical, cross-cutting architecture gap, not three unrelated per-page bugs — treat it as one fix. Audit every write action and every data read reachable from any page shipped to any role (Zones, a client's Billing tab, DNA compliance, Neighbor canvassing, My day, and any other page not yet audited) against that role's intended scope, and define granular, action-level permissions — e.g. can-edit-pricing, can-manage-client-billing, can-view-client-directory, can-bill-dna-fines — that are checked at the point of the actual read/write, not just at the top-level route/nav-visibility level. Fix these confirmed instances first: Dispatcher must not be able to edit Zone pricing or generate/void invoices via a client's Billing tab; Technician must not be able to see other clients' names/addresses via DNA compliance or Neighbor canvassing, and must not be able to post billable add-on charges or DNA fines without a capped, confirmed, office-visible workflow. Then re-run this same audit for Office Manager's broad access, since its near-total admin scope means any action-level gap found elsewhere in the app is very likely reachable by that role too.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. This is a ground-up permission-model overhaul spanning every non-Owner role's page/action/data-layer checks — the largest and most security-critical single item in the whole punch list.

---

### #2 — AI Tools structured-output failures are systemic across the whole module

**Status:** 🔶 Implemented + reworked to bring-your-own-key (July 10, 2026). Per Brendan's direction, each org now enters its **own Anthropic OR OpenAI** API key in Settings → AI (stored in a service-role-only `org_ai_credentials` table — never exposed to the browser; only a masked last-4 is shown), and the five tools use that key; a platform `ANTHROPIC_API_KEY` env still works as a fallback. The shared `generateStructured`/`generateAiText` helper now supports both providers natively (Anthropic forced tool-use; OpenAI forced function-calling) and every failure path throws a typed error (incl. a 401 → "check your API key" hint). The churn `clients.status` bug fix is retained. 58 unit tests green (both providers). Awaiting a live run: a QA click-through (enter a key in Settings → AI, then run each of the five tools against seeded data). All five AI Tools (plus the Weekly digest text call) moved off the Lovable AI Gateway / Vercel AI SDK `Output.object()` onto the Anthropic Claude API directly (`src/lib/ai.server.ts`): structured output now uses native forced tool-use with an explicit JSON Schema, re-validated with zod, and **every** failure path throws a typed `AiGenerationError` (missing key, API rejection, truncation at max_tokens, no tool_use block, schema mismatch — raw output logged server-side for diagnosis) so a real failure can never look like a legitimate empty result; the existing UI toasts surface these. The Churn-risk `clients.status` bug is fixed — the real column is `clients.active` (boolean), confirmed against the live schema. Unit tests cover the helper's success/mismatch/truncation/retry/missing-key paths (27 tests green). REMAINING: (1) Brendan must set `ANTHROPIC_API_KEY` in the app server's hosting env (Lovable project secrets; optional `ANTHROPIC_MODEL` override, default `claude-sonnet-5`); (2) after that, run all five tools against seeded data and sanity-check the *content* (the end-to-end run couldn't happen from this session — no provider key is present here, and the live app is unreachable under this session's egress policy).

**Severity:** Critical  
**Role(s) affected:** Owner  
**Area:** AI Tools — all tabs  
**Model to use:** Claude Fable 5  

**What we found:**  Of the five AI Tools tabs tested, only Weekly digest reliably produced output. Churn risk (“Re-score all active clients”) throws the raw database error “column clients.status does not exist” directly in the UI on every run — a functionality failure and an information-disclosure concern, since it reveals internal schema. Marketing content (“Generate”) and Review replies (“Draft reply”) both fail on every tested input with the identical toast “No object generated: response did not match schema.” Zone pricing (“Suggest zone prices”) and AI dispatch (“Suggest reassignments”) both run their “Analyzing…” state and then quietly revert to an empty “No suggestions yet” with no error at all — notably, AI dispatch was tested against an extreme, obvious reassignment candidate (a visit sitting 1,854 km from the assigned technician) and still returned nothing, suggesting it is failing the same way as the other two but swallowing the error instead of surfacing it. This strongly suggests one shared, broken structured-output layer underlies the whole module rather than five unrelated bugs.

**What to build/fix:**  CONFIRMED ROOT CAUSE (unchanged from the original diagnosis, so this shouldn't need re-diagnosing): the AI Tools module calls an AI gateway using generateText({ output: Output.object({ schema }) }) via the Vercel AI SDK — structured-output mode is unreliable against the current model/gateway combination, while plain generateText({...}) reading `text` (used by the one working tool, Weekly digest) works fine.

Update: HoundStack is moving AI Tools off Lovable's AI Gateway (ai.gateway.lovable.dev, model google/gemini-3-flash-preview) onto a direct provider integration. Fix this as part of that swap rather than patching around the old gateway — point all five AI Tools calls at a direct provider API (Anthropic's Claude API is the natural fit given the rest of the stack, though OpenAI or Gemini direct are also viable) using that provider's native structured-output/tool-use support instead of the Vercel AI SDK's generic Output.object() wrapper — native structured outputs from a direct provider tend to be far more reliable than SDK-abstracted ones layered on top of a gateway.

Concretely: (1) Churn risk (“Re-score all active clients”) — also throws a raw “column clients.status does not exist” database error on every run, a functionality bug independent of the gateway swap; confirm the real column name directly (do not assume) and fix the query alongside the provider swap. (2) Marketing content (“Generate”) and (3) Review replies (“Draft reply”) both fail on every tested input with “No object generated: response did not match schema” — re-implement with the new provider's native structured output. (4) Zone pricing (“Suggest zone prices”) and (5) AI dispatch (“Suggest reassignments”) both quietly return an empty result instead of surfacing an error — same underlying failure mode, just swallowed; fix under the same provider swap and make sure a real failure is never indistinguishable from a legitimate empty result.

Build one shared generateStructured(schema, prompt, label) helper around the new provider's native structured output, convert all five broken tools to use it, and add end-to-end tests against seeded data asserting real parsed output or a typed error, never a silent empty state. Since this no longer depends on a Lovable-exclusive secret — a direct provider API key is a normal secret Claude Code can hold and test against locally — this is now buildable and fully testable end-to-end without a Lovable-side round trip: after implementing, actually run all five tools against real seeded data and confirm the output content itself is correct, not just that nothing threw — a tool that stops crashing but returns malformed or nonsensical content due to a looser JSON-repair path would be a silent regression of a different kind.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Swapping the structured-output layer across five tools onto a new provider, plus a shared helper and end-to-end tests, is multi-file, multi-step work, not a single contained fix.

---

### #3 — Per-acre commercial pricing drops the base price entirely — a $20/visit account was quoted and saved at $0.28/visit

**Status:** ✅ Shipped (July 10, 2026). Root cause: in `getInternalQuote` (New Client wizard Plan step), when a zone priced by area the computed area charge *replaced* the zone's base price instead of adding to it. The math is now extracted to a pure helper (`src/lib/pricing.ts`) that always sums base + area (with the area minimum applied to the area component only) + per-extra-dog, with unit tests including the exact QA repro (2,472 sq ft in Downtown Commercial → $20.28, not $0.28). Checked the public signup path's `public_quote` DB function — it never used area pricing, so it doesn't share the bug. Production audit run against live: exactly one affected subscription existed (the QA repro client "Geocode Test" at $0.28); corrected to $20.28 directly in the live DB. Note: the wizard currently only auto-quotes residential accounts, so drive a fresh commercial-with-boundary quote when the UI is next touched live.

**Severity:** Critical  
**Role(s) affected:** Owner  
**Area:** Pricing engine — New Client wizard / per-acre zones  
**Model to use:** Claude Opus 4.8  

**What we found:**  Created a client in the “Downtown Commercial” zone (base $20.00 + $5.00/extra dog + $5.00/acre) with a hand-drawn yard boundary of 2,472 sq ft (~0.057 acres). The New Client wizard’s Plan step calculated “SUGGESTED PRICE / VISIT: $0.28” and, after clicking Create client, saved the subscription at exactly $0.28/visit, active. $0.28 matches only the acreage component (0.057 acres × $5/acre ≈ $0.28) — the zone’s $20.00 base price was completely dropped from the calculation. This is a direct revenue-impacting bug: any commercial client onboarded through the standard wizard with a drawn yard boundary in a per-acre zone is billed a fraction of a cent instead of the correct rate, and the UI presents and saves this number with full confidence — nothing flags it as implausible.

**What to build/fix:**  Reproduce: create a new Commercial client whose property ZIP falls in a zone that has both a base price and a $/acre rate (e.g. Downtown Commercial: $20 base + $5/extra dog + $5.00/acre). In wizard step 3 (Sketch the yard), draw a small boundary (a few thousand sq ft is enough). On step 5 (Plan), the ‘Suggested price / visit’ shows only the acreage component (e.g. a 2,472 sq ft / ~0.057-acre boundary produced ‘$0.28’ suggested, and this was saved as the live subscription price on Create), completely omitting the zone’s base price. Find the pricing calculation used on the New Client wizard’s Plan step (and check whether the same function backs zone-price suggestions elsewhere, e.g. AI Tools > Zone pricing) and fix it to sum base price + (rate_per_extra_dog × extra_dogs) + (rate_per_acre × acres) + any other configured components, not the acreage term alone. Treat as top priority given direct revenue impact, and audit existing production subscriptions created via a drawn boundary in a per-acre zone for the same underestimate — fixing the calculation going forward won’t correct already-saved subscriptions.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. A single, well-defined pricing calculation bug (per-acre commercial pricing drops the base price).

---

### #4 — Client portal has zero authentication — a bare, guessable-format link is the only thing standing between anyone and a client’s payment method, invoices, and property/access details

**Status:** 🔶 Verified against live (July 10, 2026) — one final human browser click-through outstanding. Full state audit run this session, code + live DB: (1) OTP auth core is complete and live — `portal_otps`/`portal_sessions`/`portal_code_attempts` tables exist with RLS deny-all (service-role only), codes are hashed + single-use + attempt-limited (5) + rate-limited per client (5/hr, 30s spacing) and per IP (15/hr), sessions are 30-day, cookie-path is `/` (the earlier cookie-scoping bug's fix is in place with an explanatory comment); (2) the "already have a code" path exists on BOTH the generic `/portal/{slug}` entry and the token flow, including office-read-code and org-code redemption with its own IP limiter; (3) "Regenerate portal link" exists in the Owner client page and its `regenerate_portal_token` RPC is live — rotation orphans all old sessions by design; (4) **email delivery is now confirmed live**: the earlier failures were an invalid `RESEND_API_KEY` (26 failed portal-OTP sends, fixed ~21:30 July 9 — 3 real portal-OTP sends succeeded at 21:41 with Resend provider IDs logged in `email_send_log`), and this session verified the queue path end-to-end by enqueuing a labeled test email that went `pending → sent` (provider id `9c64be53…`) in ~30s; the July 9 signup/welcome DLQ entries all date from the bad-key window; `process-email-queue` cron fires green every minute at the correct `www.` host. NOT yet done: a human click-through of the live portal flows (SMS path in particular — needs `sms_from_number` configured — plus code-entry UX on a phone). No code changes were needed this round.

**Severity:** Critical  
**Role(s) affected:** Owner  
**Area:** Client portal — Security  
**Model to use:** Claude Fable 5  

**What we found:**  Every client has a “Client portal link” shown on their Overview tab (e.g. https://www.app.houndstack.com/portal/{uuid}). Opening that link requires no login — no password, PIN, email verification, or one-time code of any kind. The portal itself displays the message “Bookmark this page — it’s your private portal. Don’t share the link,” which confirms the product is aware the link is the only protection and is relying on the client to keep it secret. Live-tested end-to-end: anyone holding this URL can see the client’s name, next visit date/time window and the assigned technician’s name (a real physical-security signal — it reveals exactly when the property will be serviced and unattended), add a saved card or bank account and enable autopay via Stripe, apply promo/gift codes, view every invoice, see the dogs on file, and submit “Report a concern” messages as that client. No “regenerate/revoke link” control exists anywhere on the Owner’s client page — if a link leaks (forwarded email, shared-device browser history, a screenshot in a text thread), there is currently no way to invalidate it and issue a new one.

**What to build/fix:**  The client portal (/portal/{uuid}) grants full access — payment method entry/autopay via Stripe, invoice history, property and dog details, and the ability to submit concerns as the client — to anyone holding the URL, with no authentication step at all. The portal’s own copy (“Don’t share the link”) shows the product already recognizes this is fragile. Add a lightweight verification gate before the portal unlocks — e.g. require the visitor to enter the last 4 digits of the phone number on file, or send a one-time 6-digit code via SMS/email to the contact info on file and require it before granting a session (a magic-link + short-lived session-token pattern instead of a permanently valid bare URL). Add a “Regenerate portal link” action on the Owner’s client page that invalidates the old link and issues a new one, for use whenever a client reports their link may have been exposed. Consider link expiry/periodic re-verification and rate-limiting repeated access attempts by IP. Until stronger auth ships, flag this internally as security-by-obscurity rather than a real login, since it currently guards billing and payment-method actions.

Implementation note (added after an infrastructure rebuild subsequent to this finding): the client portal sits on the same Supabase project/auth stack as the rest of the app, and the email-sending path was rebuilt in the interim — whichever verification-code delivery you build (SMS or email OTP) should go out through the current dispatcher, which calls Resend directly via RESEND_API_KEY (a normal secret, no longer routed through Lovable's connector gateway), or through Supabase Auth's own “Send Email” hook if you build this on top of Supabase Auth's native OTP flow rather than a custom code table. Two infrastructure gotchas already found and fixed elsewhere in this same rebuild are worth knowing before wiring portal verification into either path: (1) app.houndstack.com (no www) 307-redirects to www.app.houndstack.com, and outbound webhook/hook callers don't follow redirects on POST — any hook or callback URL used here must use the www. host or it will silently fail; (2) the send path depends on notify.houndstack.com's Resend domain verification (DKIM/MX/SPF) being fully complete — confirm it shows verified in Resend's dashboard before relying on it for a security-critical flow like this one (see item #57 for the current verification-status check).

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Adding real authentication to the client portal is a security-critical feature build, not a patch — token/session design, not a copy or CSS fix.

---

### #5 — Impersonate has no safety rails, and silently hijacks the platform admin's own session in their original tab with zero warning

**Status:** ✅ Shipped (July 10, 2026) — DB + code, pending a live click-through. Root cause confirmed: auth is fully client-side (supabase-js persists to `window.localStorage`, which is shared across every tab of the origin), and impersonation opened a Supabase hosted magic link in a "new tab" — that link established the tenant session in the *shared* localStorage, overwriting the admin's own session everywhere. Rebuilt at the architecture level: (1) session isolation — an impersonation tab is opened with a `window.name` stamped `hs-impersonation:` (per-tab, set by `window.open` before the bundle loads), and `client.ts` now, synchronously at init, makes such a tab persist its session to `sessionStorage` under a distinct storage key; a normal tab is untouched and keeps localStorage. sessionStorage is per-tab and never shared, so impersonating a customer can no longer read or overwrite the admin's own session in any tab (unit-tested). (2) One-time exchange — `startImpersonation` now mints a single-use, 2-minute grant (`impersonation_grants` table, RLS deny-all, only a SHA-256 of the token stored) for a **specific** chosen user; the new tab hits `/impersonate#t=…` (a route outside all auth guards) and calls `consumeImpersonation`, which atomically claims the grant and mints the target session server-side (never in the admin's browser), returning tokens the tab loads into its own sessionStorage client. Single-use + expiry semantics verified against live SQL. (3) Safety rails — a confirmation dialog with a real user picker (no more silent default to owner; the tenant's users come from `getTenantDetail`), a persistent amber banner on every page of the impersonated session ("Viewing as {email} ({org}) — Exit impersonation"), and a one-click Exit that signs out only the tab's sessionStorage session and closes the tab. Migration applied to live via Supabase MCP; typecheck + 36 unit tests green. Remaining: a human should click through a real impersonation once (open tab → banner shows → original admin tab still works when navigating to Plans → Exit returns cleanly) — the session-isolation invariant is unit-tested but the finding was originally caught by cross-tab behavior only a real browser exercises.

**Severity:** Critical  
**Role(s) affected:** Platform Admin  
**Area:** Tenants — Impersonate  
**Model to use:** Claude Fable 5  

**What we found:**  Clicking "Impersonate" on a tenant's detail page logs the admin into that tenant as its owner with no confirmation step of any kind — no "you are about to sign in as owner@demo.test, continue?" dialog, and no choice of which user to impersonate (it silently defaults to the org's owner regardless of which of the tenant's 4 users the admin might have intended). It opens the impersonated session in a new browser tab and shows a small green toast ("Impersonation link opened for owner@demo.test") plus a "Signed in as owner" subtitle on that new tab's Dashboard — but there is no persistent, page-independent "you are impersonating a customer" banner anywhere, and no visible "Exit impersonation" control at all; the only way back is to sign out entirely. Far more seriously, this was confirmed twice, independently, with a clean re-login in between: after clicking Impersonate, the platform admin's own original tab continues to look and behave normally for a few clicks (its own tenant-detail sub-tabs — Users, Billing, Feature flags, Notes, Audit — all keep working), but the moment that same tab is navigated to a different top-level platform-admin page (e.g. clicking "Plans"), it hits "You don't have platform admin access," and clicking through from that error screen reveals the tab is now signed in as the impersonated tenant owner, not as the platform admin. This happened with no click, warning, or action by the admin targeting their own session — the act of impersonating a customer in a "new tab" silently overwrote the session for every tab open in that browser, including the admin's own. A platform admin doing routine follow-up work after impersonating a customer (the single most sensitive action available in this entire console) can end up, without realizing it, no longer authenticated as themselves and potentially continuing to act with the customer's permissions instead.

**What to build/fix:**  Reproduced twice cleanly (including after a full sign-out/sign-in cycle): on the tenant detail page (/platform/tenants/:id), clicking "Impersonate" opens a new tab signed in as the tenant owner, and shortly after, the ORIGINAL platform-admin tab silently loses its own session — continuing to navigate within it (e.g. clicking to a different top-level nav item like Plans) throws "You don't have platform admin access," and following "Back to app" from that error shows the original tab is now "Signed in as owner," i.e. it has become the impersonated session too. This points to session/cookie state being shared or overwritten across tabs in the same browser rather than being scoped to the new tab the impersonation link opens in. Fix this at the architecture level: impersonation must not touch or invalidate the admin's own session under any circumstance — issue the impersonated session as a token scoped only to the newly opened tab/window (e.g. via a one-time exchange endpoint and a differently-scoped cookie or storage key), never by mutating the primary auth cookie shared across the browser. Separately, add the missing safety rails regardless of the session-isolation fix: a confirmation dialog naming the exact user about to be impersonated (with a picker if the tenant has more than one user), a persistent banner visible on every page of the impersonated session reading something like "You are viewing as {email} — Exit impersonation," and a one-click exit control that returns cleanly to the platform admin console without requiring a full re-login.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Impersonation session handling is security-critical and touches session/auth state management broadly.

---

### #6 — The live Plans catalog bears no resemblance to houndstack.com's public pricing page — different tier names, and a completely different pricing model that the marketing site explicitly denies using

**Status:** 🔶 Rebuilt to the marketed per-employee model (July 10, 2026) — engineering done live; business sign-off + Stripe wiring outstanding. The document records no explicit (a)-vs-(b) decision for this finding, but its own engineering follow-up scopes option (a) precisely and the track's precedent (#15, #16) is consistently "build to match the marketing site." Since Brendan is away, I executed option (a) as the design pass the finding calls for, made it fully reversible (old rows deactivated, not deleted), and left the marketing-vs-model business decision + Stripe price creation flagged below. Shipped: (1) `platform_plans` rebuilt to the four marketed tiers — Launch $79 (3 employees), Growth $199 (10), Scale $449 (30), Enterprise (custom/by-contract) — each with `included_seats` + `price_per_seat_cents` ($10.00/employee overage) and unlimited customers (client caps removed); the seven dog-themed client-band tiers are deactivated (kept for history/FK safety). (2) Tier assignment is now **seat-based, not client-based**: new `active_seat_count` on organizations (maintained by a staff trigger), `assign_billing_tier_for_org` picks the smallest tier covering the org's active employees, `org_seat_overage_cents` computes the per-employee overage, and `organizations.plan_id` is now wired for every org (backfilled — demo org, 4 employees → Growth, $0 overage). (3) A real trial state: added `trialing` to the plan/billing status enums, a 14-day `trial_ends_at` expiry, and the old hard "3 active clients" cap is replaced by a trial/subscription gate (unlimited customers while subscribed or in an unexpired trial). Migrations applied to live via Supabase MCP and verified (catalog rows, demo org assignment, overage math). The Platform → Plans UI now renders base price / included employees / per-employee overage / unlimited customers instead of client bands. OUTSTANDING (needs Brendan / not codeable here): confirm the business decision is genuinely (a) and not (b) update-the-marketing-site; and the tenant-facing Settings→Billing copy still reads in client terms — reconciled under finding #23. The employee/seat-management invite flow this billing depends on is finding #40. FOLLOW-UP (July 10, 2026, verification pass): Stripe now wired end-to-end — sandbox products/prices created for launch/growth/scale (base + a new per-employee `stripe_seat_price_id`), backfilled onto `platform_plans` (migration applied live); `createBillingCheckout` now selects the tier by **active-employee count** (the earlier client-count band logic collapsed to Launch for every org and would have sold the wrong base) and attaches the seat-overage line item; `syncOrgSeatQuantity` reconciles the seat quantity on staff change / invite accept / billing view (`tests/seat-sync.server.test.ts`). Enterprise stays custom. Sandbox checkout itself is NEEDS-LIVE-QA (see `QA_ClickThrough.md`).

**Severity:** Critical  
**Role(s) affected:** Platform Admin  
**Area:** Plans catalog vs. public pricing page  
**Model to use:** Claude Fable 5  

**What we found:**  A cross-reference pass against houndstack.com surfaced the most significant gap found across this entire engagement. The public /pricing page is built entirely around a per-employee pricing model: four tiers named Launch ($79/mo, 3 employees included), Growth ($199/mo, 10 employees), Scale ($449/mo, 30 employees), and Enterprise (custom), with every additional active employee billed at a flat $10/month, and customers/dogs/jobs/routes/zones explicitly called out as unlimited on every plan. The page's own FAQ states, word for word: "Why don't you charge by number of customers or employees? Because growth is success, not a cost trigger... that is what the tiers price" — directly and explicitly telling prospective customers the product does not charge by customer count. The live Plans catalog (/platform/plans) shows none of this. The tier names are entirely different (Free, Puppy, Fetch, Scoop, Haul, Pack Leader, Kennel) and every single tier is priced by active-client band — 0–3, 4–25, 26–75, 76–125, 126–200, and 201+ clients respectively — which is precisely the pricing model the marketing FAQ says the company does not use. There is no employee count anywhere in the live plan catalog (every tier separately says "Unlimited staff"), no $10-per-additional-employee line item, and no plan named Launch, Growth, Scale, or Enterprise. This is not a copy mismatch or a stale price — it is two structurally incompatible billing models, one publicly marketed and one actually live, and it was corroborated by a second signal: Owner-role testing (see the Owner-role report, finding #28) found there is no real invite/seat-management flow in the product at all, meaning there is no mechanism to even count or bill for employees the way the marketing site describes.

**What to build/fix:**  houndstack.com/pricing markets a four-tier, per-employee pricing model (Launch $79/3 employees, Growth $199/10 employees, Scale $449/30 employees, Enterprise by contract, $10/mo per additional active employee, unlimited customers on every plan) and its FAQ explicitly states the company does not charge by customer or employee count. The live Plans catalog (/platform/plans) is a seven-tier model priced entirely by active-client band (Free/Puppy at 0–3 clients, Fetch at 4–25, Scoop at 26–75, Haul at 76–125, Pack Leader at 126–200, Kennel at 201+), with no employee-based pricing anywhere and no tier names matching the marketing site. This needs an urgent product/business decision, not just an engineering fix: determine which pricing model is the intended one going forward, then either (a) rebuild the live Plans catalog to match the marketed per-employee model exactly, including the $10/employee overage billing and named tiers (Launch/Growth/Scale/Enterprise), and build the employee-counting/seat-management logic this depends on (which doesn't currently exist per the Owner-role report's invite-flow finding), or (b) if the client-count model is actually the current direction, update houndstack.com immediately, since the current copy — especially the FAQ's explicit denial of charging by customer count — directly contradicts what a prospective customer would actually be billed under once they sign up. Until resolved, treat this as a trust and possible legal/advertising-accuracy risk, not just a product inconsistency.

Engineering follow-up since this finding was first raised confirms the scope precisely: the current platform_plans table is tiered by active_client_count with the stale dog-themed names described above; organizations.plan_id (the FK to a concrete plan row) is never set by any database function today — only billing_tier (a text slug) gets auto-assigned via trigger; and there is no permanent free tier in the real pricing model — it's a 14-day free trial with limitations, not an ongoing “free” plan status. This confirms the fix needs a proper design pass, not a quick patch: new platform_plans rows matching the real four tiers (with the $10/employee overage), a seat-count-based (not client-count-based) tier-assignment function, a real trial state with an expiry mechanism, and plan_id actually wired for every organization rather than left null.

Superseded Oct 9, 2026 (NP-1, confirmed by Brendan Oct 17): Launch $79 for teams of 1 to 3 with 1 included, Growth $199 for 4 to 15 with 5 included, Scale $449 for 16 or more with 20 included; $15/mo or $150/yr per extra person; see 20261009150000.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Rebuilding the Plans catalog to match houndstack.com's real pricing tiers is a substantial data-model and UI project, and should be scoped together with item #51 (duplicate free tiers) and the Pricing/Signup PRD (Appendix A).

---

### #55 — Signup/bootstrap gap — new users could land signed-in but orgless; a fix has shipped but has not yet been verified via a live signup

**Status:** 🔶 Verified & hardened at the DB level (July 10, 2026); the real-browser click-through remains blocked from this session. Done: (1) confirmed the deferred-bootstrap design is implemented on `/auth` for password sign-in, OAuth completion, and the already-signed-in landing path; (2) targeted debugging found and fixed two real gaps — `bootstrap_organization` had no lock, so the exact race this finding predicted (double-clicked confirmation link / two tabs → two orgs for one user) was structurally possible (`user_roles` uniqueness doesn't prevent it); it now serializes per-user via an advisory xact lock — and the bootstrap path would have silently auto-provisioned a spurious tenant org for a **platform admin** on their next `/auth` sign-in (platform admins have zero `user_roles` rows by design; guarded now both server-side in the function and client-side in `ensureBootstrapped`); (3) migration applied to live via Supabase MCP `apply_migration` (the MCP path works end-to-end — see Deployment workflow) and verified live with a simulated authenticated session: idempotent double-call returns the same org id, exactly 1 role row, admin guard returns NULL; test data rolled back cleanly. NOT done: the actual click-through signup → confirm-email → sign-in → populated-dashboard walkthrough (password and Google OAuth) — this session's network egress policy blocks `www.app.houndstack.com` and `*.supabase.co` (proxy 403, policy denial), so no browser here can reach the live app. Brendan (or any session with normal egress) still needs to run that walkthrough twice before this is fully closed.

**Severity:** Critical  
**Role(s) affected:** Owner  
**Area:** Signup / Onboarding  
**Model to use:** Claude Opus 4.8  

**What we found:**  Discovered during the post-migration engineering pass: HoundStack has email confirmation enabled on signup, so bootstrapOrganization (the function that creates the organization row and assigns the owner role) was only firing at signup time, when no authenticated session exists yet. The practical effect: a new user could complete signup, confirm their email, and log in — and land signed-in but with zero organization or role rows, i.e. an unusable account.

Fix already implemented: the org name/display name is now stashed in user_metadata at signup time, and the actual bootstrap call is deferred to first sign-in (covering both password login and Google OAuth), gated on the signing-in user having zero user_roles rows. bootstrap_organization is idempotent server-side, so a repeated call is safe.

Verification status: confirmed via code review, a successful typecheck, and a simulated signed webhook call — but a real click-through signup → confirm email → log in → land on a populated dashboard walkthrough has not been run since this change, for either the password or Google OAuth signup path. Given that a broken signup path blocks every new customer HoundStack tries to onboard, this is flagged Critical until that live verification happens, even though the underlying fix is believed sound.

**What to build/fix:**  This fix needs one thing before it can be marked closed: an actual live walkthrough of the full signup flow — real email address, real confirmation click, real login, landing on a populated dashboard — run twice: once via password signup, once via “Continue with Google.”

If either path still leaves a user signed-in without an organization/role, debug the bootstrap-deferral logic directly rather than re-reviewing it in the abstract — check for a race between the email-confirmation redirect and the first-sign-in bootstrap call, and confirm bootstrap_organization's idempotency actually holds if a user double-clicks a confirmation link or opens it in two tabs (concurrent first-sign-in bootstrap calls racing each other is the most likely failure mode if this does break).

This is a narrow verification-and-harden task, not a rebuild — the design (defer bootstrap to first sign-in, gate on role count, idempotent server-side call) is sound; the remaining risk is purely whether the implementation matches that design under a real signed cookie/session, which code review alone can't confirm.

**Why this model:**  Narrow, contained verification-and-harden task — well-suited to Opus 4.8's precision. The design is already sound and implemented; this is a live QA walkthrough plus targeted debugging if it surfaces a race condition, not a rebuild.

---

## High Findings

### #7 — Clients page “Outstanding” KPI is broken — always shows $0.00 / 0 clients

**Status:** ✅ Shipped (July 10, 2026). Root cause: `listClients` summed `invoices.amount_cents - amount_paid_cents`, but those columns don't exist (invoices carry only `subtotal_cents`/`total_cents`) — so the balance was silently always 0 while Dashboard/Reports summed `total_cents` on open invoices. Extracted the AR math into a shared helper (`src/lib/ar.ts`) and routed all three surfaces (Clients, Dashboard "AR Open", Reports "Outstanding") through it so they can't drift again. Unit-tested against the demo tenant's figure (12 open invoices → $5,270.00). Verified the live data: 12 open invoices summing to exactly $5,270.00. tsc + 40 tests green.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Clients — list summary  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Clients list (/clients) summary card “Outstanding” always shows $0.00 and “0 clients,” regardless of real data. This was cross-checked against two other places that compute the same figure correctly and agree with each other: Dashboard “AR Open” ($5,270.00) and Reports “Outstanding” ($5,270.00), which matches the sum of all 12 open invoices on the Invoices page. Individual client billing tabs also show real open balances (e.g. Kevin O’Brien has a $135.00 open invoice). The Clients page metric is simply not wired to real invoice data — this is the first thing office staff see when checking who owes money, and it currently always reads zero.

**What to build/fix:**  On the Clients list page (/clients), the ‘Outstanding’ summary card always shows $0.00 and ‘0 clients’ no matter what, while the Dashboard’s ‘AR Open’ card and the Reports page’s ‘Outstanding’ card both correctly compute this figure and agree with each other (confirmed at $5,270.00 across 12 open invoices in the demo tenant). Find the query/hook powering the Clients page summary stats and fix it to use the same outstanding-balance calculation already working on Dashboard/Reports (sum of totals on open invoices, grouped by client count with a balance > 0). Add a test asserting the Dashboard, Clients, and Reports pages always report the same outstanding total for a given date, so they can never drift again.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Isolated KPI calculation bug (Outstanding always $0.00).

---

### #8 — Subscription edit form doesn’t load existing values — risk of silent data loss

**Status:** ✅ Shipped (July 10, 2026). The form under the subscription summary was actually an *add* form with hardcoded defaults (weekly / $25 / 1 dog / no property or zone selected) — so it read as an edit form that would clobber the real values. Made it a genuine edit form: added an `updateSubscription` server function (gated on `manage_pricing`); on load and via a per-row "Edit" control the form hydrates every field from the actual subscription record through a pure, unit-tested helper (`subscriptionToFormValues`); a new blank "Add a new subscription instead" path uses empty/auto-selected defaults (the single property is auto-selected so a new subscription is never saved with no property). Submit routes to update vs. create by mode, and the button reads Save changes / Add subscription accordingly. Unit tests cover the hydration mapping and the single-property auto-select. tsc + 46 tests green.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Client detail — Service tab → Subscriptions  
**Model to use:** Claude Opus 4.8  

**What we found:**  On a client’s Service tab, the read-only subscription summary line (e.g. “Every 2 weeks · 2 dog(s) · postpaid · $45.00 · active”) does not match the values pre-filled in the edit form directly beneath it. In one case the form showed Frequency = Weekly (should be every 2 weeks), Price = $25 (should be $45), Dogs = 1 (should be 2), and Property left on the placeholder “Select…” instead of the client’s actual property. This was not just legacy seed data — it was reproduced live on a brand-new client created during this pass: a subscription priced at $20/visit (confirmed at creation and matching the zone rate) showed Price = $25 in the edit form, with Property and Zone both left on their unselected placeholders despite there being only one property to choose from. If an office manager opened this tab and clicked save without changing anything, the subscription would silently be overwritten with the wrong frequency, price, and dog count, and with no property attached.

**What to build/fix:**  On a client’s detail page, Service tab, Subscriptions section: the read-only summary line for an existing subscription does not match the values the edit form below it is pre-populated with. Reproduced on both legacy seed data and a client created fresh during testing — the Price field consistently shows a hardcoded default (25) instead of the subscription’s real price, and the Property/Zone dropdowns never auto-select the client’s actual (and often only) property/zone. This is a form-hydration bug: find the subscription edit form component and ensure its default values are initialized from the actual subscription record (frequency, price, dog_count, property_id, zone_id) rather than component defaults. This is a real data-loss risk — saving the form as currently shown would silently corrupt the subscription. Add an integration test that creates a subscription, reloads the page, and asserts every form field matches the underlying record before any edit is made.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained form-population bug with real data-loss risk — needs a careful, precise fix, not a broad rebuild.

---

### #9 — Routes page tells users to click “Geocode addresses,” but no such control exists

**Status:** ✅ Shipped (July 10, 2026). A bulk-geocode action had already been added since the finding (the `backfillPropertyGeocodes` server fn geocodes every property with a null lat/lng, and the shared geocoder already enforces a 1 req/s Nominatim throttle with a User-Agent — exactly the note's requirement), but the empty-state overlay that names the button was `pointer-events-none` and the only button lived in the map header (and vanished when there were no visits). Fixed by making the empty-state overlay itself contain a working "Geocode addresses" button wired to the same throttled bulk action, so the message and the control are co-located and reachable. tsc green.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Routes / Dispatch  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Routes (“Today”) map shows the empty-state message “No coordinates yet. Click ‘Geocode addresses’ to plot properties.” No button or link with that label exists anywhere on the page — checked in both the default view and with Planning tools expanded. Properties created through the New Client wizard do get geocoded automatically once a visit is generated for them, so this specifically affects properties that arrived another way: pre-existing/legacy data, and — more importantly — anything brought in through CSV import, which (see the CSV import finding below) doesn’t capture addresses at all today. For those properties there is currently no in-app path to get them plotted.

**What to build/fix:**  The Routes (‘Today’) page map empty-state reads ‘No coordinates yet. Click “Geocode addresses” to plot properties,’ but there is no button, link, or control with that label anywhere on the page (verified with Planning tools both collapsed and expanded). New-client-wizard properties get geocoded automatically once a visit is generated, so this gap specifically hits legacy/imported properties that never went through that path. Either this bulk-geocode action was removed/renamed during a refactor and the copy is stale, or it never existed. Add the missing action: a way to bulk-geocode all client properties missing lat/lng in one click. Wire the empty-state message to that action, or update the copy to point wherever geocoding now actually lives. This currently blocks route mapping and auto-optimization for any tenant whose properties aren’t geocoded, which is a core workflow for a route-based field service ERP.

Implementation note (added after a geocoding-provider change subsequent to this finding): geocoding now runs through Nominatim/OpenStreetMap directly (switched from a Google-backed path during a recent infrastructure rebuild), with a proper User-Agent header and real error logging already in place. Build this bulk action with Nominatim's usage limits in mind — its public instance is rate-limited to roughly 1 request/second and isn't meant for bulk/high-volume use. A “Geocode addresses” button that fires one request per unmapped property needs to queue and throttle those requests (sequential with a ~1s delay, not Promise.all) rather than firing them concurrently, or it will get rate-limited mid-run on any client with more than a handful of legacy/imported properties. If bulk CSV imports become a common scenario, flag whether Nominatim's public instance is still the right fit at that volume (a paid geocoding provider or a self-hosted Nominatim instance may be needed) — a known limitation, not a blocker for shipping this button now.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Implement the missing "Geocode addresses" action using the same geocoding integration already used elsewhere (see #13) rather than just deleting the misleading instruction.

---

### #10 — Route optimizer has no distance/plausibility check — will schedule a 1,850 km, 61-hour drive without warning

**Status:** ✅ Shipped (July 10, 2026). Root cause of the inconsistent ETA: `assign_route_for_day` (the "Auto-assign for tech" action) only set `assigned_staff_id` + `sequence` and left each visit's `eta_start`/`travel_km`/`travel_min` at STALE values computed for a different technician's depot — so a card showed a leftover "05:48 PM" ETA next to a freshly-implausible "3708 min" drive. Fixed at the DB level: the assign function now clears those routing fields on every (re)assignment (migration applied live), so an ETA is never shown that wasn't derived from the current drive. Plausibility guard: added a configurable `organizations.max_drive_minutes` (default 240, editable in the Routes dispatch-settings panel) and a pure, unit-tested helper (`route-plausibility.ts`) that flags any stop whose drive exceeds the threshold or whose arrival can't be reached from the workday start plus its drive; `assignRoute`/`optimizeRoute` now return these warnings and the Routes UI surfaces them as dispatcher toasts instead of silently accepting the route. Tests cover the exact 1,854 km repro and the ETA-inconsistency case (53 tests green).

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Routes / Dispatch — Auto-assign & Optimize  
**Model to use:** Claude Opus 4.8  

**What we found:**  Live-tested: with a technician’s route start/end address configured 1,150+ miles from the tenant’s service area (Taylor, MI vs. Austin, TX — see the related Settings finding), using “Auto-assign / optimize day for tech” happily assigned a normal in-zone visit to that technician. The resulting visit card reads “ETA 05:48 PM · 1854.2 km · 3708 min drive” (a 61.8-hour drive), scheduled same-day with no warning, error, or confirmation. The displayed ETA is also internally inconsistent with the drive time shown right next to it — 3,708 minutes from an 8:00 AM start could not produce a 5:48 PM same-day arrival, suggesting the ETA isn’t actually derived from the computed drive time.

**What to build/fix:**  On the Routes page, Auto-assign and Optimize will assign a visit to a technician whose configured depot address is over 1,000 miles away, with no warning or validation. Repro: set a technician’s route start/end address (Settings > Users & roles) far outside the tenant’s service zones, generate a visit in a normal zone, then use ‘Auto-assign / optimize day for tech’ to assign it to that technician. The visit card then shows an obviously wrong drive time (e.g. ‘1854.2 km · 3708 min drive’) scheduled with a same-day ETA (e.g. ‘05:48 PM’) that is impossible given that drive time. Fix two things: (1) audit the ETA calculation so it is always derived from the actual computed drive time from the tech’s previous stop/depot — it should never be able to show an arrival time earlier than departure time plus drive time; (2) add a configurable sanity threshold to the assign/optimize logic (e.g. flag or hard-block assignments implying more than a few hours of drive time or exceeding a max-distance setting), surfaced as a warning to the dispatcher rather than silently accepted. This protects against a mistyped depot address or bad optimizer output silently sending a tech on an impossible route.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Add a distance/plausibility bound to the existing route optimizer — a contained validation-logic addition.

---

### #11 — No way to send a first message to a client — Messages feature is a dead end

**Status:** ✅ Shipped (July 10, 2026). The backend to originate a thread already existed (`sendSmsToClient` sends via Twilio and inserts the `messages` row that constitutes a thread) — the gap was purely that no UI entry point existed, exactly as the empty-state copy promised. Added a "Messages" composer to the client detail Overview tab (next to Reviews & referrals, per the finding) that shows the recent conversation and sends the first/next SMS through that same path, so a new conversation appears both on the client page and in the main Messages list. It's disabled with a clear hint when the client has no phone on file, and surfaces the existing "no SMS sender number — Settings → SMS" error (that Settings page is finding #34). tsc green.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Messages / Client detail  
**Model to use:** Claude Fable 5  

**What we found:**  The Messages page’s empty state reads “Select a conversation from the left, or send a first message from a client’s detail page.” However, none of a client’s three detail tabs (Overview, Service, Billing) has any message composer or “Send message” control — confirmed by searching the full accessibility tree of a client page and finding zero message-related elements. There is currently no way to initiate a conversation with a client anywhere in the product, even though Messages is a top-level nav item and SMS sending is configured elsewhere in Settings.

**What to build/fix:**  The Messages page’s empty state instructs users to ‘send a first message from a client’s detail page,’ but no client detail tab (Overview, Service, or Billing) has a message composer or ‘Send message’ entry point — confirmed by searching the full accessibility tree of a client detail page and finding nothing message-related. This means there is currently no way to start a new conversation with a client from the UI at all, even though SMS is configured in Settings > SMS and the Messages conversation list/thread view exists. Add a ‘Send message’ composer to the client detail page (Overview tab, near Reviews & referrals, is a natural spot) that creates a new conversation thread and sends the first SMS, consistent with the empty-state copy on the Messages page. Verify by sending a first message from a client with no prior conversation and confirming it appears both on the client page and in the main Messages list.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Messages currently has no way to originate a thread — this requires real conversation/thread-initiation logic, not a UI tweak.

---

### #12 — CSV client import silently drops property/service-address data

**Status:** ✅ Shipped (July 10, 2026). Added street/city/region/postal_code/gate_code as mappable targets on the **Clients** import, merged service-address column aliases (address, service address, state, zip, etc.) into every source preset so they auto-map from real Sweep&Go/Jobber/Housecall exports, and the commit path now creates an auto-geocoded property for each imported client that carries an address (non-fatal if geocoding misses — the client still imports). The dry-run preview gained a "Service address" column so mapping mistakes are catchable before commit. tsc green. (A separate `properties` import entity already existed for linking addresses by client_external_id; this closes the far more common single-file Clients-with-address path.)

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Setup — Import  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Import page markets itself as a migration tool from Sweep&Go, Jobber, and Housecall Pro (“Migrate clients from Sweep&Go, Jobber, Housecall Pro, or any CSV”). Live-tested with a CSV containing name, email, phone, and address columns for two clients: the field-mapping step only offers display_name, account_type, primary_email, primary_phone, external_id, and notes as targets — there is no address/property field to map to. The dry-run preview and committed import both completed with “0 failed,” but the two resulting clients have 0 properties, 0 dogs, and 0 subscriptions. Since routing, zone pricing, geocoding, DNA compliance, and subscriptions all depend on a client having at least one property, every CSV-imported client currently needs its address (and everything downstream of it) re-entered by hand.

**What to build/fix:**  The CSV import flow (Setup > Import) for Clients has no field mapping for property/service address — the mapping step only exposes display_name, account_type, primary_email, primary_phone, external_id, and notes as targets. Verified end-to-end: importing a CSV with an address column produces clients with 0 properties/0 dogs/0 subscriptions, the address data is silently discarded, and neither the mapping screen nor the dry-run preview nor the commit summary (‘Committed. 2 created, 0 updated, 0 failed’) gives any indication that address data was dropped. Since almost every downstream feature (routing/dispatch, zone-based pricing, DNA compliance, subscriptions) requires a client to have a property, this significantly undercuts the import feature’s stated purpose of migrating clients off Sweep&Go/Jobber/Housecall Pro. Add street/city/state/postal (and ideally gate code, yard size) as mappable target fields for the Clients import, auto-geocode the resulting properties the same way the New Client wizard does, and surface property/address per row in the dry-run preview so users can catch mapping mistakes before committing.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained CSV-import mapping bug (property/service-address fields silently dropped).

---

### #13 — New Client wizard silently fails to geocode unrecognized addresses, and the address step has no validation at all

**Status:** ✅ Shipped (July 10, 2026). The Yard step's geocode now tracks an explicit status (loading / ok / not-found / error) instead of swallowing failures with an empty `catch {}`, and renders a clear amber message when the address can't be found or the geocoder is unreachable ("draw the service area manually on the map below") rather than silently showing a zoomed-out world map. On the Property step, State/Region is now required (both the input `required` attribute and the step's Next-gate), since it's needed downstream for routing, zone pricing, and geocoding. tsc green. (Full address-autocomplete on the Property step is noted as a further enhancement but not required to close the silent-failure bug.)

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** New client wizard — Property & Yard steps  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Yard step’s map centers correctly on the property when the address entered in the prior Property step geocodes successfully (verified with a real address, “600 Congress Ave, Austin, TX 78701” — map centered precisely on the building). But when the address doesn’t geocode (verified with a fictitious street, “789 QA Way, Austin, TX 78704”), the map silently falls back to a fully zoomed-out view of North America with no error, warning, or indication anything went wrong. Compounding this, the Property step itself has no address autocomplete or validation of any kind — plain text fields for Street/City/State/ZIP, and State/Region isn’t even required (a client was created and geocoded successfully with State left blank). A user can easily mistype a street address, get zero feedback, and land on a confusing, useless map with no idea why.

**What to build/fix:**  The New Client wizard’s Yard step (step 3) depends on the address entered in the Property step (step 2) geocoding successfully to center its map — when it does, this works well; when the address can’t be geocoded (e.g. a typo, or a street that doesn’t exist), the map silently falls back to a zoomed-out view of North America with zero feedback to the user. Add explicit handling: if geocoding the entered address fails, show a clear message on the Yard step (e.g. “We couldn’t find this address on the map — check the address on the previous step, or continue and set the map location manually”) instead of silently rendering an unhelpful world map. Separately, the Property step itself has no address validation or autocomplete: Street/City/State/ZIP are plain text inputs, State/Region isn’t required, and there’s no feedback if an address is malformed or doesn’t exist. Evaluate adding an address autocomplete/validation widget to the Property step (Google Places Autocomplete, or improving the existing geocoder) so bad addresses are caught before the user ever reaches the Yard step, and make State/Region required since it’s needed for the property to be usable downstream. Update (confirmed after a geocoding-provider change subsequent to this finding, so this no longer needs to be inferred from the map tiles): geocoding was running through Google at the time this was first found, and has since been switched to Nominatim/OpenStreetMap directly, with a proper User-Agent header and real error logging replacing the previous silent-null behavior. This makes the user-facing message above more straightforward to build correctly — surface the actual error/empty-result Nominatim already returns and logs, rather than inferring failure purely from “map still zoomed out.” Given how much of the product (routing, zone pricing, DNA compliance, and the per-acre pricing bug above) depends on getting coordinates and boundaries right, and Nominatim's public instance is rate-limited (~1 req/sec, not meant for bulk use — see #9), keep an eye on address-matching quality at scale and revisit the provider choice if it becomes a real bottleneck.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained validation/error-surfacing fix on the New Client wizard's address step.

---

### #14 — Client concerns submitted through the portal have no owner-facing inbox — they surface only as a dashboard banner that links to an empty, unrelated page

**Status:** ✅ Shipped (July 10, 2026). Concerns are stored in `qc_tickets` (which already had status/resolved_at/resolved_by/resolution_note columns). Built the missing owner-facing inbox: a new **Concerns** nav item + `/concerns` route with a real triage workflow — filter by Received / In progress / Resolved, each concern shows category, full message, submitting client + contact info and submission date, with "Mark in progress" / "Mark resolved" (with an optional resolution note) and Reopen. Server functions `listConcerns` / `updateConcernStatus` gated on `view_client_directory`. Fixed the dashboard banner to link to `/concerns` instead of the unrelated `/messages` SMS inbox. Added a best-effort office **email notification** on concern submission (to the org's contact email via Resend, logged to `email_send_log`) so a safety issue like a gate-left-open doesn't depend on someone happening to check the dashboard. tsc + tests green. (Email requires `RESEND_API_KEY` + an org contact email; the inbox + banner work regardless.)

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Client portal — Requests / Dashboard  
**Model to use:** Claude Fable 5  

**What we found:**  Live-tested: submitted a “Report a concern” request from the client portal (“QA test: gate was left open after last visit.”, category “Other”). It was accepted and shown back to the client under “Your requests” with status “Received.” On the Owner side this produced a small dashboard banner reading “1 client concern to review.” Clicking that banner navigates to /messages — but Messages (a separate SMS-conversation inbox, see the related Messages finding above) shows “No messages yet”; the concern isn’t there. It also doesn’t appear on the client’s Overview, Service, or Billing tabs, and the app’s global search returns “No results” for its content. As far as could be determined, the dashboard banner is the only place this concern exists in the product — there is no list, inbox, or detail view to open the full message, mark it resolved, or reply. For a category like “gate was left open,” this is a real safety/liability signal that could go permanently unseen once the banner is dismissed.

**What to build/fix:**  Client-submitted portal concerns (the “Report a concern” form on /portal/{id}/requests) are accepted and stored, but there is no owner-facing place to view, triage, or resolve them — the only surface is a dashboard banner (“N client concern(s) to review”) that links to /messages, an unrelated, currently-empty SMS inbox with no connection to portal concerns at all. Build a real “Concerns” or “Requests” inbox (a new nav item, or a section inside Messages) listing every submitted concern with its category, full text, submitting client, submission date, and a status workflow (Received → In progress → Resolved) plus the ability to reply to the client. Fix the dashboard banner to link directly to this inbox (or the specific concern) instead of /messages. Audit whether an email or SMS notification currently fires to the office when a concern is submitted — if not, add one, since a banner on a dashboard only staff proactively check is not reliable enough for something that could be a safety issue like an open gate.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Building a real Owner-facing concerns inbox (not just a dashboard mention) is a new feature with its own data model and UI.

---

### #15 — Weather forecasts never load for any zone — and this is a feature the public marketing site explicitly promises works today

**Status:** 🔶 Root-caused and fixed in code (July 10, 2026); live confirmation blocked from this session. The provider is Open-Meteo (keyless, so no missing-API-key issue). The bug: the fetch requested Open-Meteo's **deprecated** daily variable names `weathercode` and `windspeed_10m_max`, which the current API rejects with HTTP 400 — and the error was swallowed into a silent empty forecast, shown identically for every zone as "No forecast available." Fixed the request + response parsing to the current names (`weather_code`, `wind_speed_10m_max`) in both `weather.functions.ts` and `weather-day.functions.ts`, and replaced the error-swallowing catch with an explicit per-zone status (`ok` / `no_coords` / `error`) so the Weather page now distinguishes "weather service error" from "no risky days" and from "zone has no coordinates." Added a test asserting the modern variable names are used and that a 400 surfaces as an error rather than a silent empty. NOT confirmed live: this session's egress policy blocks `api.open-meteo.com` (proxy 403), so the actual forecast render couldn't be driven here — Brendan (or a session with open egress) should load the Weather page and confirm real forecasts appear. tsc + 56 tests green.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Weather  
**Model to use:** Claude Fable 5  

**What we found:**  The Weather page shows “No forecast available” for all four zones despite each having valid Austin, TX coordinates on file, and clicking “Refresh” does not change this. “Preview auto-rebalance” correctly reports “No risky visits to rebalance” — but only because there’s no forecast data to ever evaluate. The feature this page is named for (flagging risky-weather days so visits can be bulk-rescheduled before they blow up in the field, per the page’s own description) is currently non-functional. This was re-checked against houndstack.com's public marketing copy as part of a cross-reference pass: the homepage lists “weather aware rescheduling” under Scheduling and routes, and the Integrations page states outright that “weather data for automatic rescheduling... [is] built into the product itself rather than configured as integrations,” i.e. explicitly telling prospective customers this already works, not that it's planned. Raising this from Medium to High given it's not just an internal bug but a specific, checkable capability being actively marketed as live.

**What to build/fix:**  The Weather page (per-zone forecast) shows ‘No forecast available’ for every zone regardless of date range, even though each zone has valid lat/lng coordinates (e.g. Central Austin at 30.250, -97.750). Clicking ‘Refresh’ does not populate any forecast. Investigate the weather-forecast fetch: check whether the external weather API call is failing (missing/invalid API key, wrong endpoint, rate limit, or a client-side error being swallowed), and surface an explicit error state distinct from ‘no data’ if the fetch itself is failing. This also blocks ‘Preview auto-rebalance’ from ever having anything to act on, since it depends on forecast data existing first. Add a test that mocks the weather API and confirms zone cards render real forecast data end to end. Decision (July 8, 2026): fix the feature rather than soften the marketing claim, since houndstack.com already states this capability is live (“built into the product itself”) and this is very likely a smaller lift than it looks — probably a broken/misconfigured weather API integration, not a missing feature. Treat this as urgent and prioritize it ahead of most Medium/Low findings.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Decision (July 8, 2026): build real weather-forecast functionality rather than soften the marketing claim — this is a genuine integration build (weather provider + zone mapping), not a bug fix.

---

### #16 — houndstack.com repeatedly and specifically markets "automatic royalty billing" for franchises as a live feature — the actual Franchise page has no royalty billing of any kind

**Status:** ✅ Shipped (July 10, 2026) — built the marketed capability (decision follows the same "build, don't soften the claim" line recorded for #15/#16). Data model (migration applied live via Supabase MCP): a per-child `organizations.franchise_royalty_percent` rate and a `franchise_royalty_invoices` table (parent/child, period, revenue, rate, amount, status; unique per child+period; RLS scoped so only the parent org's writers can see/manage its franchise's royalty invoices). Server functions (`franchise.functions.ts`, all gated on `manage_franchise`): `setChildRoyaltyRate`, `getFranchiseRoyaltySettings`, `generateRoyaltyInvoices` (royalty = each child's collected revenue in the period × its rate; idempotent upsert per child+period; defaults to last full calendar month), `listRoyaltyInvoices`, `setRoyaltyInvoiceStatus` (draft→issued→paid/void). UI: a new "Royalty billing" section on the Franchise page — per-location rate inputs, a "Generate last month's royalties" button, and a table of generated royalty invoices with issue/mark-paid actions. **Automatic** generation is wired into the nightly cron: on the 1st of each month it generates last month's royalty invoices for every franchise parent's children (service-role, idempotent). tsc + tests green. NOT driven end-to-end live (the demo tenant has no parent/child franchise relationship to exercise it against) — recommend a live check once a real franchise parent + child exist.

**Severity:** High  
**Role(s) affected:** Owner  
**Area:** Franchise — Marketing vs. product  
**Model to use:** Claude Fable 5  

**What we found:**  As part of a cross-reference pass against the public marketing site, every mention of the Franchise feature on houndstack.com specifically calls out automatic royalty billing as a real, working capability: the homepage ("Franchise rollup: ...automatic royalty billing and a franchisor dashboard across every location"), the Features page ("Franchise: Multi location rollup, automatic royalty billing, and a franchisor dashboard"), and the Pricing page, which lists "Franchise Management and Regional Dashboards: Parent and child organizations, automatic royalty billing, and rollup reporting" as "Included with Enterprise" under a section explicitly captioned "Everything listed here is live in the product today." The actual Franchise page in the product (Owner nav) contains none of this: it is a single card reading "This organization is not configured as a franchise parent yet" with one button, "Mark this org as a franchise parent," and a description of what enabling it would do (roll up child orgs' clients, revenue, and open AR). There is no royalty percentage field, no royalty invoice generation, no franchisor dashboard beyond the rollup itself, and nothing resembling billing of any kind. This is a materially different and much smaller feature than what three separate marketing pages describe as already live — a franchise prospect evaluating the product on the strength of "automatic royalty billing" would not find it.

**What to build/fix:**  houndstack.com's homepage, /features, and /pricing pages all describe "automatic royalty billing" as a current, live franchise capability (the /pricing page explicitly labels its add-ons section "Everything listed here is live in the product today"). The actual Franchise page (Owner nav, /franchise) only offers a parent/child organization rollup toggle for clients/revenue/AR visibility — there is no royalty percentage configuration, no royalty invoice/charge generation, and no billing logic of any kind. Decision (July 8, 2026): build the missing royalty billing functionality — a royalty rate per child org, computed against rolled-up revenue, generating a real invoice or ledger entry on a schedule — rather than softening the marketing claim, since the existing marketing promise to franchise prospects is being kept as-is. This is a real engineering lift (comparable in scope to the pricing/signup work in Appendix A) and should be scoped and sequenced accordingly, not treated as a quick fix; until it ships, franchise prospects evaluating the product on this specific claim should be flagged to sales.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Decision (July 8, 2026): build real franchise royalty billing (rate configuration, computation against rolled-up revenue, invoice/ledger generation on a schedule) — comparable in scope to the pricing/signup redesign.

---

### #18 — Clearing the My day date field triggers a false “not linked to a staff record” error instead of proper date validation

**Status:** ✅ Shipped (July 10, 2026). The My day date input's onChange now falls back to today's date when the field is cleared or holds an unparseable value, instead of passing an empty string downstream — which had rendered the exact same "Your user is not linked to a staff record yet. Ask an owner to add you." screen as a genuinely unlinked account. Re-entering a date already worked; now the empty-input state can't reach that alarming message at all, and it's reserved for a real missing staff record. tsc green.

**Severity:** High  
**Role(s) affected:** Technician  
**Area:** My day — Date navigation  
**Model to use:** Claude Opus 4.8  

**What we found:**  The date field on My day is a standard browser date input. If it is cleared — an entirely ordinary interaction (selecting the field and pressing Backspace/Delete, or leaving a partially-typed date incomplete so it blurs empty) — the page does not show a “select a date” prompt or similar validation message. Instead it renders: “Not on any staff record” as the page subtitle, and “Your user is not linked to a staff record yet. Ask an owner to add you.” as the body message — the exact same message the app would show if the technician's account genuinely had no staff record linked at all. This was first hit by accident while testing date navigation (typing a new date in a way that momentarily left the field empty) and was then confirmed reproducible by deliberately clearing the field. Re-entering any valid date immediately restores normal behavior, confirming the account link itself was never actually broken — the error is purely a mislabeled empty-input state. For a technician in the field, seeing “ask an owner to add you” would reasonably be read as “my account is broken, I can't see my visits,” which is a much more alarming and confusing message than the actual, trivial cause.

**What to build/fix:**  On My day, clearing the date input (input[type=date]) — reachable via normal keyboard editing, not just an edge case — causes the page to render “Not on any staff record / Your user is not linked to a staff record yet. Ask an owner to add you,” which is the same message shown for a genuinely unlinked account. Re-entering a valid date fixes it immediately, confirming the staff-record link was never actually the problem. Fix the empty/invalid-date case to be handled distinctly from the no-staff-record case: if the date value is empty or unparseable, default back to today's date (the simplest fix, avoiding an error state entirely) or show a neutral “Select a date to see your visits” prompt. Reserve the “not linked to a staff record” message for when that is actually true, since as written it will send a technician chasing a nonexistent account problem.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained validation-order bug on the My day date field.

---

## Medium Findings

### #19 — Raw internal implementation details — roadmap notes, database identifiers, and backend env-var/secret names — leak into user-facing copy across the Owner and Platform Admin consoles

**Status:** ✅ Shipped (July 10, 2026). Added a shared humanize layer (`src/lib/humanize.ts`, `humanizeRole`/`humanizeEnum`) modeled on the tenant Settings → Users & roles labels, and routed the leaking surfaces through it: the Platform Users directory and the tenant Users tab now render role badges as "Office manager" instead of the raw `office_manager` enum. Removed the internal-identifier leaks: the tenant Feature Flags empty state no longer names the `platform_feature_flags` table, the tenant Billing tab's "comes online in step 6" roadmap note is replaced with real product copy, and the Settings → Accounting connect copy no longer lists `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET`/`XERO_*`/"project secrets" (it now describes the OAuth flow in plain language). The Plans-catalog "step N" note was already removed in the #6 rebuild. tsc green. FOLLOW-UP (July 10, 2026, verification pass): the earlier fix updated the Settings→Accounting *connect copy* but the QuickBooks/Xero OAuth **callback pages** still rendered `QBO_CLIENT_ID / QBO_CLIENT_SECRET`/`XERO_*` names in the browser error body — now replaced with generic "isn't finished being set up — contact support" copy (detail goes to server logs). Also the read-only role **badge** on Settings→Users (not just the platform surfaces) now runs through `humanizeRole`.

**Severity:** Medium  
**Role(s) affected:** Owner, Platform Admin  
**Area:** UI copy — Internal implementation leakage  
**Model to use:** Claude Opus 4.8  

**What we found:**  Five separate instances of the same pattern were confirmed across two different roles' passes. In the Owner-role console, Settings tabs for SMS, the AI receptionist, Franchise, and Accounting show internal implementation details — secret names and database column names — directly in Owner-facing copy. The Accounting tab (Settings > Accounting, "Accounting sync") is the newest confirmed instance: it tells the Owner the integration "requires QBO_CLIENT_ID/QBO_CLIENT_SECRET or XERO_CLIENT_ID/XERO_CLIENT_SECRET configured as project secrets" — raw backend environment-variable names presented to a non-technical business owner as if they were something the Owner is meant to act on. In the Platform Admin console: the tenant Billing tab and the Plans catalog display raw internal engineering roadmap notes (literal "step N" text) as if they were finished product copy; the tenant detail Feature Flags tab's empty state discloses the raw backend table name (platform_feature_flags) directly to platform admins; and the platform-wide Users directory and each tenant's own Users tab render role badges using the raw, unformatted snake_case enum value (e.g. "office_manager") instead of a human-readable label — inconsistent with how the tenant-facing Settings > Users & roles page correctly formats the same underlying role data. The common root cause across both consoles: admin-facing copy and labels are pulling directly from internal engineering artifacts — code comments, raw database identifiers, unformatted enum values — instead of passing through a proper user-facing content/formatting layer.

**What to build/fix:**  Add a shared "humanize" formatting layer that every admin-facing surface (both the Owner console and the Platform Admin console) routes backend values through before displaying them to a human — the tenant-facing Settings > Users & roles page already does this correctly for role labels and can serve as the reference implementation. Specific fixes: remove roadmap/step-N notes from the tenant Billing tab and Plans catalog and replace with real product copy or hide the section until it ships; change the Feature Flags empty state to a generic, non-technical message that doesn't name the underlying table; apply the existing role-label formatter to the Platform Admin console's Users directory and tenant Users tab so multi-word roles render correctly everywhere; rewrite the Accounting tab's QuickBooks/Xero connection copy to describe the integration in plain language (e.g. "Connect your QuickBooks account" with a button that starts the OAuth flow) with no mention of QBO_CLIENT_ID/QBO_CLIENT_SECRET/XERO_CLIENT_ID/XERO_CLIENT_SECRET or the words "project secrets" — those are configuration values for whoever administers the HoundStack backend, not something an Owner can or should act on; and audit the remaining Owner Settings tabs (and any others not yet reviewed) for the same secret-name/DB-column/env-var leakage pattern.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Building the shared "humanize" formatting layer is contained, reusable utility work, even though it touches several surfaces — the tenant Settings > Users & roles page already has the reference implementation to extend from.

---

### #21 — Property edit fields are blank even though the property has a saved address

**Status:** ✅ Shipped (July 10, 2026) — done together with #8, same root cause (add-form defaults shown as if they were an edit form). Added an `updateProperty` server function (re-geocodes on save, but only overwrites lat/lng when geocoding actually resolves so a transient miss can't blank a good pin) and a per-property "Edit" control that hydrates Street/City/Postal/Gate/Yard/hazard fields from the saved record; the form header and submit button reflect edit vs. add mode, with an "Add a new property instead" escape. tsc + tests green.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Client detail — Service tab → Properties  
**Model to use:** Claude Opus 4.8  

**What we found:**  On the same Service tab as the subscription bug above, the Properties section header displays a full saved address (“4102 Menchaca Rd, Austin 78704”), but the Street / City / Postal input fields immediately below it are empty. This is the same root-cause pattern: the edit form isn’t hydrated from the fetched record.

**What to build/fix:**  On a client’s Service tab, the Properties section shows the saved address in a header line (e.g. ‘4102 Menchaca Rd, Austin 78704’) but leaves the Street/City/Postal/Gate code/Yard size edit fields blank on load, even though the property has this data saved. Find the property edit form component and ensure all fields are populated from the existing property record when the page loads, rather than defaulting to empty — likely the same underlying cause as the subscription-form binding bug above (form defaults not hydrated from fetched data). Fix both together if they share a form-initialization pattern, and add a test covering property + subscription form hydration for clients with existing data.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained data-loading bug (property edit fields blank despite saved data).

---

### #22 — Clients list “Balance” column shows credit only, hides amounts owed

**Status:** ✅ Shipped (July 10, 2026). Two parts: (a) the owed amount was always $0 because the underlying query used non-existent invoice columns — fixed under #7, so real outstanding balances now populate; (b) the list showed owed OR credit and hid one when both existed, unlabeled. The Balance cell now shows both a red "$X owed" and a green "+$Y credit" line, each clearly labeled, so a client with $135 owed and $20 credit displays both at a glance. tsc + tests green.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Clients — list  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Balance column on the Clients list only reflects prepaid credit, with no labeling to clarify this. A client can show “+$20.00” in this column while simultaneously owing $135.00 on an open invoice (confirmed on Kevin O’Brien), and the list gives no visual indication of the amount owed. For a billing-heavy ERP, this is exactly the information office staff need to see at a glance.

**What to build/fix:**  The Clients list ‘Balance’ column currently shows only prepaid credit balance (e.g. ‘+$20.00’) with no label distinguishing it from an amount owed, and no indication when that same client has an open invoice balance (e.g. a client can show +$20.00 credit while owing $135 on an open invoice, invisible from the list). Add a clear, unambiguous balance treatment to the Clients list — either split into two columns (Credit / Owed) or a single net-balance figure with color coding (e.g. green for credit, red for owed) and a tooltip or label clarifying which is which. This is a high-value, low-effort fix for reducing office manager clicks, consistent with the product’s goals.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained financial-display bug (Balance column hides amounts owed) — correctness-critical, low complexity.

---

### #23 — Billing plan limit contradicts its own displayed description, and the Dashboard’s plan label reads as broken

**Status:** ✅ Shipped (July 10, 2026). Reconciled the billing display with the per-employee model from #6 (customers are unlimited on every plan, so there is no client cap to contradict). In `billing-state.server.ts`: recognize the `trialing` status, and drop the client-count-based `overBandLimit`/`needsUpgrade` (both now always false — the "16 clients above the limit of 3" contradiction is gone at the source). On Settings → Billing: the plan card now reads "$/mo · Unlimited customers" instead of a client band, the "Active clients N / 3" enforced-limit display is removed, and a free-trial notice/CTA replaces the old "first 3 clients are on us" free-plan copy. On the Dashboard: the bare "Fetch plan" KPI subtitle now reads "On the Fetch plan" so it no longer looks like a broken/truncated action. Pricing itself was intentionally not re-touched here (that was #6). tsc + tests green.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Billing / Dashboard  
**Model to use:** Claude Opus 4.8  

**What we found:**  Settings > Billing shows the current plan as “Fetch — $59/mo, covers 4–25 clients” directly above a KPI reading “Active clients 16 / 3” and a red banner: “You have 16 active clients — above the current plan limit. Upgrade to keep adding.” The advertised range (4–25) and the enforced limit implied by “16 / 3” disagree — 16 is within 4–25, yet the tenant is told it’s over a limit of 3. Separately, this is also the source of an earlier-flagged oddity: the Dashboard’s Active Clients KPI card has a subtitle reading “Fetch plan” (the literal SaaS plan name) with no visual distinction from a link — sitting under a client count, it reads more like a broken or truncated action than an informational label.

**What to build/fix:**  Two related billing-plan issues to fix together. (1) On Settings > Billing, the plan card states ‘Fetch — $59/mo · Covers 4–25 clients,’ but the same page shows ‘Active clients 16 / 3’ and a warning that 16 clients is ‘above the current plan limit’ — implying the actually-enforced limit is 3, not 25. Find where the plan’s client-limit is read for the warning banner/counter versus where the ‘4–25 clients’ description text comes from, and reconcile them — one is very likely reading a stale or wrong field. (2) On the main Dashboard, the Active Clients KPI card shows a subtitle ‘Fetch plan’ (the SaaS plan name) with no visual treatment marking it as a label rather than an action — reword to something unambiguous like ‘On the Fetch plan’ or move plan status out of this card entirely, since a bare two-word subtitle under a client count currently reads as a broken/truncated call-to-action. Note: pricing itself is a known work-in-progress area, so please focus this fix on the internal consistency/copy bug rather than finalizing plan pricing.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained internal-consistency/copy bug between the plan-limit banner and its own description text — explicitly scoped to avoid touching pricing itself.

---

### #25 — No way to embed or customize the public lead-capture form

**Status:** ✅ Shipped (July 10, 2026). Leads had no `organization_id` (single-tenant assumption), so a per-tenant form was impossible; added it (migration applied live) with a backfill and RLS re-scoped so managers only see their own org's leads. New public embeddable form: a hosted `/lead/{slug}` page (branded quote-request form, no auth) that posts to the now-slug-scoped `/api/public/leads` endpoint, which routes the lead to the right business and tags it `source=website`. A new Settings → Lead form page gives the Owner the hosted link, a copy-paste `<iframe>` embed snippet, a preview, and basic analytics (all-time + last-30-day website submissions), plus a warning when public intake is off. `listLeads`/lead visibility is now org-scoped. This is a functional v1 of the finding's embed + hosted link + analytics asks; deeper per-form field/branding customization beyond the org's existing branding is a further enhancement. tsc + tests green. VERIFICATION PASS (July 10, 2026): confirmed the one remaining gap is exactly this — the hosted form uses a fixed field set and applies no per-tenant logo/brand-color/confirmation-message config (`getLeadFormConfig` returns only slug/name/enabled/counts). Deferred as a scoped follow-up, not started this pass.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Leads / Settings  
**Model to use:** Claude Fable 5  

**What we found:**  Leads can apparently arrive with source “website” (per the Leads list’s source field), implying a public-facing lead form exists somewhere, but there is no Settings page anywhere that surfaces an embed snippet, a hosted form link, or any customization (fields shown, branding, colors, confirmation message) for it — checked Settings in full and found nothing. This is distinct from the platform’s own marketing/registration pages. As it stands there is no way for an Owner to actually get this lead form onto their own business website, which undercuts the value of having a source=website field at all.

**What to build/fix:**  There is no Settings page for managing a public, embeddable lead-capture form — despite the Leads list supporting a ‘website’ source, nothing in Settings provides an embed snippet (iframe/script tag), a shareable hosted-form URL, or customization options (which fields to collect, logo/colors, confirmation message, notification email). Add a Settings > Lead form (or similar) page that: generates a unique embeddable form (iframe embed code + a standalone hosted link) per tenant, lets the Owner choose which fields to collect and customize branding/confirmation copy, and shows basic analytics (views/submissions) for the form. This is core lead-gen infrastructure for a service business and currently has no in-app path at all.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Lead-form embed/customization is a new capability (generating embeddable, configurable form code), not a fix to existing code.

---

### #26 — No way to mark a user as ineligible for routes/dispatch — every role appears as an assignable technician column

**Status:** ✅ Shipped (July 10, 2026). Added two staff flags (migration applied live): `is_field_tech` (does fieldwork / can be routed — backfilled so only `tech`-role staff default to true, excluding Owner/Office manager/Dispatcher) and `routing_available` (a temporary on/off for leave etc. without deleting the account). The Routes board now only shows columns for staff who are field techs AND currently available — except it still shows a column for anyone who already has visits assigned that day, so existing assignments to a now-unavailable tech stay visible. Both flags are settable per staff in Settings → Users & roles (`setStaffRouting`, gated on `manage_users`). This directly prevents the kind of mis-assignment behind #10 (non-field roles and unavailable techs are no longer selectable). tsc green.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Routes / Dispatch — Settings & Users  
**Model to use:** Claude Opus 4.8  

**What we found:**  The Routes board’s per-technician columns are driven directly off the Users & roles list rather than an actual ‘is a field technician’ flag: Owner, Office manager, and Dispatcher accounts all appear as assignable columns alongside the one real Technician account, and visits can be dropped/auto-assigned onto them. There is no toggle anywhere in Settings > Users & roles (or on the Routes page itself) to exclude a non-field user from being a valid route assignee, or to temporarily deactivate a technician (e.g. on leave) without removing their account entirely.

**What to build/fix:**  The Routes/Dispatch board treats every user account as a potential route assignee — Owner, Office manager, and Dispatcher roles all show up as assignable technician columns, not just accounts actually doing fieldwork. Add an explicit ‘Is a field technician’ (or ‘Available for routing’) flag on the user record, settable in Settings > Users & roles, and filter the Routes board’s assignable columns to only users with this flag on. Also add a lightweight ‘temporarily unavailable’ toggle (distinct from full deactivation) so an Owner/Dispatcher can pull a technician out of routing for a day/week (vacation, injury, etc.) without deleting their account or reassigning their historical visit history. This directly prevents dispatch mistakes like the 1,854 km mis-assignment documented above, since non-field roles and unavailable techs would no longer be selectable at all.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Add a route/dispatch-eligibility flag to the user/staff model and filter existing assignment UI by it — moderately contained.

---

### #27 — No automatic way to split an overloaded technician’s route

**Status:** ✅ Shipped (July 10, 2026). Added capacity-aware balancing: `balanceOverloadedRoutes` computes each field tech's day load (drive `travel_min` + property service duration) against a working-day capacity (workday_end − workday_start), flags techs over capacity, and greedily peels their trailing stops onto the least-loaded available tech with room (or leaves them Unassigned when no one has capacity — surfaced as a warning to add a tech or move visits to another day). A "Balance overloaded routes" action in the Routes planning tools applies the moves; the dispatcher then Re-optimizes to tidy sequences. This is a solid v1 of the finding's (1) capacity threshold, (2) overload detection, (3) auto-split — it respects the #26 routing-eligibility flags and only moves within available field techs. tsc + tests green. VERIFICATION PASS (July 10, 2026): confirmed two deliberate v1 limits remain — the capacity threshold is org-wide (derived from workday hours), not a per-tech configurable value, and the auto-split does not re-sequence both routes automatically (the dispatcher clicks "Re-optimize" after). Both deferred as scoped follow-ups, not started this pass.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Routes / Dispatch — Optimize  
**Model to use:** Claude Fable 5  

**What we found:**  The only route-planning actions available are whole-day ‘Auto-assign / optimize day for tech’ and ‘Optimize’ — both operate on a single technician’s full day as one unit. If a day’s visit volume exceeds what one technician can reasonably complete, there is no detection of that (no warning, no overflow flag) and no action to automatically move the overflow onto a second technician or draft a second route. The only workaround is manually dragging/reassigning individual visits one at a time.

**What to build/fix:**  There is currently no capacity-aware route planning: ‘Auto-assign / optimize day for tech’ and ‘Optimize’ both operate on one technician’s day as a single unbounded unit, with no detection of an overloaded day (e.g. total drive+service time exceeding a working-day threshold) and no way to automatically split the overflow onto another technician or an unassigned second route. Add (1) a capacity threshold per technician (configurable, e.g. based on working hours in Settings > Users & roles) that the optimizer checks against, (2) a warning when a day’s assigned visits would exceed that capacity, and (3) an ‘auto-split’ action that moves the lowest-priority/most-overflow visits to another available technician or to Unassigned, re-optimizing both resulting routes. This is a meaningful dispatcher time-saver as client count grows past what manual drag-and-drop reassignment can handle.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Automatic route-splitting is new scheduling-algorithm work, not a bug fix.

---

### #28 — No week or month view for scheduled visits — Routes is locked to a single day

**Status:** ✅ Shipped (July 10, 2026). Added a "Week" view mode to the Routes page (alongside Split/Map/Board) backed by a new `getVisitRangeSummary` range query. It renders a 7-day (Week) or 28-day (Month) heat grid — each day shows its visit count, unassigned count, and a busier-is-darker shade so office staff can spot overloaded days, gaps, and upcoming volume at a glance; clicking a day opens that day's route board. tsc green.

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Routes / Dispatch  
**Model to use:** Claude Fable 5  

**What we found:**  The Routes page only ever shows one calendar day at a time, navigated via forward/back day arrows. There is no week view, no month view, and no calendar-style overview anywhere in the app for seeing upcoming visit volume, technician workload, or scheduling gaps across multiple days at once — a basic planning need for a recurring-service business (e.g. spotting an overloaded Friday, or seeing which week a client’s next visit falls in without opening their profile).

**What to build/fix:**  Routes/Dispatch currently only supports a single-day view, with no week or month calendar available anywhere in the app for visualizing scheduled visits across multiple days. Add a week view (e.g. 7 columns, one per technician-day or one per day with technician sub-rows) and ideally a month view (density/heatmap style, visit count per day) to the Routes page, so office staff and dispatchers can spot overloaded days, scheduling gaps, or upcoming volume trends without stepping through single days one at a time. This is a standard capability in comparable field-service platforms (Jobber, Housecall Pro) and is currently a notable gap for planning and staffing decisions.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Week/month views for Routes require new date-range queries and new UI views beyond the current single-day model — a genuine feature build.

---

### #29 — Client portal doesn’t distinguish between a client’s multiple properties

**Status:** ✅ Shipped (July 11, 2026). The core complaint — a 2+ property client saw one undifferentiated view with no address labels — was addressed first (Property tab lists distinct serviced addresses via `portalListProperties`; Home "Next visit", Upcoming visits, and plan rows already label their property). The previously-deferred remainder is now done: the add-on purchase flow is property-scoped. Migration `20260711010000_addon-property-scope.sql` (applied live + verified) adds a nullable `property_id` to `addon_subscriptions` and `addon_charges`, and recreates `portal_subscribe_addon` (new optional `_property_id`, validated to belong to the calling client) and `portal_list_client_addons` (now returns `property_label`). In the portal, `AddonCard` shows a property picker when the client has 2+ properties and passes the chosen property through; active add-on rows display which property they cover. Single-property clients see no selector and existing rows stay account-level (NULL) — behavior unchanged. tsc + 85 tests green. Billing-tab per-property invoice labeling was intentionally left out of scope (invoices aggregate across a property's visits/add-ons; the finding's "at minimum" bar — Next-visit card + add-on flow — is met). Remaining: a live QA click-through of a multi-property add-on purchase (can't create real production charges from this session).

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Client portal — Property  
**Model to use:** Claude Opus 4.8  

**What we found:**  Live-tested by adding a second property (456 Second St, Austin 78701) to an existing client (previously one property at 789 QA Way) via the Service tab’s “Add property” control, then reopening that client’s portal link. The portal’s Property tab still renders a single, undifferentiated view — the dogs-on-file list and the “Add-ons & extras” purchase list show no property selector and no address labels, so there is no way to tell which property an add-on (e.g. “Haul-away”) will apply to; clicking “Add” simply confirmed “Added to your next visit” with no property disambiguation. The portal’s Home and Visits tabs are similarly single-property: “Next visit” shows one date/time with no property context. For HOA, property-management, or any client with more than one serviced address, the portal currently can’t represent their account correctly, and add-on purchases in particular could silently apply to the wrong property or visit.

**What to build/fix:**  When a client has more than one property, the client portal (Home, Visits, Property, and Billing tabs) needs a property selector or clearly labeled per-property sections — currently a 2+ property client sees one undifferentiated view with no address labels anywhere, so they can’t tell which property a visit, add-on, or invoice line applies to. At minimum, label the “Next visit” card and the “Add-ons & extras” purchase flow with the specific property address, and let the client choose which property they’re viewing/acting on if they have more than one. This matters for HOA and commercial multi-site clients, which the app’s own client-type field (residential/commercial) suggests it needs to support well.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained data-association fix so the client portal can distinguish between a client's multiple properties.

---

### #31 — Accounting sync accepts raw OAuth access/refresh tokens pasted into unmasked plain-text fields, and is reachable by Office Manager

**Status:** ✅ Shipped (July 10, 2026). The redundant manual OAuth-credential form (Realm/Tenant ID, Access token, Refresh token) is now tucked behind an "Advanced: enter connection details manually" disclosure labeled support-only, and the Access/Refresh token fields are masked `type=password` inputs instead of plain visible textareas — the normal path is the existing "Connect QuickBooks/Xero" OAuth buttons. tsc green. FOLLOW-UP (July 10, 2026, verification pass): the earlier fix only masked the UI fields — the **server functions** (`upsertAccountingConnection`, `syncInvoice`, `syncAllPaidInvoices`, `disconnectAccounting`, and the two reads) were gated on bare org membership, so a dispatcher/tech could still read/post/sync/disconnect the tenant's real QuickBooks/Xero connection at the API level. All accounting server functions now require `manage_settings` (owner/office_manager), and disconnect is scoped by `org_id`. This resolves the "reachable by non-privileged roles" half of the finding.

**Severity:** Medium  
**Role(s) affected:** Office Manager  
**Area:** Settings — Accounting  
**Model to use:** Claude Opus 4.8  

**What we found:**  Settings > Accounting (“Accounting sync — push paid invoices to QuickBooks Online or Xero”) is fully accessible to Office Manager. It offers the expected “Connect QuickBooks Online” / “Connect Xero” OAuth buttons, but directly beneath them is an “Add / update connection” form with plain, unmasked text fields for Realm ID, Access token, and Refresh token, plus a Default income account field and an auto-sync checkbox — i.e. a second, manual path to configure the same integration by copy-pasting real OAuth credentials. Whether or not Office Manager should have access to this page at all (see the finding above), the manual-paste fields are a security anti-pattern on their own: OAuth access/refresh tokens grant real access to the tenant’s actual accounting/financial system and should never need to be hand-typed or pasted in cleartext once a proper OAuth “Connect” flow already exists on the same page.

**What to build/fix:**  Settings > Accounting has both a proper OAuth “Connect QuickBooks Online / Connect Xero” flow and a redundant manual form for pasting a Realm ID, Access token, and Refresh token in plain, unmasked text inputs. Remove the manual token-paste fields (or move them behind a clearly-labeled “advanced/developer” affordance that isn’t part of the normal setup flow) since the OAuth Connect buttons already cover the intended use case more safely. If a manual-entry path must stay for support/debugging, mask the token fields like password inputs, and log/audit whenever a token is entered or changed. Separately, revisit whether this page should be Owner-only given it grants access to the tenant’s real external financial system, similar in sensitivity to the already Owner-gated Billing and Franchise pages.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Security-sensitive but contained: mask the OAuth token paste fields and validate input — a scoped fix, not a redesign.

---

### #32 — “Email invoice to client” gives zero feedback — no success, no error, no visible state change

**Status:** ✅ Shipped (July 10, 2026). The button already had a loading state and toasts, but it reported success on *enqueue* — the send actually happens on a ~1-minute cron, so "emailed" could be a lie. `sendInvoiceEmail` now returns the `email_send_log` message id + recipient, a new `getEmailSendStatus` reads that row, and the invoice UI polls it: it shows a "Sending…" loader, then upgrades to "Emailed to {recipient}" once the log row reaches `sent`, or surfaces an explicit error on `failed`/`bounced`/`dlq`, or falls back to "queued — check back shortly" if it's still pending after the poll window. The path is the rebuilt Resend pipeline (logged in `email_send_log`), so the feedback now reflects the real outcome. tsc green.

**Severity:** Medium  
**Role(s) affected:** Office Manager  
**Area:** Invoices — Invoice detail  
**Model to use:** Claude Opus 4.8  

**What we found:**  On an open invoice’s detail page, three actions are offered: “Send / Pay via Stripe,” “Email invoice to client,” and “Void.” “Send / Pay via Stripe” works well and gives clear feedback — it opens a real Stripe Checkout session in a new tab and the button row updates to “Reopen checkout” / “Open existing checkout link,” confirming a link now exists. “Email invoice to client,” tested twice in a row on the same invoice, produces no toast, no error, no loading state, and no change anywhere on the page — the invoice stays in the same “open” state with no indication of whether an email was queued, sent, or failed. Office staff sending a real invoice to a client would have no way to know whether it actually went out.

**What to build/fix:**  The “Email invoice to client” button on an invoice’s detail page produces no visible feedback of any kind when clicked — no success toast, no error, no loading indicator, no state change — unlike the adjacent “Send / Pay via Stripe” button on the same page, which clearly confirms success by opening a checkout session and updating its own label. Add the same standard of feedback here: on click, show a loading state, then either a success confirmation (e.g. “Emailed to jess.n@example.com” with a timestamp) or an explicit error if the send fails. Also consider recording each send attempt (with a status) somewhere visible on the invoice, similar to how “Reopen checkout” implies a Stripe link already exists — an “Emailed on [date]” note would give staff the same confidence the Stripe button already provides.

Update: this no longer depends on a Lovable-exclusive secret — the email send path was rebuilt to call Resend directly via RESEND_API_KEY (a normal secret Claude Code can hold and test against), with each attempt and its status recorded in email_send_log. Wire this action to that same path: on click, show a loading state, then either a success confirmation (pulling the recipient and timestamp from email_send_log once the send lands in `sent` status) or a clear error if Resend rejects or bounces it. Check whether this action calls the dispatcher directly or enqueues through the same process-email-queue cron job used elsewhere in the app — if it's the queue path, either poll for the resulting email_send_log row or switch this specific action to a synchronous send so the UI isn't stuck guessing for up to a minute.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. The email send path is now a normal, directly testable Resend integration, not a Lovable-exclusive boundary.

---

### #34 — “Text reminder” and “Text "on my way"” fail with a message pointing to a Settings tab (SMS) that doesn't exist anywhere in the app for any role tested

**Status:** ✅ Resolved / verified (July 10, 2026) — no code change needed. The Settings → SMS page (`/settings/sms`, sender-number configuration via `updateOrgSmsFromNumber`) already exists and is linked from the Settings nav, so the "Add one in Settings → SMS" error the My-day Text buttons show is now followable by an Owner/Office Manager. This was built since the finding was filed; confirmed the page and nav link are present and the save path is wired. (The buttons correctly remain gated on a sender number being configured.) FOLLOW-UP (July 10, 2026, verification pass): the sender-number setter (`updateOrgSmsFromNumber`) was gated only on org membership; now requires `manage_settings` (owner/office_manager) so a dispatcher/tech can't change the org's SMS sender number.

**Severity:** Medium  
**Role(s) affected:** Technician  
**Area:** My day — Client communication  
**Model to use:** Claude Opus 4.8  

**What we found:**  Both “Text reminder” and “Text "on my way"” on My day immediately fail with “Your organization has no SMS sender number set. Add one in Settings → SMS.” Technician's Settings has only one tab (Preferences), so this is unreachable for this role regardless — but more notably, no “SMS” settings tab was found anywhere across all four roles tested in this engagement (Owner's Settings covers Accounting, Users, Skip rules, Blackouts, and Client portal branding, with no SMS/messaging provider tab). This reads as an incomplete feature: two prominent, always-visible buttons on the technician's most-used page lead to a dead end referencing a configuration screen that may not exist in the product at all yet.

**What to build/fix:**  “Text reminder” and “Text "on my way"” on My day both fail with an error directing users to a “Settings → SMS” page that doesn't appear to exist for any role (Owner's Settings has no SMS/messaging-provider tab). Either build the missing Settings > SMS page (sender number / provider configuration, likely Twilio-backed, gated to Owner/Office Manager) so the error message's instructions are actually followable by someone with the right access, or, if SMS isn't ready to ship yet, hide these two buttons behind a feature flag until the prerequisite settings page exists, rather than shipping always-visible buttons that can only ever fail in the current build.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Fix or correctly wire the SMS settings/Twilio integration these buttons depend on — contained backend-integration fix, related to the secret-exposure pattern in #19.

---

### #35 — A completed visit's expanded detail shows a broken image icon instead of one of its two completion photos

**Status:** ✅ Shipped (July 10, 2026). `PhotoThumb` on My day now tracks a loading/ready/error state: if the signed-URL request fails or returns nothing (object missing / upload failed), or the `<img>` itself fails to load (`onError`), it renders a clear "Photo unavailable" placeholder with an explanatory tooltip instead of the browser's bare broken-image icon — so a technician or office manager can tell a genuine data problem from a rendering glitch. tsc green.

**Severity:** Medium  
**Role(s) affected:** Technician  
**Area:** My day — Visit detail  
**Model to use:** Claude Opus 4.8  

**What we found:**  Expanding a completed visit on My day (the chevron next to a “completed” badge) reveals a “BEFORE COMPLETION” photo section with two thumbnails. One of the two renders correctly (a real photo of the yard); the other renders as the browser's default broken-image icon with the alt text “Visit” visible next to it — a clearly broken image reference, not a loading state or an intentionally empty slot. For a business model that relies on before/after photo evidence to resolve billing and service disputes, a silently broken photo thumbnail is a real trust problem: a technician (or an office manager reviewing the same record later) has no way to tell, from this view, whether the photo was never captured, failed to upload, or exists but is failing to load.

**What to build/fix:**  On My day, expanding a completed visit's detail (chevron next to the “completed” badge) shows a “BEFORE COMPLETION” section where one of two photo thumbnails renders as a broken image icon with alt text “Visit” instead of the actual photo. Reproduce on the David Park visit in the demo tenant. Root-cause whether the underlying image URL/file is actually missing (upload failure) or just failing to render (broken URL construction, expired signed URL, wrong content-type) — these need different fixes. Regardless of cause, the UI itself should be more defensive: detect a failed image load and show a clear “Photo unavailable” placeholder with an explanation, rather than a bare broken-image icon that looks like a bug rather than a data problem the user might need to act on (e.g. by asking the technician to re-upload).

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Contained image-URL/storage bug (broken completion-photo thumbnail).

---

### #36 — Two client-portal self-serve permissions are configurable by the Owner but have no matching control anywhere in the client portal itself

**Status:** ✅ Shipped (July 10, 2026). Both Owner-configurable self-serve permissions now have real portal UI, shown only when the owner has enabled them (new `portalSelfServeOptions` returns the flags + the client's active subscription). "Vacation hold": a date-range "Request hold" control on the portal Account tab wired to the existing `portalRequestVacationHold` (reports how many visits were skipped). "Change plan frequency": a frequency selector wired to the existing `portalChangeFrequency`. So enabling either permission now surfaces a working control instead of silently doing nothing. tsc green. (Both backends already existed; this closes the toggle-without-UI gap.)

**Severity:** Medium  
**Role(s) affected:** Owner  
**Area:** Client portal — Self-serve permissions  
**Model to use:** Claude Opus 4.8  

**What we found:**  Two separate instances of the same pattern were found in the Owner-role pass, both in Settings > Client portal permissions. "Vacation hold" is a toggleable client permission, but there is no matching self-serve action anywhere in the portal — clients can only skip visits one at a time, not place an extended hold. "Allow clients to change plan frequency" is a toggleable permission with no corresponding control anywhere in the client portal's billing/account UI. In both cases, the Owner can enable a capability that the portal has no UI for at all, creating a false impression — for both the Owner configuring it and any client told about it — that the capability exists once switched on.

**What to build/fix:**  Either build the missing portal-side UI for each permission — a real "Request vacation hold" flow with a date range for the first, and a plan-frequency selector in the portal's Billing/Account section for the second — or, if these aren't fully implemented yet, remove them from the Owner-facing permissions list (or clearly mark them "Coming soon") so that enabling a permission never silently does nothing. Since these two were found opportunistically, audit the full self-serve permissions list in Settings > Client portal for any other permission with the same gap between "toggle exists" and "portal control exists."

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Add the two missing client-portal UI controls wired to Owner-configured settings that already exist on the backend — contained.

---

## Low Findings

### #38 — Destructive delete/void actions have no confirmation step, confirmed on multiple pages across two roles

**Status:** ✅ Shipped (July 10, 2026). Added one reusable confirmation-dialog component (`src/components/ConfirmButton.tsx`, built on the shared AlertDialog) and applied it to all three confirmed destructive actions: Zone delete (upgraded from a native `confirm()` to the dialog), Neighbor-canvassing entry delete, and Invoice void — each dialog states plainly what will be removed/voided and that it can't be undone. The component is now available to wrap any other destructive action app-wide. tsc green.

**Severity:** Low  
**Role(s) affected:** Owner, Office Manager  
**Area:** App-wide — Destructive actions  
**Model to use:** Claude Opus 4.8  

**What we found:**  Confirmed with no confirmation dialog or intermediate step before an irreversible action fires: deleting a Zone and deleting a Neighbor-canvassing entry (both found in the Owner-role pass), and voiding an invoice from the Invoice detail page (found in the Office Manager-role pass, consistent with the same pattern). In each case the destructive control appears to fire immediately on click, with no "Are you sure?" step and no undo option surfaced afterward.

**What to build/fix:**  Add one standard, reusable confirmation-dialog component in front of every destructive action app-wide, and apply it first to the three confirmed instances: Zone delete, Neighbor-canvassing entry delete, and Invoice void — each dialog should state plainly what will be deleted/voided and that the action can't be undone. Since these three were found opportunistically rather than through an exhaustive sweep, audit the remaining delete/void/cancel actions across the app (Clients, Routes, Leads, Franchise, and elsewhere) for the same gap while this component is being built, and apply it everywhere a destructive action exists.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. A reusable confirm-dialog component applied to every destructive delete/void action — contained, but data-safety-relevant enough to keep off the lower-scrutiny track.

---

### #39 — Leads have no detail view and no real conversion workflow

**Status:** ✅ Shipped (July 10, 2026). The Leads cards already showed all captured fields (phone, message, source, date). Added the real conversion: a `convertLeadToClient` server fn that creates a Client pre-filled from the lead (name/email/phone/notes), reuses an existing same-email client if one exists, marks the lead `converted`, and a "Convert to client" button on each non-converted lead that runs it and navigates to the new client — instead of the status dropdown just relabeling. tsc green.

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** Leads  
**Model to use:** Claude Opus 4.8  

**What we found:**  Clicking a lead’s name/card on the Leads page does nothing — there is no detail view, notes, or way to see anything beyond name/email/timestamp. The only control is a status dropdown (new / contacted / qualified / converted / archived); selecting “converted” just changes the label and does not create a client record.

**What to build/fix:**  On the Leads page, clicking a lead card does nothing — there is no detail view or drawer, and the only available action is a plain status dropdown. Add a lead detail view showing all captured fields (phone, message/notes, source, submission date), and wire the ‘converted’ status (or add a dedicated ‘Convert to client’ button) so it actually creates a new Client pre-filled with the lead’s name/email/phone, instead of just relabeling the lead. This directly reduces manual re-entry for office staff converting a prospect into a paying client.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Lead status/conversion workflow needs real state-transition logic, but is scoped to the Leads feature only.

---

### #40 — No real invite flow for adding teammates

**Status:** ✅ Shipped (July 10, 2026). Built a real teammate-invite flow (previously just "share the sign-up link"). New `org_invites` table (migration applied live, RLS scoped to the inviting org) + `accept_org_invite_for_current_user()` which, on the invitee's first sign-in with the invited email, adds them to that org with the pre-assigned role (wired into `/auth` ahead of new-org bootstrap) instead of creating a new org. Server fns `createOrgInvite` (sends a best-effort Resend email + creates the pending row), `listOrgInvites`, `revokeOrgInvite` (all `manage_users`-gated). Settings → Users & roles now has an "Invite a teammate" panel: email + role, a pending-invites list with Revoke, and the role auto-assigns on accept. Verified the accept RPC returns NULL cleanly for users with no pending invite. tsc green. FOLLOW-UP (July 10, 2026, verification pass): added the missing **Resend** action — the pending-invites list previously only had Revoke; `resendOrgInvite` (`manage_users`-gated) re-sends the email and refreshes the invite's expiry, and a shared `sendInviteEmail` helper now backs both create and resend. (Invite-email delivery is best-effort Resend — NEEDS-LIVE-QA to confirm the email actually lands.)

**Severity:** Low  
**Role(s) affected:** Owner  
**Area:** Settings — Users & roles  
**Model to use:** Claude Opus 4.8  

**What we found:**  Settings > Users & roles has no visible “invite” control. The only guidance is the text “To invite a new teammate, share the sign-up link and then assign their role here after they create an account” — there is no copyable link on this screen, no way to send an email invite with a pre-assigned role, and no pending-invite state to track outstanding invitations.

**What to build/fix:**  Settings > Users & roles currently has no proper invite flow — the only instruction is ‘share the sign-up link and then assign their role here after they create an account,’ with no visible link or button to copy from this screen, no email-invite option, and no way to see who has been invited but hasn’t joined yet. Build a proper ‘Invite teammate’ flow: an owner/manager enters an email and role, the system sends an invite email, the Team table shows a ‘Pending’ row with resend/revoke actions, and the chosen role is auto-assigned when the invite is accepted — removing the current manual ‘go find them in the list after they sign up’ step. This is a baseline expectation for enterprise-ready team onboarding.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. A real invite flow (token generation, invite email, join handling) touches account creation/security — contained but not appropriate for the lower-scrutiny track.

---

### #47 — Dashboard shows full company financial KPIs to Dispatcher despite Invoices, Billing, Reports, and Analytics all being blocked

**Status:** ✅ Shipped and verified live (July 9, 2026), folded into #1's fix — do not restart this work.

**Severity:** Low  
**Role(s) affected:** Dispatcher  
**Area:** Dashboard  
**Model to use:** Claude Opus 4.8  

**What we found:**  Dispatcher’s Dashboard (reachable via the “Dashboard” nav item, though the role actually lands on Routes by default) shows the same KPI cards Owner sees: “MTD Revenue $0.00,” “AR Open $5,270.00,” and an “Overdue invoices” panel, plus the “1 client concern to review” banner. This is aggregate financial data the role otherwise has no access to view or interact with anywhere else — /invoices, /billing, /reports, and /analytics are all blocked. It’s a minor inconsistency rather than a serious exposure (no line-item detail is shown, just top-level numbers), but it doesn’t match the access boundary drawn everywhere else for this role.

**What to build/fix:**  Dispatcher’s Dashboard displays company-wide financial KPIs (MTD Revenue, AR Open, Overdue invoices) even though Invoices, Billing, Reports, and Analytics are all blocked pages for this role — an inconsistent information boundary. Either scope the Dashboard’s KPI cards per role (e.g. Dispatcher sees operational cards like Active clients, Visits today, Techs today, but not revenue/AR figures), or, if leadership wants all roles to have full visibility into business health for context, make that a deliberate decision and drop the page-level blocking on Invoices/Reports/Billing to match rather than leaving the two inconsistent.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Apply role-based filtering to the Dashboard's financial KPI cards — should be sequenced together with #1's permission-model fix since it's the same root cause applied to one more surface.

---

### #50 — Global search indexes and surfaces client names to Technician even though opening a result silently bounces back to My day

**Severity:** Low  
**Role(s) affected:** Technician  
**Area:** Navigation — Search  
**Model to use:** Claude Opus 4.8  

**What we found:**  Typing a client's name (e.g. “Sarah Chen”) into the top search bar returns a result under a “Clients” heading, exactly as it would for Owner. Clicking that result attempts to navigate to the client's page but is silently redirected back to My day with no explanation — no “you don't have access” toast, no error, just a bounce. This is a minor but confusing UX inconsistency: the search feature confirms a client by that name exists (a mild information leak consistent with the DNA/canvassing findings above) and invites a click that goes nowhere without saying why.

**What to build/fix:**  Global search returns client results to the Technician role, but clicking through silently redirects to My day with zero feedback, unlike direct URL navigation to a blocked page (which does show a “You don't have access to that page” toast). Either exclude Clients from Technician's search index entirely (consistent with this role having no client-record access anywhere else), or, if surfacing the name is intentional, at least show the same “You don't have access” toast on the redirect so the dead click doesn't look like a broken link.

**Why this model:**  Narrow, contained bug fix or logic correction — well-suited to Opus 4.8's precision on scoped engineering problems without the overhead of a long autonomous run. Apply the same role-based filtering used elsewhere to global search results, and fix the silent-failure result click — contained, permission-adjacent.

---

### #51 — Plans catalog has two indistinguishable free tiers (Free and Puppy), both 0–3 clients, with no visible difference between them

**Status:** ✅ Resolved as part of the #6 rebuild (July 10, 2026). Both "Free" and "Puppy" (and all the other client-band tiers) were deactivated — the real model has no permanent free tier, only a 14-day trial (now a first-class `trialing` plan status with a `trial_ends_at` expiry). The catalog no longer shows two indistinguishable $0 rows; new signups land on the trial, not on either former free tier.

**Severity:** Low  
**Role(s) affected:** Platform Admin  
**Area:** Plans catalog  
**Model to use:** Claude Fable 5  

**What we found:**  The SaaS plan catalog lists both "Free" ("Up to 3 active clients. Unlimited staff. Free forever.") and "Puppy" ("Free trial tier — up to 3 active clients.") as separate active plans with the identical 0–3 client band and $0 price. The only difference implied by the copy is that one is permanent and one is a trial, but nothing on the page shows trial length, what happens at trial end, or which of the two a new signup actually lands on — as far as the catalog view shows, they're functionally the same row twice. This is confusing for a platform admin trying to understand the actual plan structure, and risks becoming actively wrong if only one of the two is really wired up to the signup flow.

**What to build/fix:**  The Plans catalog (/platform/plans) shows both "Free" and "Puppy" as active plans with the same 0–3 client band and $0 price, with no visible distinction (trial length, expiration behavior, which one new signups actually receive). Either merge these into a single plan if they're meant to be the same thing, or, if Puppy is genuinely a time-limited trial that should convert to Free or a paid tier afterward, surface that distinction directly in the catalog (e.g. a "Trial · 14 days" badge and a note on what happens after expiry) so a platform admin can tell them apart at a glance instead of having to guess from near-identical descriptions.

**Why this model:**  Large, multi-step, or new-feature build — matches Fable 5's documented strength on large migrations, complex implementations, and multi-day autonomous sessions. Fold into the #6 Plans catalog rebuild rather than patching in isolation — two indistinguishable free tiers are a symptom of the same catalog-data problem.

---
