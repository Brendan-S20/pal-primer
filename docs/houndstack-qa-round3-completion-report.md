# HoundStack QA Round 3 — I14 Completion Report

Delivery of the full QA Round 3 findings sheet (`docs/houndstack-qa-round3-findings.md`)
across a 10-phase plan (order F). Each phase shipped as its own PR: implement →
verify (tsc / vitest / build) → draft PR → adversarial QA review → fix every
confirmed finding → merge → reset branch from main. All migrations were applied
live to Supabase project `vsxzrbxublqrcfnxfwcu` and saved to
`supabase/migrations/`. An item is reported complete only when the workflow
persists, respects permissions server-side, updates related records, and
survives refresh (I14 definition).

Merged PRs: #38 (phase 1), #39 (2), #40 (3), #41 (4), #42 (5), #43 (6),
#44 (7), #45 (8), #46 (9), #47 (10). Test suite grew from 107 → 237 passing.

---

## Evidence per resolved P0 (section B)

- **B1 — dashboard AR $0 vs $4,805 real.** Root cause: the dashboard query
  filtered `status='open'` but never SELECTed `status`, so the outstanding
  check read `undefined` and summed $0. Fixed with one authoritative
  `src/lib/ar.ts` (net-of-credit `invoiceOutstandingCents`, due-date `isInvoiceOverdue`,
  `summarizeAr`) consumed by dashboard, reports, invoices index, clients list,
  digest. Overdue is now due-date based everywhere. (PR #38, `tests/ar.test.ts`.)
- **B2 — "Take payment" navigated away + bare "Pay $X".** Shared
  `StaffInvoicePayForm` embedded in the drawer and the invoice page: charge
  saved card (credit-first), apply credit, or explicit Payment Element entry —
  no navigation, always states the instrument. (PR #38.)
- **B3 — zone matcher picked the wrong zone.** Root cause: radius/drive-time
  ranked above exact-ZIP/prefix. New ranking (polygon > exact ZIP > prefix >
  radius, best-level scoring, then priority, type-appropriateness, longest
  prefix) in `zone-match.ts` + mirrored `public_quote` RPC + one-time
  assignment repair. Verified live: 412 Congress Ave now detects Downtown
  Commercial. (PR #39, `tests/zone-match.test.ts`.)
- **B4 — client Billing tab kept old invoice UI.** One shared `InvoiceRow` +
  `InvoiceDrawer` across the Invoices page and the client Billing tab; inline
  copy-link/void removed. (PR #41.)
- **B5 — /payments four empty boxes.** Each embedded Connect component got
  loading / error / retry states; raw `acct_…` id masked. (PR #47.)
- **B6 — visit lifecycle.** Missed-visit transition job (org-local cutoff),
  workday-anchored windows (was UTC-cast local time → 4 AM), duration from
  timestamps. 42 stuck visits reconciled to `missed`. (PR #40.)
- **B7 — credits don't apply.** `invoices.credit_applied_cents` +
  `apply_credit_to_invoice` RPC (advisory lock, refuses prepaid top-ups); every
  charge path nets credit first. Credit application writes NO payments row
  (it moves no cash) to avoid double-counting revenue. (PR #38.)
- **B8 — DNA disconnected from units.** Dogs key to client→property→unit;
  `/dna` and the Units tab read the same records; orphan dogs → management
  review (never guessed); sample chain-of-custody fields; server name
  validation. (PR #43.)
- **B9 — no client-billing settings.** Net terms + grace + auto-send surfaced
  as a dedicated Settings → Invoicing page (they existed under Automation, were
  undiscoverable); force-send with confirm. (PR #42.)
- **G1 — portal hid overdue debt.** Portal home + billing show open count/total
  (net of credit), due dates, overdue chips. (PR #38.)
- **G2 — "Read sign-in code" ungated.** New `reveal_signin_code` permission
  (owner/office_manager), click-through confirm, and the reveal now GATES on a
  successful audit-log write (no code returned if it can't be logged); tighter
  email mask; channel-copy matches deliverable channels. (PR #45.)
- **H5 — platform MRR conflated tenant GMV.** MRR now derives from tenant SaaS
  subscriptions (`platform-metrics.ts`), not client collections; tier from
  `plan_id`; demo reconciled Growth→Scale. (PR #46, MRR≠GMV test.)

---

## 1. Files / components changed (by area)

- **AR / money:** `src/lib/ar.ts`, `overdue.ts`, `invoices.functions.ts`,
  `invoice-reconcile.server.ts`, `StaffInvoicePayForm.tsx`, `InvoiceDrawer.tsx`,
  `InvoiceRow.tsx`, `invoice-labels.ts`, `billing-settings.ts`,
  `automation-settings.ts`, `dashboard.functions.ts`, `reports.functions.ts`,
  `portal.functions.ts`, nightly worker.
- **Zones / pricing:** `zone-match.ts`, `zones.functions.ts`,
  `zones-redetect.server.ts`, `pricing.ts`, `ZoneDrawer.tsx`,
  `StandardPricingCard.tsx`, `geocodePostal`.
- **Visits:** `visit-lifecycle.ts`, `route-window.ts`, `VisitsTab.tsx`,
  nightly missed-visit job.
- **DNA / units / stations:** `dna-linkage.ts`, `dna.functions.ts`,
  `dogs.functions.ts`, `units.functions.ts`, `stations.functions.ts`,
  `UnitsTab.tsx`, `stations-panel.tsx`, `PropertyDrawer.tsx`.
- **Roles / holds:** `permissions.ts`, `users.functions.ts`,
  `VacationHoldDrawer.tsx`, `hold-request.ts`, `concerns.tsx`.
- **Platform / impersonation:** `platform-metrics.ts` + `.server.ts`,
  `platform.functions.ts`, `platform-overview.functions.ts`, `humanize.ts`,
  `ImpersonationBanner.tsx`, platform routes.
- **Phase-10 authz + polish:** `accounting-oauth`, `blackouts`, `churn`,
  `messages`, `neighbors`, `org`, `promotions`, `reviews`, `skip-rules`
  functions; `payments.tsx`, `weather.tsx`, `imports.$batchId.tsx`,
  `inventory.tsx`, `waste-log.tsx`, `my-day.tsx`, `RouteMap.tsx`.

## 2. Migrations added (all applied live)

`credit-application` + qa-fixes; `zone-ranking-and-geometry` + `public-quote-alias-fix`
+ `public-quote-trim-zip`; `visit-missed-status` + `window-timezone-and-duration-integrity`
+ `missed-visit-transition-job` + visit-lifecycle-qa-fixes; `prepaid-line-item`
(human→iso); `credit-application` schema; `dna-unit-linkage-and-validation` +
`station-numbering-and-completion` + `property-total-units-and-station-rate` +
phase6-qa-fixes; `field-worker-flag-and-hold-validation` + durability;
`impersonation-exit-and-perms`; `platform-metrics-tier-and-signup-validation` +
phase9-qa-fixes.

## 3. Background jobs added / modified

- **Missed-visit transition** (`admin_transition_missed_visits`) wired into the
  nightly worker — idempotent, org-local cutoff, never touches
  completed/skipped/canceled, missed visits never bill.
- **Autopay** hardened: reconcile-first, in-flight ACH guard, stores its PI on
  the invoice so a missed webhook is rescued rather than re-charged, credit-first.
- **Station service logging** on visit completion (`record_visit_station_service`).
- **Tier sync** trigger (`orgs_sync_tier_on_plan`) keeps `billing_tier` derived
  from `plan_id`.

## 4. Components consolidated (I3)

One `ar.ts` (all AR math); one `InvoiceRow` + `InvoiceDrawer` +
`StaffInvoicePayForm` across Invoices page and client Billing tab; one
`zone-match.ts` shared by detection/quote/repair; one `VacationHoldDrawer`
(client header + concerns); one `invoiceKindLabel`/`formatLineItemDescription`;
one `dna-linkage.ts` name/label validation mirrored in SQL; one
`platform-metrics.ts` MRR computation across Overview/Revenue/tier; raw enums
killed (prepaid_topup, office_manager, xlarge, start_impersonation) via shared
label maps.

## 5. Tests added

107 → 237 passing. New suites: ar, credit-application, overdue, zone-match,
visit-lifecycle, route-window, invoice-labels, billing-settings, dna-linkage,
station-service, platform-metrics, phase8-authz, phase8-labels, phase10-authz.
**I13 #1–22:** all covered by pure-logic tests or inherently UI/integration
(manual-verify: #2 popup-in-context, #21 first-tap nav, and the DOM/Stripe/DB
execution halves of #3/#11/#13/#22).

## 6. Reconciliation performed (I5, idempotent)

- 42 stuck scheduled visits → `missed`; 2 ambiguous (scheduled-today,
  past-in-progress) left for review.
- ZIP-only zones backfilled with 1-mile radii; property zone assignments
  repaired under the new ranking (manual overrides preserved).
- 1 orphan DNA dog → management-review state (not guessed); stations renumbered
  to integers; demo org tier Growth→Scale; all orgs' `billing_tier` aligned to
  `plan_id`.

## 7. Records sent to manual review (never silently altered — I6)

- 2 zero-duration "completed" visits (fabricated `started_at == completed_at`)
  — display corrected to "Not recorded", timestamps left for an office user.
- 1 past `in_progress` visit and 1 scheduled-today — surfaced, not swept.
- Junk tenants ("Test Test" ×3, empty orgs) — "Review name" badge in the
  platform console, not hard-deleted.
- Downtown Commercial zone's radius center points at Michigan (user-drawn) —
  surfaced via View coverage, not silently repaired.

## 8. Server-side authorization (I7 / section E)

Every exported server fn audited. Money/platform surfaces were already gated.
11 fns that a tech/dispatcher token could reach via API (despite hidden UI)
were fixed with server-side `requirePermission` + negative tests: promotions/
gift-cards, skip-rules, blackouts, accounting-oauth, org SMS consent, staff
addresses, churn/win-back, messages (SMS to client — checked before Twilio
fires), referral stats, neighbor leads. New `reveal_signin_code` permission;
`endImpersonationSession` authenticated and scoped to the impersonated session;
dispatcher/tech confirmed API-rejected for billing/DNA-registry/code-reveal.

## 9. Untested external dependencies

- End-to-end Stripe charge through the new pay form (needs a live connected
  account); the first-tap portal nav fix on a physical phone; weather provider
  API (put behind a graceful error/retry state); DNA provider sync (no API
  exists — references only).

## 10. Incomplete / deferred requirements — all since delivered

Every item below was originally deferred with the stated reason, then built in
the deferred-items follow-up PR:

- **Frequency-change-from-concern** (C4/G4) — DONE. `portal_change_frequency`
  now branches on `portal_auto_apply_changes`: when off, it files a structured
  qc_ticket ("Frequency change requested: weekly → monthly (subscription
  <id>).", duplicate-guarded) instead of applying, and enforces
  `portal_allow_frequency_change` server-side. The Concerns page parses the
  request (`frequency-request.ts`, mirroring `hold-request.ts`) and offers a
  confirmed one-click "Apply frequency change" (`applyFrequencyChangeRequest`,
  `manage_pricing`-gated, with estimate recompute + horizon top-up + activity
  log), then resolves the concern. Portal toasts distinguish
  applied/requested.
- **DNA sample-photo storage** (B8) — DONE as collection evidence (photo of the
  bagged sample/kit at the site), which stays inside the I9 rule: no genetic
  media. Private org-scoped `dna-samples` bucket (waste-receipts policy
  pattern), `dna_matches.sample_photo_path`, compressed upload on the sample
  form, signed-URL link in the chain-of-custody table, server-side path-prefix
  check against the caller's org.
- **Impersonation marker on tenant-Activity entries** (H2) — DONE without the
  feared heuristics: `consumeImpersonation` stores the minted session's JWT
  `session_id` on the grant; `logActivity` resolves the current request's
  session id (from the already-verified bearer token) against unended grants
  via a unique partial index, 60s-cached. Exact session keying cannot
  false-positive against multi-tab isolation. Marked entries render a
  "Platform-admin impersonation" badge on the client Activity tab; the
  admin's identity stays in the platform audit.
- **center_\* backfill for zones** — DONE as the deliberate reconciliation
  pass: derive missing centers (pin → property centroid), preserve configured
  radius/drive-time extents, re-rank property assignments, leave underivable
  zones in the manual-review queue. Verified against live data first: zero
  zones currently qualify, so the pass is a safeguard for imported/regressed
  rows.
- **Non-field on dashboard "Techs today"**: was already resolved — the
  dashboard tech list uses the same `is_field_tech` flag (shipped phase 7).

## 11. Remaining limitations

- Name validation uses a placeholder blacklist for the "Ew"-class 2-letter junk
  while allowing real short/non-Latin names; a novel ambiguous placeholder
  could pass.
- MRR treats subscriptions as monthly unless the plan's interval is annual
  (no per-org billing-interval column yet; the ÷12 branch is ready).
- Enterprise/off-catalog plans with no listed price contribute 0 to derived MRR.

## Verification pass (post-merge audit of this report against the code)

A full audit of every findings-sheet item against the merged code confirmed the
sections above and caught five residual gaps, fixed in a follow-up PR:

- Stale "AI: zone pricing" pointers in the command palette and help article
  (the panel itself was correctly hidden — C5).
- Dashboard header, My Day header/tech picker, and Routes board columns still
  rendered raw role enums ("office_manager") — routed through `humanizeRole` (H3).
- The onboarding tour auto-fired inside impersonation tabs and stamped the
  impersonated user's `tour_seen_at` — now guarded by `isImpersonationTab()` (H3).
- Portal header chip labeled the subscription's unit count as "stations" (G4).
- Portal service history rendered only under Requests — moved to the Visits tab,
  Home's "View full history" link retargeted (G4).

Known acceptable deviations (verified, deliberately left): the dashboard
concerns alert links to `/concerns`, whose default filter is the to-review
("Received") view rather than a param-driven deep link; org signup rejects
junk names and dedupes per-user/per-email but does not enforce global org-name
uniqueness (distinct businesses may legitimately share a name); the new-zone
form is a drawer rather than a multi-step wizard; humanized line-item dates
read "Prepaid service on Thu, Jul 16" (the "—" separator in the finding was
an example, not a requirement).

## Standing user-side configuration (unchanged, outside code)

Publish from Lovable (auto-syncs from `main`); production env keys
(`GOOGLE_PLACES_API_KEY`, `STRIPE_PUBLISHABLE_KEY`,
`STRIPE_CONNECT_PUBLISHABLE_KEY`, weather provider key); production Stripe
webhooks; Twilio toll-free verification. Parked: Regrid parcel data, the annual
discount rate.
