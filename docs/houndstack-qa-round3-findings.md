# HoundStack QA Round 3 — Full-App Findings Sheet

Live owner-session sweep of the Demo Pet Waste Co workspace (owner@demo.test) on 2026-07-17. Every page in the sidebar was visited; client detail re-audited against Rounds 1–2. Every finding was observed firsthand unless marked untested.

## A. Regression pass — confirmed WORKING (do not re-break)

* Auto-billing on client cadence with due dates, overdue chips, status filters, search, period filters, CSV export (Invoices page)
* Invoice preview popup with line items + actions (Take payment, Send to client, Send reminder, Copy pay link, Void, Open full invoice)
* URL-addressable client tabs (`?tab=`), persists on refresh
* Summary "Needs attention" alerts with severities + Review links (verified: "No payment method on file", "No arrival window configured")
* Two-column Summary; real note records (author-timestamped, pinnable); formatted phone numbers; humanized dates on Summary/Visits/Invoices
* New client tabs: Units, Communication, Reviews & referrals; header Call/Navigate/Message actions
* Commercial property card: satellite boundary preview, acreage (4.08 acres), yard size from boundary, zone "Detected automatically", est. time auto-calculated, commercial details section, "Dogs are managed per unit" pointer, destructive actions demoted to •••
* Visit detail popup with Mark completed / Reschedule / Reassign / Cancel visit (styled modal, not native confirm)
* Visits tab: Upcoming/Past grouping, human states ("Not started", "Not recorded", "Unassigned"), Service column, status filter, List/Calendar toggle
* Zones: overview map with legend, radius-based coverage, commercial zone with $/acre + first-cleanup fee
* Client Billing: credits ledger with Add credit; Stripe-managed payment language; portal self-serve permissions incl. vacation-hold requests (Settings > Preferences)
* Settings depth: skip rules, blackouts, add-ons, deep-clean, lead form, promotions (incl. gift card), SMS/email/AI/automation, users & roles

## B. P0 — bugs (all verified with repro)

### B1. Dashboard financials are wrong
Dashboard shows AR OPEN $0.00 and "Overdue invoices: Nothing overdue" while the Invoices page shows $4,805.00 outstanding, 13 open, 8 overdue, and Reports shows AR aging $4,685 in 1–30 days. The dashboard AR/overdue queries are broken (wrong filter, wrong workspace scope, or stale cache). An owner glancing at the dashboard would believe collections are fine while $4.8k is outstanding.

### B2. Invoice popup "Take payment" navigates away + payment form has no payment method
Repro: Invoices → row → popup → Take payment → navigates to `/invoices/{id}` (the exact extra step the popup exists to remove). On the full page, Take payment expands an inline panel showing only client name, amount, and a "Pay $120.00" button — no card entry, no saved-method selector, no indication of what will be charged (this client has no card on file). Fix: embed the payment element (card entry or saved-method choice) inside the popup; the Pay button must state the instrument. Add the missing "Charge autopay" action — currently absent everywhere, so autopay-covers-open-invoice can't be exercised.

### B3. Zone matcher picks the wrong zone (overlap priority missing)
412 Congress Ave, Austin 78701 (commercial) auto-detected "Central Austin" (residential, prefix 78704, 24.9 mi radius) instead of "Downtown Commercial" (prefix 78701, 18.3 mi radius). A huge radius on one zone swallows other zones' home ZIPs. Matching must rank: exact ZIP/prefix match > radius containment, apply the priority setting for ties, and prefer type-appropriate zones (commercial property → commercial zone) with an override.

### B4. Billing-UI removals not applied on client Billing tab
Client detail → Billing still shows "Generate invoice from unbilled visits" and per-row "Copy pay link" buttons, and rows lack the preview-popup Open action. The Invoices page got the new pattern; the client tab kept the old one. One invoice-row component, used in both places.

### B5. Payments page renders four empty boxes
/payments: Stripe connect status renders, then four empty card containers (embedded Stripe components silently failing to load), plus the raw account ID (`acct_...`) displayed. Add loading/error states to every embedded component; label or hide the account ID.

