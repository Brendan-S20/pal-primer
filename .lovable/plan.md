
## Session 1 scope (from CLAUDE.md)

Repo scaffolding + Supabase schema for the core relational spine (Organization, Location, Staff, Client, Property, Dog, Subscription with residential/commercial discriminator), basic RLS, and a bare admin shell that can create/list clients. No scheduling, billing, mobile, or AI yet.

## Stack note — one deviation to confirm

CLAUDE.md specifies Next.js for the admin web. This Lovable project is scaffolded on **TanStack Start (React 19 + Vite)** with **Lovable Cloud** (Supabase under the hood — same Postgres/Auth/RLS/Edge Functions, no external account needed). Rebuilding as Next.js would mean throwing away the scaffold. I'll build the admin on TanStack Start; the DB, auth, RLS, and Stripe/Twilio/etc. plans are unaffected because the backend is still Supabase. Mobile (Expo RN) stays as planned in later sessions. Flag if you'd rather I swap frameworks.

## What I'll build this session

### 1. Enable Lovable Cloud
Provisions Supabase (Postgres + Auth + RLS). No user action required.

### 2. Database migration — core spine

Enums:
- `account_type`: `residential` | `commercial`
- `staff_role`: `owner` | `office_manager` | `dispatcher` | `tech`
- `subscription_status`: `active` | `paused` | `canceled`
- `billing_cadence`: `prepaid` | `postpaid`
- `dog_temperament`: `friendly` | `nervous` | `aggressive` | `unknown`
- `app_role` (separate roles table pattern): `owner` | `office_manager` | `dispatcher` | `tech`

Tables (all in `public`, all with GRANTs + RLS + `has_role`-style scoping via `organization_id`):

- `organizations` — id, name, created_at, `active_client_count int not null default 0` (maintained value, per non-negotiable #3), `billing_tier` (nullable, computed later)
- `locations` — id, organization_id, name, address fields
- `staff` — id, organization_id, location_id (nullable), user_id (→ auth.users), role (`staff_role`), display_name, active
- `user_roles` — id, user_id, organization_id, role (`app_role`), unique(user_id, organization_id, role) — separate from `staff` for the security-definer `has_role(user, org, role)` pattern
- `clients` — id, organization_id, `account_type` (`residential`|`commercial`, **NOT NULL from day one**), display_name, primary_email, primary_phone, active bool, created_at
- `properties` — id, client_id, address fields, `gate_code text`, `lock_box_code text`, `key_location text`, `parking_notes text`, `access_notes text`, `invisible_fence bool default false`, `escape_risk bool default false`, `dog_in_yard_during_service bool default false` (structured hazard fields, per non-negotiable #2 — no single free-text dumping ground)
- `dogs` — id, property_id, name, breed, weight_class, temperament (`dog_temperament`), notes
- `subscriptions` — id, client_id, property_id, `account_type` (`residential`|`commercial`) discriminator column mirrored here so a CHECK constraint can enforce the right pricing shape, frequency (weekly/biweekly/etc. as text or enum), price_cents int, `billing_cadence`, `dog_count int` (residential), `unit_count int` (commercial), zone_id (nullable — zones land in a later session), status (`subscription_status`), started_on date

CHECK constraint on `subscriptions`: residential rows require `dog_count`, commercial rows require `unit_count` — enforces the discriminator has teeth from migration #1.

Trigger: `active_client_count` on `organizations` maintained via insert/update/delete triggers on `clients` (where `active = true`).

### 3. RLS + grants

- `has_role(user_id, org_id, role)` security-definer function reading from `user_roles`.
- Every table: `GRANT SELECT/INSERT/UPDATE/DELETE ON <table> TO authenticated; GRANT ALL TO service_role;` (no anon — this is an internal admin app).
- Policies scope all reads/writes to rows where `organization_id = <caller's org via user_roles>`. `clients`/`properties`/`dogs`/`subscriptions` join through their parent for the org check.
- Owners/office managers can write everything in their org; techs read-only for now (write policies land with the tech app).

### 4. Admin shell (TanStack Start)

- Root layout with app title updated from "Lovable App" → "Scoop CRM" (placeholder, per decision #6 — kept in one config constant `APP_NAME` so it's easy to rebrand).
- `/auth` — email/password sign in/up (Lovable Cloud auth). First user of a new org becomes `owner`.
- `_authenticated` layout gates the rest.
- `/` — dashboard placeholder with org name + active client count.
- `/clients` — list view (table: name, account type badge, email, phone, active).
- `/clients/new` — create form: account type (residential/commercial radio), display name, email, phone. Creates `clients` row scoped to caller's org.
- `/clients/$clientId` — read-only detail with property/dog/subscription sections stubbed as "coming next session" so the routes exist but don't pretend to work.

Data loading via TanStack Query + `createServerFn` with `requireSupabaseAuth`, per the project's server-function rules.

### 5. Not in scope this session (deferred)

Zones, visit generation, routing, Stripe billing, tech mobile app, importers, AI receptionist, weather, cross-sells. All hang off the spine built here.

## Deliverables checklist

- [ ] Lovable Cloud enabled
- [ ] Migration creating enums, tables, GRANTs, RLS, `has_role`, active-client-count trigger, residential/commercial CHECK
- [ ] Auth pages + `_authenticated` gate
- [ ] Clients list + create + detail-stub routes wired to server functions
- [ ] Placeholder home replaced; head metadata set to real title/description
- [ ] Build passes

Reply "go" to implement, or push back on the framework note / any schema field first.
