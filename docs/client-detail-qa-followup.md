# HoundStack `/clients/[clientId]` — QA Fixes, UI/UX System, and IA Additions

Follow-up to `docs/client-detail-refactor.md`. A live QA pass was performed as an owner against client `7c47d480-d753-4b2a-a983-8b61031274df` on 2026-07-15. Every finding below was verified in the running app — do not assume a component's presence means the requirement is complete.

Work in the stage order given. Within each stage, verify against the acceptance criteria before moving on. Before implementing, inspect the existing schemas and logic for zones, pricing, visits, dogs, and activity logging — fix root causes, don't patch symptoms in the UI.

## Stage 1 — P0 functional bugs (data-path correctness)

These are all in the property/service/zone data path and should ship together.

### 1.1 Zone auto-detection is broken

* Repro: property "11107 Dudley Street, Taylor 48180"; Zones page has a "Taylor" zone with ZIP-only coverage for 48180. Properties tab shows "No zone matched · Detected automatically."
* Meanwhile the service Edit drawer has zone "Taylor" selected and shows a Taylor zone price — two surfaces disagree about the same property.
* Likely cause: manually entered addresses ("Address entered manually" badge) don't normalize/store the postal code the way zone matching expects. Trace the matching input end to end.
* Fix: zone detection must work from the stored postal code regardless of how the address was entered. Store auto-detected zone and effective zone separately per the PRD (override + reason + user + timestamp).

### 1.2 Zone price comparison shows unexplainable numbers

* Repro: zone config is $35 base + $5/extra dog. Edit Service drawer (every 2 weeks, 2 dogs) shows "Taylor zone price $68.00." $35 + $5 = $40/visit — the $68 cannot be reconciled by the user.
* Fix: whatever the formula (frequency multiplier, per-dog tiers), the comparison panel must show the breakdown: base + dog adjustment + frequency adjustment = zone price. Never show a bare number the owner can't derive from zone settings.

### 1.3 Blank price → Save is a silent no-op

* Repro: Edit Service → clear Price → Save changes. Nothing happens: no inline error, drawer stays open, nothing persists. The comparison panel meanwhile shows "Final price $0.00."
* The old raw Zod/NaN JSON error is gone (good) but was replaced with zero feedback (also bad).
* Fix: inline validation — "Price is required" on the field, disable Save or show error on submit. Comparison panel should show "—" not $0.00 when price is empty. Apply the same validation pattern to every numeric field in the drawer (dogs, weeks between visits, the add-on inputs).

### 1.4 Native `confirm()` dialogs on destructive actions

* Repro: Properties tab → Delete fires a browser-native confirm. Edit Service drawer → Cancel with unsaved changes fires another. Both block the renderer (they froze automated testing twice).
* Fix: replace ALL `window.confirm`/`window.alert` usages with styled modal dialogs. The delete/archive modal must state which action applies and why (per PRD archive-vs-delete rules) and list dependencies (visits, invoices, active services). The unsaved-changes prompt becomes a small styled modal with Discard / Keep editing.
* Audit the codebase: `grep -r "confirm(" "alert("` — remove every instance.

### 1.5 Dog counts are disconnected from dog records

* Repro: property shows "DOGS (0) — No dogs recorded"; its two services bill for "2 dogs" and "1 dog"; the clients list shows 0 dogs.
* Fix per PRD: dogs are records belonging to the property. Service dog count derives from active dogs at the property (with explicit override allowed). When service dog count ≠ property dog records, show a visible mismatch warning on both the service card and the property card. Clients list dog count comes from property dog records.

### 1.6 Weekly service generates no visits, silently

* Repro: service "Weekly at 11107 Dudley Street, $3.00, prepaid, active, Started 2026-07-15" shows "No upcoming visit scheduled" with no explanation.
* Fix: determine why generation didn't run (prepaid requiring credit? missing preferred weekday? bug). Whatever the rule, the UI must state the reason: e.g. "No visits scheduled — prepaid balance is $0.00" with a resolving action. An active service with zero future visits and no explanation is never acceptable.