### B6. Visit lifecycle/data integrity
* Past visits stuck "Scheduled" (Jul 9, Jul 16 rows in Past) — no missed/expired transition job.
* Auto-generated absurd 8-minute service windows at 4:00–4:08 AM / 4:31–4:39 AM on past visits; Routes shows route "ends 04:24 AM" and visit ETA 04:00 AM — window/ETA generation is using a midnight base instead of workday start.
* Completed visit with actual start 6:05 AM and completion 6:05 AM shows duration "Not recorded" — duration not computed from timestamps; also identical start/complete suggests a backfill bug.

### B7. Credits don't apply to invoices
Bark Park has $20.00 credit and $1,695.00 open invoices simultaneously with no application action or auto-apply. Credits auto-apply before charging; at minimum an "Apply credit" action on open invoices.

### B8. DNA module is disconnected from clients/units
The global /dna page: sample form has no property, client, unit, collecting-tech, photo, or kit-tracking fields (location is a free-text note); Registered dogs is a flat list with a per-row checkbox + registry-ID + Save (no unit column — HOA dogs float unattached; Bark Park's Units tab shows 0 units while /dna lists its dogs). Dog names "1" and "Ew" accepted (no validation). Keep /dna as the cross-property ops view, but every dog and sample must key to client → property → unit, with status enums, chain-of-custody fields, enable-wizard, open registration, and compliance dashboard.

### B9. No client-billing settings exist
No net terms, grace period, or auto-send configuration anywhere discoverable (Settings > Billing is the platform subscription page). Invoices already carry "Due Fri, Jul 31" from an invisible default. Build workspace-level net terms + grace period + force-send settings and surface the held→sent state.

## C. P1 — spec gaps

1. [CORRECTED — see G7] Waste stations DO exist, on the Services tab. Remaining gaps in G7 (numbering broken, Remove on list, no station↔visit link).
2. Commercial pricing model incomplete: zone has $/acre but no per-unit or per-waste-station rates visible; property has no Total units field (zone pricing must use total units, not dog-owning units); no "has units" checkbox on property add/edit; price breakdown not shown anywhere.
3. Non-field roles pollute routing/reporting: Routes tech-load lists Dana Dispatcher (labeled "Dispatcher") as a route runner; Reports tech productivity lists Morgan Manager, Olivia Owner, Unassigned as techs. Add a per-user "routable/field" flag; exclude non-field users from tech lists by default.
4. Vacation holds arrive as free-text concerns with no hold action. Concerns shows "Vacation hold requested 2026-07-23 → 2028-10-17" (a 2+year range accepted — no validation) with only reply/resolve actions. Add "Create hold from request" that opens the hold flow prefilled, links to the client, validates ranges, and pauses visits+billing.
5. Zones page leftovers: standard pricing still top-of-page (move behind settings + mirror in Settings); AI zone pricing still visible (hide); ZIP-only coverage still allowed (require geometry, migrate ZIP+1mi); no View-coverage popup; overview map zooms to the whole US instead of fitting zones; "Zones without a map location: 12" reads as a count but "12" is a zone name (also: no zone-name validation); Delete exposed on cards.
6. Invoice content polish: line items show raw ISO dates ("Prepaid service on 2026-07-16" → "Prepaid service — Thu, Jul 16"); raw enum chip "prepaid_topup" shown to users; list rows show a checkbox column with no visible bulk-action bar.
7. Neighbor canvassing: each row shows a status dropdown AND an identical status chip (keep one); per-row trash delete with no styled confirm.
8. Dashboard: "Techs today: Dana Dispatcher" (see C3); map zoomed to one street instead of fitting today's visits; verify "2 client concerns to review" deep-links to the filtered Concerns view.
9. Platform billing (Settings > Billing): history periods render "Thu, Jul 16 to Thu, Jul 16" — single-day period for a monthly subscription invoice; verify period computation.

## D. P2 — polish
* Waste log: always-open form (collapse per app pattern), unstyled native file input, facility default "(none)".
* Inventory: on-hand renders "10.00 each" for a count — drop decimals for unit-counted items.
* Concerns cards: two always-open textareas per card; collapse to actions.
* My Day empty state: add a "View routes" action.
* Reports: solid — use as the reference implementation for dashboard numbers.
* Analytics: fine at this data volume.

## E. Untested
* Completing a Stripe payment end-to-end; submitting a portal add-on request; portal reschedule/skip cutoff enforcement; lead → client conversion; gift-card purchase/redemption end-to-end; service Edit drawer on the commercial service (clicking Edit produced no visible drawer — retest, possible dead click); "Bill next" period_end error retest.
* Server-side authorization: all role restrictions verified are UI/router-level. Confirm the API enforces role checks independently.

## G. Second-pass findings (settings, zones creation, weather, imports, portal as client)

### G1. Portal hides the client's overdue debt — P0
Portal Home shows a single "Open invoice $295.00" card. The client actually owes $1,695 across two open invoices, including $1,400 OVERDUE since Jul 16 — visible only by tapping into Billing, and even there invoices show issue date but no due date and no overdue state anywhere in the portal. The client-facing surface must show: open count + total, due dates, and an overdue badge; Home card should read "2 open invoices · $1,695.00 · 1 overdue."

### G2. "Read sign-in code" works but is ungated — security
Any office user can click once and see the client's active OTP with no role check, no confirmation, and no Activity log entry. Keep the support flow, but: permission-gate it (owner/manager), require a click-through, and log every reveal to Activity. Also: the verify screen's masked email shows the real first characters + full domain; and the client page says codes are "texted to (512) 555-0810" while the portal only offers "Email me a code" — channel mismatch.

### G3. Portal bottom-nav dead click
First tap on a bottom-nav tab (Billing) highlighted the tab but did not change content; second tap navigated. Investigate the SPA nav handler.

### G4. Portal labels/data
* Header chip says "Weekly · 24 stations · $280.00/visit" but the service defines 24 units — mislabel.
* Stations render as "0" and "01" with "Last serviced: -" (numbering bug leaks to clients; station servicing never recorded — stations aren't linked to visit completion).
* Service history lives under the "Requests" tab instead of Visits; most visits say "Photos not available"; the 6:05 AM completion from B6 is client-visible.
* Requests form is category+text only — the portal's vacation hold (Account tab, date-range Request hold — this EXISTS and is well-formed) and frequency-change request arrive at the office as free-text concerns with no structured accept action (refines C4: build "create hold from request" / "apply frequency change" actions).
* Portal add-ons exist on the Property tab — approval flow untested.

### G5. Zone creation form (corrects C5 scope)
A Priority field exists — so B3's wrong-zone pick likely stems from equal default priorities + no exact-ZIP-beats-radius rule. Still missing from creation: residential/commercial type selector and commercial rates (per unit/acre/station), required map coverage (form has ZIPs only), map centering on ZIP entry, popup/wizard format. Existing-zone Edit should expose priority too.

### G6. Weather page broken
All three zone forecasts fail: "Couldn't load the forecast (weather service error)". Tech workload lists Dana Dispatcher, Morgan Manager, Olivia Owner (C3). Zone "12" flagged "no coordinates."

### G7. Waste stations (corrects C1)
Implemented on Services tab with satellite map, required marker, liner-size dropdown, notes, Navigate + pencil-edit + Remove per station. Remaining: numbering broken ("0", "01" — should be 1, 2, renumberable), Remove exposed on the list instead of inside edit, list rows show no label/liner info, stations not linked to visit completion ("Last serviced" never populates), consider whether they belong on the Property card as well.

### G8. Users & roles / misc
* Roles page: "Routing & addresses" only on technicians — but the dispatcher is still routable (root cause of C3); add an explicit "appears on routes" flag. No visible permission matrix.
* Imports: a Jobber import failed 281 of 281 rows with no failure reason surfaced — investigate the Jobber mapping and show error summaries inline.
* Promotions: promo code named "10" accepted — name/code validation missing (same class as zone "12", dog "1"/"Ew": add sensible validation everywhere).
* Owner-added add-on charge showed "Invoiced" (correct); the "pending" repro didn't reproduce — retest on a prepaid residential client.

## H. Role QA

### H1. Technician (direct sign-in)
* Working: sidebar scoped to Field pages + Settings; /clients and /invoices redirect to My Day; Settings trimmed; visit cards strong (required completion photo, photo types, gate codes, hazards, Start/Complete/Skip, +Add-on, texts, sticky NEXT UP).
* Bugs/gaps: progress header counts skipped visits as done ("2 of 7 done · 29%" with 0 completed); yard sizes render raw tokens ("xlarge"); "Stations" button on residential visit cards; no dog names/temperament on residential cards (safety gap); no ETA or service window per card; tech can open the full DNA compliance page — scope techs to sample logging only.

### H2. Impersonation feature (platform admin)
* Working: per-user impersonation with confirm modal; per-tab sessions coexist correctly; audit log records start/enter events.
* Gaps: impersonated tab shows no banner (add persistent banner + "Exit impersonation"); audit summary omits which user was impersonated, no exit/duration event; actions taken while impersonating appear in tenant Activity with no impersonation marker; raw snake_case event names in the audit UI.

### H3. Office manager (impersonated)
* Working: owner-minus-platform-billing; Settings hides Billing; Users & roles read-only.
* Gaps: header reads "Signed in as office_manager" (raw enum); onboarding tour fired inside the impersonated session (consumed the real manager's tour state); dashboard shows the same broken AR numbers (B1).

### H4. Dispatcher (impersonated)
* Working: role-tailored dashboard; no Leads/Billing/Reports/Analytics/Settings/Inventory; client detail hides Billing tab AND Outstanding stat.
* Gaps: deep-linking `?tab=billing` renders an empty content area instead of redirecting; "Overdue invoices" card still on dispatcher dashboard; dispatcher retains full "Edit Client" (confirm intended); dispatcher is routable as a tech.

### H5. Platform admin console
* Working: tenants list/detail, feature flags, notes, audit; Health page excellent — "STUCK VISITS: 42" corroborates B6; suppressed emails surfaced.
* Bugs/gaps:
  * Revenue metrics conflate tenant GMV with SaaS revenue: "Top orgs MTD $965.00" is client collections, not the $527/mo subscription; tier label wrong (org on Scale shows Growth); Overview says MRR $0 while Revenue claims ARR $3,860 — three pages, three answers.
  * Platform-admin account outside the console sees a broken "No organization yet" dashboard; route them to /platform.
  * Junk tenants ("Test Test" ×3) — signup allows duplicates; cleanup + validation.
  * Tenant Delete one click from Impersonate/Suspend (destructive-action separation).
  * Sidebar "Payments" missing for office manager — verify which roles reach /payments.

## I. Implementation guardrails & completion requirements (BINDING)

### I1. Systems review, not UI tickets
Trace the data model, API behavior, permissions, background jobs, and every surface sharing the same data before changing a workflow. Do not patch demo records, hardcode workspace-specific values, or add frontend-only fallbacks that hide broken backend behavior.

### I2. Regression protection
Everything in Section A is regression-protected. When modifying a shared workflow, re-verify the protected behavior afterward.

### I3. Shared components and domain logic — no duplicate implementations
Consolidate at minimum: invoice rows, invoice preview + actions, payment collection, credit application, visit actions, status labels (kill raw enums: "prepaid_topup", "office_manager", "xlarge", "start_impersonation"), date formatting, role-aware user selectors, property/unit dog records, waste-station records, zone matching + pricing. Invoices page and Client Billing tab must use one invoice-action implementation (root of B4). /dna and Units tab must read the same records (root of B8).

### I4. Root causes (confirmed by live evidence)
* Dashboard financials (B1): same accounting query as Reports/Invoices — Reports is correct; make it the authoritative service.
* Zone detection (B3): one deterministic matcher shared everywhere. Ranking: exact ZIP/prefix > radius containment > priority tiebreak > type-appropriateness.
* Visit lifecycle (B6): transition job (Health page detection query exists); route windows use configured workday hours, not midnight.
* Billing periods: one billing-period service; no arbitrary fallback dates.
* Waste-station numbering (G7): stable integer sequence per property.
* Role filtering (C3/H4): capability flags (`is_field_worker` / `appears_on_routes`), not role-name checks.

### I5. Data migration & reconciliation (idempotent; ambiguous records to review queue, never silently guessed)
Repair: dashboard aggregates; past scheduled visits (42 known); visit timestamps/durations; properties in wrong zones; zones without geometry (ZIP+1mi default); commercial properties missing units/acres/station counts; dogs without unit association; DNA records without client/property/unit; waste-station numbering; credits applicable to open invoices; prepaid invoices missing periods; non-field users flagged routable; platform tier + revenue records.

### I6. Audit & historical integrity
Never silently alter historical billing, pricing, ownership, or incident records. Store history for: invoice pricing components, applied zone/pricing version, credit applications/reversals, payment attempts, autopay charges, post-invoice visit changes, DNA kit assignment + match review, resident/dog unit moves, impersonated actions, zone overrides, manual price overrides.

### I7. Authorization — server-side, tested with real API calls
Hidden tabs and redirects are not authorization. Enforce and negative-test via API: technicians create/update field samples only; dispatchers blocked from billing via direct routes AND API; "Read sign-in code" requires specific permission + confirmation + Activity log; impersonated requests carry platform-admin identity into audit context AND show a persistent banner with "Exit impersonation"; portal users access only their own records; every workspace query tenant-scoped.

### I8. Payment safety
Every charge action: exact amount + instrument shown (or explicit new-card entry), explicit confirmation, idempotency keys, duplicate-submission prevention, attempt recorded, clear success/failure, invoice updated only after confirmed payment, processor IDs preserved, credits auto-applied first when enabled. Never render a bare "Pay $X" with no payment method in context.

### I9. DNA architecture
Keep /dna as the cross-property ops workspace over the SAME records as the Units tab. Chain: Workspace → Client → Property → Unit → Dog; DNA attaches as Dog → Registration → Kit → Provider profile; samples as Property → Sample → Collection record → Lab result; matches as Lab result → Dog → Unit → responsible party. "Resident/Household" modeled as occupant fields on Unit for v1. Every DNA dog belongs to client + property (+ unit where applicable, else management-review state). No raw genetic markers. Validate names/identifiers.

### I10. Feature flags for broken/incomplete integrations
Flag or show setup states for: Weather (erroring), embedded Stripe components (four silent empty boxes), DNA provider sync, AI zone pricing (hide), portal actions not enabled, payment features pre-Stripe-connect. Every external component gets loading/empty/config-required/error states + retry.

### I11. Validation, everywhere, server-enforced
Dog names, zone names, promo names/codes, unit labels, station numbers/labels, vacation-hold ranges, billing periods, invoice dates, commercial quantities, radius/geometry, import rows (Jobber 281/281 failure needs surfaced errors), email/phone, duplicate units/dogs/organizations. Human-readable messages.

### I12. Background jobs (safe to retry; no duplicates)
Confirm or build: missed-visit detection, invoice generation, grace-period delivery, overdue updates, autopay attempts, credit auto-application, registration reminders, DNA status sync, zone reconciliation, weather refresh, subscription/MRR sync.

### I13. Automated regression tests (minimum set)
1. Dashboard AR/open/overdue = invoice ledger. 2. Popup Take Payment stays in context. 3. New-card and saved-card paths. 4. Autopay charges an open invoice. 5. Credits apply before charge. 6. Exact-ZIP/commercial match beats radius. 7. Equal-priority overlap resolution. 8. Past visits transition. 9. Route windows use workday config. 10. Duration computed from timestamps. 11. Client Billing = Invoices page actions. 12. Terms/grace/scheduled send/force-send. 13. Portal balances, due dates, overdue visible. 14. Unit-keyed DNA registration. 15. Sample → unit/resident match. 16. Technician DNA permissions. 17. Dispatcher route + API restrictions. 18. Impersonation audit identity. 19. Platform MRR ≠ tenant collections. 20. Station numbering + per-station service history. 21. Portal nav navigates on first tap. 22. "Read sign-in code" permission + audit.

### I14. Completion report required
Files/components changed; migrations; jobs; components consolidated; tests added; reconciliation performed; records sent to manual review; untested external dependencies; incomplete requirements; evidence per resolved P0; remaining limitations.

## F. Suggested implementation order
1. B1, B2, B7, G1 (money visibility + payment path)
2. B3 + C5 zone matching/priority
3. B6 visit lifecycle job + window generation
4. B4, C6 invoice UI consolidation
5. B9 billing settings (terms, grace, force-send)
6. B8 + C1 + C2 (DNA ↔ Units ↔ stations ↔ commercial pricing)
7. C3/C4 role flags + hold-from-concern
8. Role fixes (H1, H4, H2)
9. Platform console metrics (H5)
10. Remaining C/D polish + server-side authorization verification
