-- A refund leaves the invoice honest (#674).
--
-- E1 paid-provision smoke, 2026-11-01: INV-1069 ($60, prepaid top-up) was paid
-- by card and refunded in full from the invoice. The payment went to
-- 'refunded', amount_paid_cents went to 0, and the invoice still said Paid —
-- with nothing on it to say the money had gone back.
--
-- And a PARTIAL refund did the same thing. The Stripe webhook flips a payment
-- to 'refunded' on any refund, and invoice_paid_cents (20261015120000) counted
-- only 'succeeded' rows, so $10 back on a $100 payment took all $100 off what
-- the invoice was paid. An open invoice partly paid and partly refunded showed
-- its whole balance owed again.
--
-- The invoice's STATUS is left alone on purpose. `billedDay` (src/lib/ar.ts)
-- treats a void invoice as never billed, and src/lib/reversals.server.ts
-- already deducts every refund as its own dated contra line. Voiding a
-- refunded invoice would take the sale out of the month it was billed in AND
-- deduct the refund again. What was wrong was the money, so this file fixes
-- the money:
--
--   1. payments.refunded_cents: how much of amount_cents went back to the
--      customer, cumulative. Written by the Stripe webhook from Stripe's own
--      amount_refunded (src/lib/refund-outcome.ts invoicedShareRefunded), so
--      the surcharge and tip shares of a refund do not come off the invoice.
--
--   2. invoices.amount_refunded_cents: the sum of that over the invoice's
--      payments, kept by the same trigger and guard as amount_paid_cents.
--      The screens read it: a paid invoice with money given back says
--      "Refunded" or "Partly refunded" rather than "Paid".
--
--   3. invoice_paid_cents counts what was KEPT: a succeeded payment whole,
--      a refunded payment less what went back. A 'refunded' row with no
--      recorded amount (a lost chargeback, or a refund from before this
--      column) still counts as nothing, exactly as before.
--
--   4. Backfill: refunded_cents from the reversal ledger (review_items
--      'payment_refunded', which holds Stripe's cumulative figure), then the
--      invoices those payments belong to are re-synced by the trigger.
--
-- Replays into an empty database: nothing here needs a tenant, a row or a
-- cron job. Both backfills update whatever rows exist, which on a fresh build
-- is none. Every assertion below is about what this file establishes.

-- ── 1. payments.refunded_cents ─────────────────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS refunded_cents integer NOT NULL DEFAULT 0;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_refunded_cents_nonnegative;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_refunded_cents_nonnegative CHECK (refunded_cents >= 0);

COMMENT ON COLUMN public.payments.refunded_cents IS
  'How much of amount_cents has been refunded to the customer, cumulative. Written by the Stripe webhook (charge.refunded, charge.refund.updated) from Stripe''s amount_refunded. 0 on a refunded row means the amount is not known (a chargeback, or a refund from before 20261102130000), and the whole payment counts as reversed.';

-- ── 2. invoices.amount_refunded_cents ──────────────────────────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS amount_refunded_cents integer NOT NULL DEFAULT 0;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_amount_refunded_cents_nonnegative;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_amount_refunded_cents_nonnegative CHECK (amount_refunded_cents >= 0);

COMMENT ON COLUMN public.invoices.amount_refunded_cents IS
  'Written only by tg_payments_sync_invoice_paid: the sum of the invoice''s payments.refunded_cents. A paid invoice with this above 0 reads as Refunded (amount_paid_cents = 0) or Partly refunded.';

-- ── 3. What was kept, and what went back ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoice_paid_cents(_invoice_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(COALESCE(sum(
           CASE
             WHEN p.status = 'succeeded' THEN p.amount_cents
             -- Refunded with a recorded amount: what is left was kept.
             WHEN p.status = 'refunded' AND p.refunded_cents > 0
               THEN GREATEST(p.amount_cents - p.refunded_cents, 0)
             -- Refunded with none recorded: reversed whole, as before.
             ELSE 0
           END), 0), 0)::integer
    FROM public.payments p
   WHERE p.invoice_id = _invoice_id
     AND p.status IN ('succeeded', 'refunded');
$function$;

REVOKE ALL ON FUNCTION public.invoice_paid_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_paid_cents(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.invoice_refunded_cents(_invoice_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(COALESCE(sum(LEAST(p.refunded_cents, GREATEST(p.amount_cents, 0))), 0), 0)::integer
    FROM public.payments p
   WHERE p.invoice_id = _invoice_id
     AND p.status = 'refunded'
     AND p.refunded_cents > 0;
$function$;

REVOKE ALL ON FUNCTION public.invoice_refunded_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_refunded_cents(uuid) TO service_role;

-- The guard now covers both numbers: a billing role can UPDATE invoices (that
-- is how status flips) and must not be able to set either.
CREATE OR REPLACE FUNCTION public.tg_invoices_guard_amount_paid()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_setting('houndstack.paid_sync', true) IS DISTINCT FROM 'on' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.amount_paid_cents := 0;
      NEW.amount_refunded_cents := 0;
    ELSE
      IF NEW.amount_paid_cents IS DISTINCT FROM OLD.amount_paid_cents THEN
        NEW.amount_paid_cents := OLD.amount_paid_cents;
      END IF;
      IF NEW.amount_refunded_cents IS DISTINCT FROM OLD.amount_refunded_cents THEN
        NEW.amount_refunded_cents := OLD.amount_refunded_cents;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_invoices_guard_amount_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_guard_amount_paid ON public.invoices;
CREATE TRIGGER invoices_guard_amount_paid
  BEFORE INSERT OR UPDATE OF amount_paid_cents, amount_refunded_cents ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoices_guard_amount_paid();

CREATE OR REPLACE FUNCTION public.sync_invoice_amount_paid(_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _paid integer := public.invoice_paid_cents(_invoice_id);
  _refunded integer := public.invoice_refunded_cents(_invoice_id);
BEGIN
  PERFORM set_config('houndstack.paid_sync', 'on', true);
  UPDATE public.invoices
     SET amount_paid_cents = _paid,
         amount_refunded_cents = _refunded
   WHERE id = _invoice_id
     AND (amount_paid_cents IS DISTINCT FROM _paid
          OR amount_refunded_cents IS DISTINCT FROM _refunded);
  PERFORM set_config('houndstack.paid_sync', 'off', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_invoice_amount_paid(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_invoice_amount_paid(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_payments_sync_invoice_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.invoice_id IS NOT NULL THEN
    PERFORM public.sync_invoice_amount_paid(OLD.invoice_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.invoice_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
          OR NEW.refunded_cents IS DISTINCT FROM OLD.refunded_cents) THEN
    PERFORM public.sync_invoice_amount_paid(NEW.invoice_id);
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_payments_sync_invoice_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payments_sync_invoice_paid ON public.payments;
CREATE TRIGGER payments_sync_invoice_paid
  AFTER INSERT OR DELETE OR UPDATE OF status, amount_cents, invoice_id, refunded_cents ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_sync_invoice_paid();

-- ── 4. Backfill ────────────────────────────────────────────────────────────
-- The ledger row's `revenue_cents` is the part of Stripe's cumulative refund
-- that came off revenue: the surcharge, tip and sales-tax shares already
-- taken out by refund-split.ts. amount_cents is revenue + tax, so the
-- invoiced share is that revenue grossed back up by the payment's own tax
-- ratio, and all of the revenue back is all of amount_cents. A row filed
-- before the split existed has no revenue_cents; amount_cents stands in, as
-- reversals.server.ts reads it, because those predate pass-through. (Built
-- from the ledger's split rather than from the payment's tip, which no SQL
-- money path reads: tests/a-customer-could-not-leave-a-tip.test.ts.)
--
-- The update fires payments_sync_invoice_paid, which re-syncs each invoice.
-- touch_invoices is held off so updated_at keeps meaning "a person or a
-- process changed this invoice", as in 20261015120000.
ALTER TABLE public.invoices DISABLE TRIGGER touch_invoices;

UPDATE public.payments p
   SET refunded_cents = LEAST(
         GREATEST(p.amount_cents, 0),
         CASE
           WHEN r.revenue >= p.amount_cents - COALESCE(p.tax_cents, 0)
             THEN GREATEST(p.amount_cents, 0)
           ELSE round(
                  r.revenue * p.amount_cents
                  / NULLIF(p.amount_cents - COALESCE(p.tax_cents, 0), 0)
                )::integer
         END)
  FROM (
    SELECT ri.subject_id,
           max(COALESCE(ri.detail->>'revenue_cents', ri.detail->>'amount_cents')::numeric) AS revenue
      FROM public.review_items ri
     WHERE ri.kind = 'payment_refunded'
       AND ri.subject_id IS NOT NULL
     GROUP BY ri.subject_id
  ) r
 WHERE r.subject_id = p.id
   AND p.status = 'refunded'
   AND p.refunded_cents = 0
   AND p.amount_cents > 0
   AND p.amount_cents > COALESCE(p.tax_cents, 0)
   AND r.revenue > 0;

ALTER TABLE public.invoices ENABLE TRIGGER touch_invoices;

-- ── What this file establishes ─────────────────────────────────────────────
DO $post$
DECLARE _trg text; _src text; _n integer;
BEGIN
  SELECT pg_get_triggerdef(t.oid) INTO _trg
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.payments'::regclass
     AND t.tgname = 'payments_sync_invoice_paid';
  IF _trg IS NULL OR _trg NOT LIKE '%refunded_cents%' THEN
    RAISE EXCEPTION 'payments_sync_invoice_paid does not fire on refunded_cents: %', _trg;
  END IF;

  SELECT pg_get_triggerdef(t.oid) INTO _trg
    FROM pg_trigger t
   WHERE t.tgrelid = 'public.invoices'::regclass
     AND t.tgname = 'invoices_guard_amount_paid';
  IF _trg IS NULL OR _trg NOT LIKE '%amount_refunded_cents%' THEN
    RAISE EXCEPTION 'invoices_guard_amount_paid does not guard amount_refunded_cents: %', _trg;
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.invoice_paid_cents(uuid)'::regprocedure;
  IF _src NOT LIKE '%p.amount_cents - p.refunded_cents%' THEN
    RAISE EXCEPTION 'invoice_paid_cents does not keep the unrefunded part of a refunded payment';
  END IF;

  -- After the backfill no invoice disagrees with its ledger. On a fresh build
  -- there are no invoices and this counts zero, which is also true.
  SELECT count(*) INTO _n
    FROM public.invoices i
   WHERE i.amount_paid_cents IS DISTINCT FROM public.invoice_paid_cents(i.id)
      OR i.amount_refunded_cents IS DISTINCT FROM public.invoice_refunded_cents(i.id);
  IF _n > 0 THEN
    RAISE WARNING '% invoice(s) disagree with their payments after the refund backfill; re-sync with sync_invoice_amount_paid', _n;
  END IF;
END
$post$;
