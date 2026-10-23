-- A stay deposit has a cancellation rule (#411 review, item 5).
--
-- The deposit is a prepaid_topup invoice. Paid, it becomes account credit.
-- Until this file, canceling a stay voided the deposit invoice when it was
-- unpaid and left a paid one on the account as credit, however late the
-- cancel came. A sitter who turned down other work for those dates got
-- nothing.
--
--   organizations.stay_deposit_refund_days   how many days before the stay
--                                            starts a deposit stays
--                                            refundable. Default 7.
--
-- Canceling with at least that many days to go (starts_on - today >= days)
-- refunds the deposit as before: unpaid is voided, paid stays as credit.
-- Later than that, the deposit is kept: an unpaid deposit invoice is still
-- voided, and a new invoice carries one line, "Cancellation fee", for the
-- deposit amount, untaxed as the deposit was. When the deposit was paid, the
-- client's credit pays that invoice through apply_credit_to_invoice, so the
-- money the client already gave is what is kept.
--
-- The office can refund anyway. cancel_stay(_stay_id, _refund_deposit) is
-- the office's cancel: it sets houndstack.stay_deposit_refund to the stay's
-- id for its own transaction, the way change_stay sets
-- houndstack.stay_change, and tg_stays_follow reads it. A plain UPDATE of the
-- status still works and applies the rule with no override.
--
-- Replays into an empty database: one column and three functions. No row is
-- needed and no number is asserted.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS stay_deposit_refund_days integer NOT NULL DEFAULT 7;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organizations'::regclass
                    AND conname = 'organizations_stay_deposit_refund_days_check') THEN
    ALTER TABLE public.organizations ADD CONSTRAINT organizations_stay_deposit_refund_days_check
      CHECK (stay_deposit_refund_days BETWEEN 0 AND 365);
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.organizations.stay_deposit_refund_days IS
  'A stay deposit is refunded on cancel when the stay starts at least this many days later; otherwise it is kept as a cancellation fee. 0 refunds up to the first day. Migration 20261023122000.';

-- ── Canceling applies the rule ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_stays_follow()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
  _refund_days integer;
  _dep public.invoices%ROWTYPE;
  _fee uuid;
  _svc_name text;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date, o.stay_deposit_refund_days
    INTO _today, _refund_days
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);
  IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
    UPDATE public.visits v SET status = 'canceled'
    WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
      AND v.status = 'scheduled' AND v.scheduled_on >= _today;
    UPDATE public.subscriptions s SET status = 'canceled', end_reason = COALESCE(s.end_reason, 'Stay canceled'), ended_by = COALESCE(auth.uid(), s.ended_by)
    WHERE s.stay_id = NEW.id AND s.status <> 'canceled';
    SELECT * INTO _dep FROM public.invoices WHERE id = NEW.deposit_invoice_id;
    IF _dep.id IS NOT NULL AND _dep.status NOT IN ('paid', 'void') THEN
      PERFORM public.void_invoice(_dep.id);
    END IF;
    -- Only the canceled nights come off, or are credited once paid. With
    -- nothing worked the unpaid invoice is voided, as before.
    PERFORM public.restate_stay_billing(NEW.id);

    -- Inside the refund window the deposit is kept as a cancellation fee.
    IF _dep.id IS NOT NULL AND _dep.status IN ('draft', 'open', 'paid')
       AND COALESCE(_dep.total_cents, 0) > 0
       AND NEW.starts_on - _today < COALESCE(_refund_days, 7)
       AND current_setting('houndstack.stay_deposit_refund', true) IS DISTINCT FROM NEW.id::text THEN
      SELECT name INTO _svc_name FROM public.services WHERE id = NEW.service_id;
      INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, due_on, period_start, period_end, notes)
      VALUES (NEW.organization_id, NEW.client_id, 'open', 'postpaid', now(), _today, NEW.starts_on, NEW.ends_on,
              'Stay canceled less than ' || COALESCE(_refund_days, 7) || ' days before it started. The deposit is kept as a cancellation fee.')
      RETURNING id INTO _fee;
      INSERT INTO public.invoice_line_items(invoice_id, description, amount_cents)
      VALUES (_fee, 'Cancellation fee: ' || COALESCE(_svc_name, 'pet sitting') || ' deposit', _dep.total_cents);
      UPDATE public.invoices SET subtotal_cents = _dep.total_cents, total_cents = _dep.total_cents,
        tax_rate_bps = 0, tax_cents = 0, tax_label = NULL WHERE id = _fee;
      -- A paid deposit is credit on the account; it pays the fee.
      IF _dep.status = 'paid' THEN
        PERFORM public.apply_credit_to_invoice(_fee);
      END IF;
      PERFORM set_config('houndstack.stay_cancel_fee', _fee::text, true);
    END IF;
    RETURN NULL;
  END IF;
  IF NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id AND NEW.status <> 'canceled' THEN
    UPDATE public.visits v SET assigned_staff_id = NEW.assigned_staff_id, sequence = NULL
    WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
      AND v.status = 'scheduled' AND v.scheduled_on >= _today;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_follow() FROM PUBLIC, anon, authenticated;

