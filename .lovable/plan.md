# Session 4 — Stripe billing (split into 3 sub-sessions)

Using **BYOK Stripe** per your choice. You'll paste a `STRIPE_SECRET_KEY` (use a **test-mode** key like `sk_test_…`) after I enable the integration.

## Session 4a — Postpaid client invoicing (this turn)

Bill end customers for **completed** visits after the fact. Simplest path, unlocks real money movement.

**DB migration**
- `invoices` (org_id, client_id, period_start, period_end, subtotal_cents, total_cents, status: `draft|open|paid|void|uncollectible`, stripe_invoice_id/checkout_session_id, issued_at, paid_at)
- `invoice_line_items` (invoice_id, visit_id, subscription_id, description, amount_cents)
- `payments` (org_id, invoice_id, amount_cents, stripe_payment_intent_id, status, paid_at)
- GRANTs + org-scoped RLS on all three. Writes gated by `can_write_org`; techs read-only.
- FK `visits.invoice_line_item_id` (nullable) so a completed visit is billed at most once.

**Server functions (`createServerFn` + `requireSupabaseAuth`)**
- `generate_invoice_for_client(client_id, through_date)` — SQL fn: sums `subscription.price_cents` for that client's completed, unbilled visits with `completed_at <= through_date`, creates invoice + line items in one tx, links visits.
- `generate_invoices_for_org(through_date)` — walks all active clients with unbilled completed visits and calls the above.
- `create_stripe_checkout_for_invoice(invoice_id)` — server-only, uses `STRIPE_SECRET_KEY`, creates a Checkout Session (mode=payment) with `client_reference_id = invoice.id`, stores `stripe_checkout_session_id`, returns URL.
- `void_invoice(invoice_id)`.

**Webhook** — server route at `/api/public/hooks/stripe` verifies `Stripe-Signature` with `STRIPE_WEBHOOK_SECRET`, handles `checkout.session.completed` and `payment_intent.succeeded` → sets invoice to `paid`, inserts `payments` row (via admin client after signature verified).

**Admin UI**
- `/invoices` — list with status badges, totals, "Generate invoices" action (pick through-date).
- `/invoices/$id` — detail: line items (visit date + property + subscription desc), totals, actions: **Send/Pay** (opens Stripe Checkout URL), **Void**.
- Client detail → "Unbilled visits" panel + one-click "Generate invoice".

## Session 4b — Prepaid billing (next)

- `subscriptions.billing_cadence` already exists (`prepaid`/`postpaid`); wire it up.
- For prepaid: charge on subscription start / renewal cycle, credit generates a `prepaid_balance`, visits draw down instead of creating an invoice per period.
- Optional skip-reason billing rules (spec §7).

## Session 4c — Org SaaS tier billing (last)

- Add `billing_tier` computed from `organizations.active_client_count`: free ≤3, paid at 4+ (per-active-client price).
- Stripe Product/Price in test mode, per-seat quantity = `active_client_count`.
- Stripe subscription on the org, updated when count changes (trigger already maintains the count).
- Grace period + block-writes-when-past-due policy.

## Immediate action

1. Enable Stripe BYOK — you'll get a form to paste `STRIPE_SECRET_KEY` (use a **test** key).
2. On approval I run the 4a migration.
3. Then I write the server fns, webhook route, and admin UI, and add `STRIPE_WEBHOOK_SECRET` via a second secret request.

Reply "go" to proceed with 4a.