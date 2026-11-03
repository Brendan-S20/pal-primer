-- A deposit is part payment of its stay (#653, part 2; decision D3).
--
-- Brendan, 2026-11-02: a deposit is a PARTIAL PAYMENT of its stay invoice,
-- not a credit. Until this file a stay deposit was its own prepaid_topup
-- invoice. Paid, tg_invoice_paid_credit posted it to the credit ledger, and
-- it came off the stay only if something later applied that credit. So the
-- audit's December stay read $500 owed beside a $150 deposit, both open, both
-- counted as billed, both in AR, and the portal said "$1,050".
--
-- The deposit invoice stays: it is how the client is asked for the money,
-- and every way of paying an invoice (the portal, the pay link, a saved card,
-- Record payment, a field collection) already works on it. What changes is
-- what it IS:
--
--   1. invoices.deposit_for_invoice_id: the stay invoice this deposit is part
--      of. Set when a stay is invoiced (a trigger on stays, so every path that
--      invoices a stay is covered), and backfilled for every deposit not yet
--      paid. A paid deposit from before this file is left as it was: its money
--      is already account credit, and moving it again would count it twice.
--
--   2. The stay invoice's amount_paid_cents counts its deposit's payments.
--      invoice_paid_cents / invoice_refunded_cents add them, and the payments
--      trigger re-syncs the stay invoice whenever a deposit's payment moves.
--      So every balance in the product (the portal, the pay page, autopay,
--      Record payment's cap, the sitter's card, AR) is the stay's price less
--      what has been paid on it, deposit included, with no reader changed.
--      A deposit that pays the whole stay marks the stay invoice paid.
--
--   3. A linked deposit is not credit. tg_invoice_paid_credit posts nothing
--      for it, and reverse_prepaid_credit_for_payment takes nothing back when
--      one is refunded (there is nothing to take back).
--
--   4. A deposit follows its stay invoice. Stay invoice paid: an unpaid
--      deposit is voided (it has been paid as part of the whole). Stay invoice
--      voided, or stay canceled while its invoice is unpaid: the deposit is
--      released (unlinked) and, if it was paid, its money becomes account
--      credit, which is exactly what a paid deposit was before this file. So
--      the cancellation rule (20261024080900 and 081100: refundable window,
--      kept deposit as a cancellation fee, the office override) runs on the
--      same money it always did, unchanged.
--
-- franchise_rollup's open AR is re-issued in 20261102160500, and giving back
-- cash or a check (F-09) is 20261102161000.
--
-- The TypeScript readers (src/lib/ar.ts) leave linked deposits out of AR,
-- aging and billed revenue the same way. Cash received is unchanged: the
-- deposit's payment is counted once, on the day it arrived.
--
-- Replays into an empty database: a column, functions and triggers; the
-- backfill updates whatever rows exist, which on a fresh build is none.

-- ── 1. The link ─────────────────────────────────────────────────────────────
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS deposit_for_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;
ALTER TABLE public.invoices DROP CONSTRAINT IF EXISTS invoices_deposit_is_not_itself;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_deposit_is_not_itself CHECK (deposit_for_invoice_id IS DISTINCT FROM id);
CREATE INDEX IF NOT EXISTS invoices_deposit_for_idx
  ON public.invoices(deposit_for_invoice_id) WHERE deposit_for_invoice_id IS NOT NULL;

COMMENT ON COLUMN public.invoices.deposit_for_invoice_id IS
  'Set on a stay deposit: the stay invoice it is part payment of (decision D3, #653). Its payments count toward that invoice''s amount_paid_cents, and it is left out of AR and billed revenue. NULL on every other invoice, and on a deposit released by a void or a cancel. Migration 20261102160000.';

-- Nobody signed in sets or moves it: it is decided by the stay.
CREATE OR REPLACE FUNCTION public.tg_invoices_guard_deposit_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF current_user IN ('authenticated', 'anon')
     AND NEW.deposit_for_invoice_id IS DISTINCT FROM
         (CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.deposit_for_invoice_id END) THEN
    RAISE EXCEPTION 'A deposit is linked to its stay by the booking, not by hand.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_invoices_guard_deposit_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_guard_deposit_link ON public.invoices;
CREATE TRIGGER invoices_guard_deposit_link
  BEFORE INSERT OR UPDATE OF deposit_for_invoice_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoices_guard_deposit_link();

-- ── 2. What was paid on a stay invoice includes its deposit ────────────────
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
   WHERE (p.invoice_id = _invoice_id
          -- A deposit is part payment of the stay invoice it is linked to.
          OR p.invoice_id IN (SELECT d.id FROM public.invoices d
                               WHERE d.deposit_for_invoice_id = _invoice_id))
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
   WHERE (p.invoice_id = _invoice_id
          OR p.invoice_id IN (SELECT d.id FROM public.invoices d
                               WHERE d.deposit_for_invoice_id = _invoice_id))
     AND p.status = 'refunded'
     AND p.refunded_cents > 0;
$function$;

REVOKE ALL ON FUNCTION public.invoice_refunded_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_refunded_cents(uuid) TO service_role;

-- Re-sync a stay invoice after its deposit's money moved, and mark it paid if
-- that settled it. Only ever reached from the triggers below.
CREATE OR REPLACE FUNCTION public.sync_stay_invoice_for_deposit(_stay_invoice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
BEGIN
  IF _stay_invoice_id IS NULL THEN RETURN; END IF;
  PERFORM public.sync_invoice_amount_paid(_stay_invoice_id);
  SELECT * INTO _inv FROM public.invoices WHERE id = _stay_invoice_id;
  IF _inv.status = 'open'
     AND COALESCE(_inv.total_cents, 0) - COALESCE(_inv.credit_applied_cents, 0)
         - COALESCE(_inv.amount_paid_cents, 0) <= 0 THEN
    UPDATE public.invoices SET status = 'paid', paid_at = COALESCE(paid_at, now()), updated_at = now()
     WHERE id = _inv.id AND status = 'open';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.sync_stay_invoice_for_deposit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_stay_invoice_for_deposit(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_payments_sync_invoice_paid()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.invoice_id IS NOT NULL THEN
    PERFORM public.sync_invoice_amount_paid(OLD.invoice_id);
    -- A deposit's payment is also its stay invoice's.
    PERFORM public.sync_stay_invoice_for_deposit(
      (SELECT d.deposit_for_invoice_id FROM public.invoices d WHERE d.id = OLD.invoice_id));
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.invoice_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
          OR NEW.refunded_cents IS DISTINCT FROM OLD.refunded_cents) THEN
    PERFORM public.sync_invoice_amount_paid(NEW.invoice_id);
    PERFORM public.sync_stay_invoice_for_deposit(
      (SELECT d.deposit_for_invoice_id FROM public.invoices d WHERE d.id = NEW.invoice_id));
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_payments_sync_invoice_paid() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payments_sync_invoice_paid ON public.payments;
CREATE TRIGGER payments_sync_invoice_paid
  AFTER INSERT OR DELETE OR UPDATE OF status, amount_cents, invoice_id, refunded_cents ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_sync_invoice_paid();

-- ── 3. A linked deposit is not credit ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_invoice_paid_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' AND NEW.kind = 'prepaid_topup'
     -- A stay deposit is part payment of its stay invoice (D3), not credit.
     AND NEW.deposit_for_invoice_id IS NULL THEN
    -- total - tax: each prepaid visit debits its pre-tax price, so the tax
    -- is not spendable credit. Identical to total_cents when there is no tax.
    PERFORM public.post_credit_entry(
      NEW.organization_id, NEW.client_id, NEW.total_cents - COALESCE(NEW.tax_cents, 0),
      'prepayment', NEW.id, NULL, 'Prepaid invoice payment'
    );
  END IF;
  RETURN NEW;
END; $function$;

REVOKE ALL ON FUNCTION public.tg_invoice_paid_credit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reverse_prepaid_credit_for_payment(_payment_id uuid, _refunded_cents bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid; _client uuid; _inv uuid; _kind text; _granted bigint;
  _total bigint; _tax bigint; _linked uuid;
  _target bigint; _already bigint; _delta bigint;
BEGIN
  SELECT p.organization_id, i.client_id, p.invoice_id, i.kind::text,
         i.total_cents, COALESCE(i.tax_cents, 0), i.deposit_for_invoice_id
    INTO _org, _client, _inv, _kind, _total, _tax, _linked
    FROM public.payments p
    JOIN public.invoices i ON i.id = p.invoice_id
   WHERE p.id = _payment_id;

  -- A linked stay deposit never became credit, so there is none to take back:
  -- its refund comes off what was paid on the stay invoice instead.
  IF _inv IS NULL OR _kind IS DISTINCT FROM 'prepaid_topup' OR _linked IS NOT NULL THEN
    RETURN 0;
  END IF;

  -- What tg_invoice_paid_credit granted: the pre-tax total.
  _granted := COALESCE(_total, 0) - _tax;

  -- The refunded dollars that were credit rather than tax, pro rata -- the
  -- same division that gave the payment its tax share. With no tax this is
  -- the refunded amount itself, which is what this function always used.
  _target := LEAST(
    GREATEST(_refunded_cents - public.sales_tax_share_cents(_refunded_cents, _tax, _total), 0),
    GREATEST(_granted, 0));

  SELECT COALESCE(-SUM(delta_cents), 0) INTO _already
    FROM public.credit_ledger
   WHERE invoice_id = _inv AND kind = 'refund';

  _delta := _target - _already;
  IF _delta = 0 THEN RETURN 0; END IF;

  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, invoice_id, note)
  VALUES (_org, _client, -_delta, 'refund', _inv,
          'Prepaid top-up refunded (payment ' || _payment_id::text || ')');

  RETURN _delta;
END;
$function$;

-- ── 4. A deposit follows its stay invoice ─────────────────────────────────
-- Release: unlink a deposit from a stay invoice that will not be paid as
-- booked (voided, or its stay canceled), and give back as account credit
-- whatever was kept of a paid one: what a paid deposit was before D3. Left
-- alone when the stay invoice is already paid, because then the deposit is
-- part of a settled bill, as an applied credit was before.
CREATE OR REPLACE FUNCTION public.release_stay_deposit(_deposit_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _dep public.invoices%ROWTYPE;
  _parent_status public.invoice_status;
  _kept integer;
BEGIN
  SELECT * INTO _dep FROM public.invoices WHERE id = _deposit_id FOR UPDATE;
  IF _dep.id IS NULL OR _dep.deposit_for_invoice_id IS NULL THEN RETURN; END IF;
  SELECT status INTO _parent_status FROM public.invoices WHERE id = _dep.deposit_for_invoice_id;
  IF _parent_status = 'paid' THEN RETURN; END IF;

  UPDATE public.invoices SET deposit_for_invoice_id = NULL, updated_at = now() WHERE id = _dep.id;

  IF _dep.status = 'paid' THEN
    _kept := public.invoice_paid_cents(_dep.id);
    IF _kept > 0 THEN
      PERFORM public.post_credit_entry(
        _dep.organization_id, _dep.client_id, _kept,
        'prepayment', _dep.id, NULL, 'Stay deposit returned to account credit');
    END IF;
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.release_stay_deposit(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_stay_deposit(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_invoices_deposit_follows()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _d uuid;
BEGIN
  -- The link moved (set by the stay, cleared by a release): both stay
  -- invoices' paid figures move with it.
  IF NEW.deposit_for_invoice_id IS DISTINCT FROM OLD.deposit_for_invoice_id THEN
    IF OLD.deposit_for_invoice_id IS NOT NULL THEN
      PERFORM public.sync_invoice_amount_paid(OLD.deposit_for_invoice_id);
    END IF;
    PERFORM public.sync_stay_invoice_for_deposit(NEW.deposit_for_invoice_id);
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    -- Paid as a whole: a deposit still asking for money has been paid with it.
    -- Voided directly rather than through void_invoice, which asks who is
    -- signed in; a Stripe webhook is nobody, and the deposit carries no
    -- applied credit to return (apply_credit_to_invoice refuses a top-up).
    IF NEW.status = 'paid' THEN
      UPDATE public.invoices
         SET status = 'void', voided_at = now(), updated_at = now()
       WHERE deposit_for_invoice_id = NEW.id AND status IN ('draft', 'open');
    ELSIF NEW.status = 'void' THEN
      FOR _d IN SELECT id FROM public.invoices WHERE deposit_for_invoice_id = NEW.id LOOP
        PERFORM public.release_stay_deposit(_d);
      END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_invoices_deposit_follows() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_deposit_follows ON public.invoices;
CREATE TRIGGER invoices_deposit_follows
  AFTER UPDATE OF status, deposit_for_invoice_id ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_invoices_deposit_follows();

-- The stay decides the link: invoicing a stay links its deposit, and a
-- cancel releases it before tg_stays_follow applies the cancellation rule to
-- it (BEFORE, so the rule sees the deposit exactly as it saw one before D3).
CREATE OR REPLACE FUNCTION public.tg_stays_deposit_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'canceled' AND OLD.status IS DISTINCT FROM 'canceled' THEN
    IF NEW.deposit_invoice_id IS NOT NULL THEN
      PERFORM public.release_stay_deposit(NEW.deposit_invoice_id);
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.deposit_invoice_id IS NOT NULL AND NEW.invoice_id IS NOT NULL
     AND (NEW.deposit_invoice_id, NEW.invoice_id) IS DISTINCT FROM (OLD.deposit_invoice_id, OLD.invoice_id) THEN
    UPDATE public.invoices
       SET deposit_for_invoice_id = NEW.invoice_id,
           notes = replace(notes,
                           'Paid, it is credited to your account and comes off your stay invoice.',
                           'Paid, it is part payment of your stay invoice.'),
           updated_at = now()
     WHERE id = NEW.deposit_invoice_id
       AND deposit_for_invoice_id IS NULL
       AND status IN ('draft', 'open')
       AND EXISTS (SELECT 1 FROM public.invoices p
                    WHERE p.id = NEW.invoice_id AND p.status IN ('draft', 'open'));
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_deposit_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stays_deposit_link ON public.stays;
CREATE TRIGGER stays_deposit_link
  BEFORE UPDATE OF status, invoice_id, deposit_invoice_id ON public.stays
  FOR EACH ROW EXECUTE FUNCTION public.tg_stays_deposit_link();

-- ── 5. Backfill: deposits still to be paid become part of their stay ─────
-- Idempotent (only rows not yet linked), and a no-op on a fresh build. A
-- deposit already paid is NOT linked: its money became account credit when it
-- was paid, and may already have been applied to the stay or spent; linking
-- it now would count the same dollars a second time.
UPDATE public.invoices d
   SET deposit_for_invoice_id = st.invoice_id,
       notes = replace(d.notes,
                       'Paid, it is credited to your account and comes off your stay invoice.',
                       'Paid, it is part payment of your stay invoice.'),
       updated_at = now()
  FROM public.stays st
  JOIN public.invoices p ON p.id = st.invoice_id
 WHERE st.deposit_invoice_id = d.id
   AND st.invoice_id IS NOT NULL
   AND d.deposit_for_invoice_id IS NULL
   AND d.status IN ('draft', 'open')
   AND p.status IN ('draft', 'open')
   AND st.status <> 'canceled';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _bad integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'invoices'
                    AND column_name = 'deposit_for_invoice_id') THEN
    RAISE EXCEPTION 'invoices.deposit_for_invoice_id is missing';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.invoice_paid_cents(uuid)'::regprocedure)
       NOT LIKE '%deposit_for_invoice_id = _invoice_id%' THEN
    RAISE EXCEPTION 'a stay invoice does not count its deposit''s payments';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_invoice_paid_credit()'::regprocedure)
       NOT LIKE '%deposit_for_invoice_id IS NULL%' THEN
    RAISE EXCEPTION 'a linked deposit is still posted as account credit';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass
                  AND tgname = 'invoices_deposit_follows' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass
                  AND tgname = 'stays_deposit_link' AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.invoices'::regclass
                  AND tgname = 'invoices_guard_deposit_link' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'a deposit trigger is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.release_stay_deposit(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.sync_stay_invoice_for_deposit(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.release_stay_deposit(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'a deposit helper is callable by a signed-in user';
  END IF;
  -- After the backfill, every linked deposit's stay invoice agrees with the
  -- payments it now counts. Proved from any starting state.
  SELECT count(*) INTO _bad
    FROM public.invoices p
   WHERE EXISTS (SELECT 1 FROM public.invoices d WHERE d.deposit_for_invoice_id = p.id)
     AND p.amount_paid_cents IS DISTINCT FROM public.invoice_paid_cents(p.id);
  IF _bad > 0 THEN
    RAISE EXCEPTION '% stay invoices disagree with their deposits'' payments after the backfill', _bad;
  END IF;
END
$check$;