-- ── The office cancels a stay ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cancel_stay(_stay_id uuid, _refund_deposit boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _st public.stays%ROWTYPE;
  _fee uuid;
BEGIN
  SELECT * INTO _st FROM public.stays WHERE id = _stay_id FOR UPDATE;
  IF _st.id IS NULL THEN RAISE EXCEPTION 'Stay not found.'; END IF;
  IF NOT public.can_write_org(auth.uid(), _st.organization_id) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _st.status = 'canceled' THEN RAISE EXCEPTION 'That stay is already canceled.'; END IF;

  PERFORM set_config('houndstack.stay_cancel_fee', '', true);
  IF _refund_deposit THEN
    PERFORM set_config('houndstack.stay_deposit_refund', _st.id::text, true);
  END IF;
  UPDATE public.stays SET status = 'canceled' WHERE id = _st.id;
  PERFORM set_config('houndstack.stay_deposit_refund', '', true);
  _fee := NULLIF(current_setting('houndstack.stay_cancel_fee', true), '')::uuid;

  RETURN jsonb_build_object(
    'deposit', CASE WHEN _st.deposit_invoice_id IS NULL THEN 'none'
                    WHEN _fee IS NOT NULL THEN 'kept'
                    ELSE 'refunded' END,
    'fee_invoice_id', _fee);
END;
$function$;

REVOKE ALL ON FUNCTION public.cancel_stay(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_stay(uuid, boolean) TO authenticated, service_role;

COMMENT ON FUNCTION public.cancel_stay(uuid, boolean) IS
  'The office cancels a stay. The deposit is refunded when the stay starts at least organizations.stay_deposit_refund_days later, or when _refund_deposit; otherwise it is kept as a cancellation fee invoice. Returns {deposit: none|refunded|kept, fee_invoice_id}. can_write_org. Migration 20261023122000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'organizations'
                    AND column_name = 'stay_deposit_refund_days' AND is_nullable = 'NO') THEN
    RAISE EXCEPTION 'organizations.stay_deposit_refund_days is missing';
  END IF;
  IF to_regprocedure('public.cancel_stay(uuid, boolean)') IS NULL
     OR has_function_privilege('anon', 'public.cancel_stay(uuid, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cancel_stay(uuid, boolean)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_follow()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the stay cancel functions are missing or have the wrong grants';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%houndstack.stay_deposit_refund%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%restate_stay_billing%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.cancel_stay(uuid, boolean)'::regprocedure)
       NOT LIKE '%can_write_org%' THEN
    RAISE EXCEPTION 'the deposit rule is not wired into the cancel path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_follow' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'stays_follow is missing or disabled';
  END IF;
END
$check$;
