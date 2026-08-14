-- The other half of 20260814020000: give a refund a way to find its invoice.
--
-- ── WHERE THIS LEFT OFF ───────────────────────────────────────────────────
--
-- That migration added `platform_invoices.refunded_cents` / `refunded_at` and
-- taught every reader to net by them, and deliberately shipped WITHOUT the
-- `charge.refunded` handler, because the handler could not be written
-- correctly:
--
--     At the pinned API version (2026-07-29.dahlia) a `Charge` has no
--     `invoice` field — only `payment_intent` — and a `PaymentIntent` has no
--     `invoice` either.
--
-- A first attempt read `charge.invoice`. The type checker rejected it, and the
-- six tests written for it passed anyway, because the fixture had invented the
-- field. So the handler was removed and the gap recorded rather than guessed
-- at.
--
-- ── WHAT MAKES IT WRITABLE NOW ────────────────────────────────────────────
--
-- Reading the SDK's types rather than assuming. The link exists, it just runs
-- the other way:
--
--     Invoice.payments?: ApiList<InvoicePayment>
--     InvoicePayment.payment.payment_intent?: string | PaymentIntent
--     InvoicePayment.payment.type: 'charge' | 'payment_intent' | 'payment_record'
--     Charge.payment_intent: string | PaymentIntent | null
--
-- An invoice knows its payment intent; a charge knows its payment intent;
-- nothing points from a charge to an invoice. So the join has to be stored at
-- invoice time and read at refund time, which is what this column is for.
--
-- Every field named above is one the installed types actually declare. That is
-- the difference between this and the first attempt.
--
-- ── WHY IT IS NULLABLE, AND WHY THAT IS NOT A GET-OUT ─────────────────────
--
-- `Invoice.payments` is optional in the API — it may not be present on a
-- webhook payload — and the live platform account has zero invoices, so
-- whether it arrives populated cannot be checked here against real data.
--
-- Rather than guess, the handler is built to work either way: it matches on
-- this column first, and when the column is null it falls back to a bounded
-- `invoices.list({ customer, expand: ['data.payments'] })` to find the invoice
-- whose payment intent matches the refunded charge, then backfills this column
-- so the lookup happens once. If BOTH fail it logs the charge and the payment
-- intent rather than returning quietly, so an unlinked refund is a line in the
-- logs and not a silently wrong revenue figure.

ALTER TABLE public.platform_invoices
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text;

COMMENT ON COLUMN public.platform_invoices.stripe_payment_intent_id IS
  'The PaymentIntent that paid this invoice, captured from Invoice.payments at '
  'invoice time. It exists because nothing on a Stripe Charge points back to an '
  'invoice — this is the only join a charge.refunded handler has. Null on rows '
  'written before this column, and on invoices whose payload carried no '
  'payments list; the handler backfills those from a bounded invoices.list.';

-- The refund handler looks a row up by this and nothing else, so it is the
-- one access path that matters. Partial because most rows have it null and
-- a null is never searched for.
CREATE INDEX IF NOT EXISTS platform_invoices_payment_intent_idx
  ON public.platform_invoices (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
