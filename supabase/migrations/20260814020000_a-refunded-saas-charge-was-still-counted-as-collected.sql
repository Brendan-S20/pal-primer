-- `charge.refunded` is enabled on the live platform webhook endpoint and has
-- no handler. A refunded HoundStack subscription charge is counted as
-- collected, for ever.
--
-- ── HOW IT WAS FOUND ──────────────────────────────────────────────────────
--
-- `tests/the-connect-webhook-handles-what-it-subscribes-to.test.ts` already
-- names this failure mode in its own header:
--
--     "SUBSCRIBED BUT UNHANDLED. The Stripe dashboard decides which events are
--      delivered; this file decides which are acted on. Nothing connects the
--      two, so an event can be enabled in the dashboard for months while the
--      handler that was supposed to read it does not exist — the endpoint
--      returns 200 and everything looks healthy."
--
-- It pins seven events on the CONNECT endpoint, each with the consequence of
-- its absence. It never pinned the PLATFORM endpoint's list at all — it only
-- checks that endpoint's webhook secret has no fallback.
--
-- Read from the live account, the platform endpoint
-- (we_1U0SFdQjJFmqXgZD3yF8GRzZ) enables THIRTEEN events. Twelve have a `case`.
-- `charge.refunded` does not, and the switch has no `default`, so the event is
-- recorded, stamped `processed_at`, and answered 200 — indistinguishable from
-- one that was acted on.
--
-- ── WHY IT MATTERS, CONCRETELY ────────────────────────────────────────────
--
-- Stripe does not reduce `invoice.amount_paid` when a charge is refunded. The
-- invoice stays `paid` at its full amount and the refund lives on the charge.
-- So with nothing reading `charge.refunded`:
--
--   * `collectedMtdCents` on /platform — "SaaS collected this month" — sums
--     `amount_paid_cents` and therefore counts money that was given back.
--   * `listPlatformInvoices`, the tenant's own billing history in Settings →
--     Billing, shows the invoice paid in full with no sign of the refund. The
--     customer who was refunded sees no record of it on the page that exists
--     to tell them what they were charged.
--
-- Accounts receivable is NOT affected and is deliberately left alone: it reads
-- only `open` and `uncollectible` invoices, and a refunded invoice is `paid`.
--
-- ── WHY A COLUMN RATHER THAN NETTING amount_paid_cents ────────────────────
--
-- Because this repo has already had the other version of this bug.
-- 20260804080000_the-rollup-and-the-dashboard-netted-refunds-differently made
-- the point: when refunds are folded into one number, two screens derive it
-- two ways and disagree, and there is no way to tell which is wrong because
-- the gross figure is gone. `refunded_cents` keeps gross and returned as
-- separate facts, so every reader nets them the same way and a contra line
-- stays possible without another migration.
--
-- Both columns are additive with defaults, so every existing row keeps its
-- current meaning: nothing has ever been refunded on this account.
--
-- ── WHAT IS AND IS NOT SHIPPED WITH THIS ──────────────────────────────────
--
-- These columns, and the readers that net by them, ARE shipped:
-- `collectedNetCents` in platform-metrics.ts nets refunds into both the
-- headline "SaaS collected this month" and the twelve-month chart, through one
-- shared function so the two cannot derive it differently, and Settings →
-- Billing renders the contra line.
--
-- The `charge.refunded` HANDLER is NOT. At the pinned API version
-- (2026-07-29.dahlia) a `Charge` has no `invoice` field — only
-- `payment_intent` — and a `PaymentIntent` has no `invoice` either. The link
-- runs Invoice → `payments[]` → `payment.payment_intent`, i.e. outward from the
-- invoice, which is the wrong direction for a handler that starts from a
-- charge. A first attempt read `charge.invoice`, which the type checker
-- rejected and which would have recorded nothing for ever while looking
-- correct.
--
-- Doing it properly needs either the payment intent stored on this table when
-- the invoice row is written, or a bounded invoice lookup at refund time — and
-- the live platform account has ZERO invoices, so neither the real payload
-- shape nor the fix can be checked against anything. Shipping an unverified
-- guess on a money path is how the first attempt went wrong.
--
-- So `refunded_cents` reads 0 until that handler exists. The gap is recorded,
-- with this reasoning, in
-- tests/the-connect-webhook-handles-what-it-subscribes-to.test.ts.

ALTER TABLE public.platform_invoices
  ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz;

COMMENT ON COLUMN public.platform_invoices.refunded_cents IS
  'Total refunded against this invoice''s charge, in cents. Kept separate from '
  'amount_paid_cents on purpose: netting them into one number is what '
  '20260804080000 had to undo on the tenant side, because two screens then '
  'derived the same figure differently with the gross amount no longer '
  'recoverable. Reads 0 until the charge.refunded handler exists — see the note
   at the top of this migration for why that handler is not shipped with it.';

COMMENT ON COLUMN public.platform_invoices.refunded_at IS
  'When the most recent refund against this invoice landed. Null means none.';

-- A refund cannot exceed what was paid, and cannot be negative. This is the
-- kind of thing that is obvious until a partial-refund handler adds instead of
-- setting and the number climbs past the charge on the third retry — Stripe
-- redelivers for up to three days.
ALTER TABLE public.platform_invoices
  DROP CONSTRAINT IF EXISTS platform_invoices_refunded_within_paid;
ALTER TABLE public.platform_invoices
  ADD CONSTRAINT platform_invoices_refunded_within_paid
  CHECK (refunded_cents >= 0 AND refunded_cents <= amount_paid_cents);
