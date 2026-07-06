# Wrap-Up Plan

Five focused batches to get the platform ship-ready. Each is independent; I'll do them in order.

## 1. Cron scheduling
Schedule the three existing endpoints via `pg_cron` + `pg_net` so automation runs unattended:
- `POST /api/public/hooks/announcement-emails` — every 15 min
- `POST /api/public/hooks/nightly` — daily 2:00 AM UTC
- `POST /api/public/hooks/weekly-digest` — Mondays 8:00 AM UTC

Uses the stable `project--{id}.lovable.app` URL and the anon `apikey` header (canonical pattern — no new secret).

## 2. Suspension side-effects
- New `SuspensionBanner` mounted in `_authenticated/route.tsx` above content.
- Reads `plan_status` via `getBillingStatus`; shows:
  - `past_due` → yellow warning "Payment failed — update card" + link to `/billing`
  - `canceled` → red banner "Subscription canceled — reactivate to keep adding clients"
- No hard lockout; the client-limit gate in `createBillingCheckout`/client-add flow already enforces access.

## 3. Tenant detail admin actions
On `platform.tenants.$id.tsx`, add action buttons (owner/platform_admin only) that call new server fns in `platform-tenant.functions.ts`:
- **Force plan change** — set `plan_status` to `active`/`free`/`past_due`/`canceled` with audit log entry.
- **Add credit** — insert into `credit_ledger` with reason + admin note.
- **Suspend / Reactivate** — toggles `plan_status` = `canceled` / `active`, writes audit.
- **Impersonate** — generates a short-lived magic link via Supabase admin; opens in new tab. (Uses `supabaseAdmin.auth.admin.generateLink`.)

Every action writes to `platform_admin_audit` with `actor_id`, `action`, `target_org_id`, `payload`.

## 4. Signup requests & invites
On `platform.signup-requests.tsx` and `platform.invites.tsx`:
- **Approve signup request** — creates organization + owner invite via existing `enqueueAppEmail` (`invite` template), marks request approved, audit entry.
- **Reject signup request** — sets status + optional reason, audit entry.
- **Resend invite** — bumps `expires_at`, re-enqueues invite email.
- **Revoke invite** — sets status to `revoked`, audit entry.

## 5. Polish
- Empty states on Announcements, Coupons, Invoices, Users (using `EmptyState` component that already exists).
- Loading skeletons on tenant list + tenant detail.
- Confirm `errorComponent` + `notFoundComponent` present on all `_authenticated/*` and `platform.*` routes; add where missing.

## Technical notes
- All new server fns use `requireSupabaseAuth` + explicit `has_role(_user_id, 'platform_admin')` check before privileged writes.
- `supabaseAdmin` loaded via `await import()` inside handlers (never top-level in `.functions.ts`).
- Cron scheduling goes through `supabase--insert` on `cron.job` (not migration, per guidance).
- No new secrets required — platform Stripe keys are already saved.

## Out of scope (this pass)
- Stripe test-mode E2E verification (do after cron is live).
- Full mobile pass beyond tenants list (already done).
- Analytics/observability dashboards.

Say **go** and I'll execute batches 1→5 in order.