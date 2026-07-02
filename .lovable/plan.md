# Roadmap: UX & Feature Overhaul

Grouped into focused sessions so we can ship, review, and iterate. Order reflects dependencies and highest-pain-first.

---

## Session A — Roles & Permissions (foundation)
Fix the "everyone sees everything" problem before layering new features on top.

- Enforce role-based route guards in `_authenticated/route.tsx` (owner, office_manager, dispatcher, tech).
- Techs → only `/my-day`, own visits, own client info (read-only, hazard-aware).
- Dispatchers → routes, today, clients (no billing/settings).
- Office managers → all except org settings & user management.
- Owners → everything + new **Users & Roles** page (`/settings/users`) to invite, assign roles, deactivate.
- Sidebar filtered by role; deep links guarded server-side too.
- Fix the "Not authorized" error when reassigning visits (RPC call is missing the org_id arg — `reassign_visit(_visit_id, _staff_id)` has a `can_write_org()` check without a passed org, causing the current failure).

---

## Session B — Clients: detail, filters, richer onboarding
- **List page**: search, filters (status, account type, zone, autopay, balance owed, tags), saved views, column chooser, CSV export.
- **Detail redesign**: sticky header with balance/next visit/lifetime value; tabs already exist (Overview/Service/Billing) — add **Dogs**, **Properties**, **Photos**, **Activity timeline** (visits, invoices, messages, emails).
- **New client wizard** (multi-step): contact → property (address autocomplete + map pin) → dogs (name, breed, size, temperament, photo) → service preferences (frequency, preferred day/time, gate/access) → pricing preview → confirm.
- Client-portal: let clients upload dog photos & names themselves; surface in tech My Day and route drawer.

---

## Session C — Auto-pricing engine
- Pricing rules per org: base price by yard size bucket (S/M/L/XL) + per-dog surcharge + frequency multiplier + zone modifier + initial cleanup fee.
- Yard-size estimator: polygon sketch on Google Map during onboarding (see Session D) → sq ft → bucket auto-assigned.
- Quote preview in wizard, signup flow, and portal upsells.
- Remove "type any price" as default; keep manual override behind an "Adjust" toggle with reason field.

---

## Session D — Zones by ZIP / radius / drawn polygon
- Drop lat/long from zone creation UX.
- Zone builder modes: (1) list of ZIPs, (2) center address + radius miles, (3) polygon drawn on map.
- Store as `postal_codes text[]`, `center + radius_km`, or `boundary geography(polygon)` (PostGIS).
- Auto-assign client → zone at address entry.
- Show zones as colored overlays on Today/Routes map.

---

## Session E — Tech route actions + property mapping
- On `/routes` (Today map): tap pin → open the same **VisitDetailDrawer** the tech uses, with Complete / Skip / Photo capture buttons, "Add dog" shortcut, and directions.
- Photo capture parity with My Day (native camera + offline queue).
- **Property boundary sketch**: on client/property detail, dispatcher or tech draws yard boundary on satellite map → stored polygon → sq ft calculated → feeds pricing engine and shows on tech view so they know what to service.

---

## Session F — Promotions & gift cards
- `promo_codes` table: percent/fixed, first-visit or recurring N cycles, per-code cap, expiry.
- `gift_cards` table: code, initial balance, remaining balance, purchaser, recipient email, redemption ledger.
- Public purchase page `/gift` (Stripe Checkout) → emails recipient a redeemable code.
- Apply at signup, portal, and invoice creation; credit ledger integration.
- Admin UI under Settings → Promotions.

---

## Session G — Weather × Routes intertwined
- Weather panel embedded directly in Today/Routes (not a separate page).
- Per-visit weather badge (rain %, temp, wind) on route cards & map pins.
- One-click "Reschedule flagged visits" from the route view.
- Auto-suggest tomorrow's re-route when today's forecast triggers cancellations.

---

## Session H — Dashboard revamp
- KPI row: active clients, MTD revenue, AR open, visits today (completed/total), churn risk count.
- **Today map** front and center with all tech routes, live status colors, click → visit drawer.
- Alerts strip: weather warnings, overdue invoices, unassigned visits, failed payments.
- Onboarding checklist collapses once complete.

---

## Session I — Platform Admin (superadmin)
- Separate `platform_admins` table (not per-org roles) + `is_platform_admin()` security-definer.
- New route tree `/admin/*` gated by that check, hidden from every normal user.
- Screens: Organizations list (plan, MRR, active clients, last activity, Stripe status), Users search across orgs, Impersonate (audit-logged), Signups funnel, Revenue overview, Feature flags, System health (email queue, cron jobs, error rate).
- Audit log table for all superadmin actions.

---

### Suggested execution order
A → B → C → D → E → G → H → F → I

Sessions A, B, D, E, H are the highest daily-use impact. C depends on D (yard sketching). I is last because it's internal-only.

### Technical notes
- Zones polygon storage needs PostGIS enabled — will add in Session D migration.
- Property sketch reuses Google Maps Drawing library (already have Maps connector).
- Role guards use existing `has_role()` + a new `require_role()` server-fn middleware.
- Reassign bug fix ships in Session A regardless.

Reply with which session to start (default: **A**), or adjust ordering/scope.