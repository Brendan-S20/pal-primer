# QA Round 5 — Code-Level Re-Audit (post PRs #38–#61)

Six parallel area sweeps over every changed surface; findings fixed in the
round-5 PR unless marked accepted/deferred. Verified-clean areas are recorded
in each sweep's notes (payments/AR single-source ar.ts, portal session gating
on all 38 fns, platform admin gating on all fns, impersonation isolation,
one InvoiceRow/Drawer/PayForm, bulk-mutation tenant safety, mobile safe-areas).

## P0 (all fixed)
1. Gift-card redemption moved the card balance but credited nobody (money
   vanished) and was reachable by techs — RPC rewritten (client required,
   manage_client_billing enforced in-function, post_credit_entry ledger),
   reads gated on manage_settings, redemption UI gained a client select.
2. Routes board "Complete" called the tech-only RPC and always failed for
   office users — now completeVisitFromOffice.
3. Plans dialog Annual mode wrote annual dollars into monthly price columns
   (corrupting the tenant plan picker + MRR) — annual price now edits
   annual_price_cents explicitly; MRR divides annual seat overage by 12.

## P1 (fixed)
- updateDispatchSettings: silent 0-row no-op for non-owners (owner-only RLS) —
  now a SECURITY DEFINER RPC (owner/office_manager) with validation; also
  permission-gated app-side.
- Weather edge relay source committed (supabase/functions/weather-forecast).
- DNA: updateDnaMatch non-billing path + dogs fns gated (office roles) and
  org-scoped; createDnaMatch verifies property→org and client→property;
  matchedDogId verified as an org dog; dna_registered/dna_status kept in sync.
- Comms hold operability: clients list shows a "Comms paused" chip, bulk
  Resume action, imports flow states the hold at commit.
- Portal Payment Element pay now invalidates the portal cache (paid state
  shows immediately); staff pay form also refreshes ["credit"] + ["clients"];
  sendInvoiceEmail gated on manage_client_billing.
- Portal add-on requests now notify owner/office_manager (bell) with a link.
- Mobile: InstallBanner offset above the tab bar; day list renders below md at
  every range; revenue top-orgs link to tenant detail; audit action labels
  completed.
- Invoices bulk: selection clears on filter change (no hidden-row mutations),
  Mark-paid confirm-gated, all-fail toasts use error tone, dashboards/billing
  summaries invalidated.
- Clients bulk Archive: archiving now requires manage_client_billing
  (dispatchers excluded); button hidden without it.
- Inventory: archived items got a Restore action (was a one-way door).
- Missing confirms added (DNA row delete, Leads convert/archive); raw enum
  leaks fixed (routes status chip, clients account-type/frequency, leads
  status/source, concerns category fallback); dispatcher ?tab=billing strip.

## Accepted / deferred (documented)
- "Converted this month" platform KPI reads audit actions never written —
  needs a product decision on the conversion event (left as-is, flagged).
- Impersonation banner overlaps sticky headers ~37px when scrolled (cosmetic;
  fix queued with the next mobile pass).
- Native store build (ios/android projects, splash artwork, FCM HTTP v1
  migration for Android push, remote server.url) — the app-store track,
  needs owner decisions and store accounts.
- My Day snapshot cache holds gate codes in localStorage without sign-out
  purge (shared-device risk; queued).
- PWA start_url is /my-day for all roles (queued).
- validateSignupCode is public/unthrottled (low impact; enumeration
  impractical for referral codes; coupon guessing tolerated).
- Various P2 polish items retained in the sweep outputs.