### 1.7 Suspicious price has no guardrail

* The $3.00 weekly service is ~91% below the zone price and nothing flags it. Add a soft warning when saved price deviates heavily from zone/standard price (configurable threshold, e.g. ±50%): "This price is 91% below the Taylor zone price. Keep it?" Warn, don't block.

**Stage 1 acceptance**: zone detection matches ZIP-covered properties; zone price panel shows its math; blank/invalid prices show inline errors; zero native dialogs remain; dog counts trace to dog records with mismatch warnings; every active service either has a next visit or a stated reason; large price deviations warn.

## Stage 2 — Information architecture

### 2.1 Add a Communication tab (7 tabs total)

Tabs become: Summary · Properties · Services · Visits · Billing · Communication · Activity.

Communication absorbs the four blocks currently bloating Summary:

* Message thread (full SMS history + composer, recipient preview "Sending to (734) 309-3494", consent/deliverability status, no-business-number empty state)
* Client portal (compact status panel: enabled, last login, verification destination — NOT the raw URL as a content block; actions: Open, Copy link, Regenerate with confirm modal explaining old-link invalidation)
* Review requests (history: not asked / requested date / delivery status; eligibility logic on the send button)
* Referrals (labeled "Referred by" input with client search + code validation, referral status)

Summary keeps only a compact communication card: last message preview, last-contacted date, one "Message" action that deep-links to the tab.

Do NOT add Notes or Dogs tabs. Office/technician notes stay contextual (pinned notes widget on Summary; technician instructions property-scoped). Dogs live under Properties.

### 2.2 URL-addressable tabs

* Verified bug: refresh always resets to Summary.
* Route each tab (`/clients/:id/properties` or `?tab=`), persist on refresh, back/forward works, deep links work. All "View all X" buttons navigate to the tab, not a separate page.

### 2.3 Depth via detail drawers (not new pages)

* Service row click → drawer: full config, visit history for this service, pricing history (price components per PRD), its add-on charges, lifecycle actions.
* Visit row click → drawer: scheduled window vs actual timestamps, technician, status, completion notes, photos, exceptions, invoice status, permission-gated timestamp correction (with reason, logged to Activity).
* Invoice row click → drawer: line items, status, payment attempts.
* Visits tab: once >10 visits, group Upcoming / Past and add status + property filters.

## Stage 3 — Mini design system (build once, all tabs inherit)

Current state reads as a wireframe: uniform light-gray, uniform weight, ~10–11px all-caps labels, nothing scannable. Build these primitives first, then apply per tab.

### 3.1 Layout & density

* Widen the content container to ~1100–1200px max (currently ~520px of usable content on a 1568px viewport — two-thirds of the screen is margin).
* Summary becomes a 2-column grid on desktop: LEFT (operational): alerts, next visit, active services, property summary w/ boundary mini-map. RIGHT (secondary): pinned notes, communication preview, portal status chip, review/referral status. Single column on mobile.

### 3.2 Component taxonomy

* Chips: colored = status (active, paused, scheduled, overdue); neutral outline = metadata (postpaid, Residential, Auto-calculated, Detected automatically). Consistent sentence case. One component, two variants — stop mixing four jobs into one look.
* Buttons: exactly one dark primary per view; secondary = outline; tertiary = text link; destructive = red, and only inside overflow menus or modals — never inline next to Edit. Demote property Archive/Delete and service End into ••• overflow menus.
* Empty states: one template — icon + one-line explanation + action button. Replace all bare centered gray text ("No office notes yet", "No dogs recorded for this property", "No invoices yet").
* Inputs: styled date/time pickers replacing native `mm/dd/yyyy` / `--:-- --` controls. Every input has a visible label and accessible name (fix: the naked "4" beside "Bill next", the `$` add-on fields, the referral input).
* Confirm modal: the styled destructive/unsaved-changes modal from Stage 1.4 is a shared component.

### 3.3 Typography & formatting

* Minimum 12px for labels; darken section-label gray to pass WCAG AA contrast.
* List-row hierarchy: bold title line, right-aligned monetary column, muted metadata second line. Apply to Services rows ("Recurring Pet Waste Removal / Every 2 weeks · 11107 Dudley St · 2 dogs" with "$30.00 /visit" right-aligned + pricing-source chip) and Visits rows.
* Dates humanized everywhere: "Mon, Jul 20" not "2026-07-20". Phone numbers formatted: "(734) 309-3494". Store canonical, display formatted.
* Prices always show unit ("/visit") and pricing-source chip (Standard / Zone / Custom).
* Visits table: replace "-" with human states ("Not started", "Not recorded"); "Unassigned" instead of "-" for tech; add Service column.

### 3.4 Interaction consistency

* Read-only by default everywhere: convert the always-editable inline service-window time inputs on Properties to read-only display ("Anytime" or "8:00 AM – 12:00 PM"), edited via the property drawer.
* Collapse the always-open Add-ons & cross-sells forms behind an "Add add-on" button.
* Collapse Notes/SMS composers to single-line affordances that expand on focus.
* Strong active-tab state: underline or filled pill + `aria-selected` + keyboard navigation.
* Touch targets ≥40px for icon buttons (service row actions, drawer close) — techs will use tablets.

## Stage 4 — Summary alerts & header polish

### 4.1 Attention area at top of Summary

Severity-tiered (critical / warning / info). Trigger from verified current data:

* No email on file while "Send email notifications" is enabled (this exact state exists now — Edit Client shows the box checked with no email)
* No payment method / no Stripe customer
* Prepaid service with $0.00 credit (exists now)
* Active service with no scheduled visits (exists now)
* Service priced far below zone price (exists now: $3.00 vs $35 base)
* No arrival window configured
* No dogs recorded while services bill for dogs (exists now)

### 4.2 Header

* "No email" renders as a warning chip, not plain text.
* Client status derives from service states (Active / Partially paused / Paused / Inactive) — a manual status dropdown must not contradict derived state.
* Expand the ••• menu (currently only "Mark client inactive"): Pause services (with PRD scope-selection flow), Open portal, Copy portal link, Archive client, Delete only when no history.
* Edit Client drawer: split Name into first/last (+ optional company, display-name logic); warn when enabling a notification channel with no corresponding contact info.

## Stage 5 — Activity completeness

Currently logs exactly one event type. Verified today's session produced client creation, two service creations, and price edits — none logged.

* Log per PRD: client/contact edits, property add/edit/archive/delete, boundary changes, zone detect/override, dog changes, service lifecycle (create/edit/pause/resume/end), price changes (with before → after), promotions, notes, messages sent, portal link regenerated, review requests, visit start/complete/corrections, invoices, payments.
* Every entry shows actor + timestamp; meaningful edits show before/after values.
* Fix labels: "Deleted property 5555 (no history)" → full address, plus who did it.

## Verification checklist (run before calling any stage done)

1. Refresh on each tab — tab persists.
2. Edit Service → clear price → Save → inline error appears, nothing saves.
3. Property in a ZIP-covered zone shows the zone on the Properties tab, matching the service drawer.
4. Zone price panel math is reproducible from the Zones page config.
5. `grep` for `confirm(` / `alert(` returns nothing in app code.
6. Add a dog to the property → service dog counts and clients-list count reflect it; remove it → mismatch warning appears.
7. Every active service shows either a next visit or a stated reason.
8. Delete property with history → archive path with explanatory modal; without history → delete modal; both logged with actor.
9. Perform any edit → it appears in Activity with actor and before/after.
10. Keyboard-only pass through tabs, drawers, and modals; labels ≥12px pass AA contrast; all inputs have accessible names.
