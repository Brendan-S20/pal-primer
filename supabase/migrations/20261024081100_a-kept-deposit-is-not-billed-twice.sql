-- A kept deposit is not billed twice (#478 review).
--
-- A paid stay deposit is a prepaid_topup: tg_invoice_paid_credit posts it to
-- credit_ledger as a 'prepayment', and from then on it is ordinary account
-- credit. apply_credit_to_invoice spends it on any open invoice, and autopay
-- and the portal's Pay button both call it first, so the deposit's credit is
-- often gone by the time the stay is canceled. 20261024080900 keeps a late
-- cancel's deposit by opening a "Cancellation fee" invoice and paying it from
-- that credit.
--
-- The review asked whether that bills the client twice. Every case is now
-- proved in tests/integration/stay-deposits.db.test.ts, and the money was
-- already right in each:
--
--   credit applied to the stay invoice   voiding the stay invoice returns it
--                                        (void_invoice), and the fee is paid
--                                        from it. Nothing is owed.
--   stay invoice paid in full            restate_stay_billing credits the
--                                        stay's whole total, and the fee
--                                        takes the deposit back out of it.
--   credit spent on another invoice      the fee stays open for whatever the
--                                        credit no longer covers. The client
--                                        paid the deposit once, it paid that
--                                        other invoice, and the business
--                                        keeps the same amount for the late
--                                        cancel, so that amount is owed once.
--                                        Marking the fee paid "by the
--                                        deposit" would spend one payment on
--                                        two invoices.
--   refundable cancel                    nothing is credited back a second
--                                        time: the deposit's credit is still
--                                        on the account or was spent.
--
-- What was wrong is what the third case says on the invoice. The fee read
-- "The deposit is kept as a cancellation fee" and showed a balance due, which
-- to the client and to the office reads as the deposit billed a second time.
-- tg_stays_follow now checks what is left on the fee after the credit, and
-- when a paid deposit's credit did not cover it, the note says the credit was
-- already applied to other invoices. The amounts, the refund window and the
-- office override (cancel_stay's _refund_deposit, through
-- houndstack.stay_deposit_refund) are unchanged.
--
-- Replays into an empty database: one function. No row is needed and no
-- number is asserted.

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
  _due integer;
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
    -- nothing worked the unpaid invoice is voided, as before. Credit applied
    -- to it comes back to the account first, so the fee below can use it.
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
      -- A paid deposit is credit on the account; it pays the fee. Whatever of
      -- that credit already paid other invoices is not there to pay it twice,
      -- and the note says so.
      IF _dep.status = 'paid' THEN
        PERFORM public.apply_credit_to_invoice(_fee);
        SELECT total_cents - credit_applied_cents INTO _due FROM public.invoices WHERE id = _fee;
        IF _due > 0 THEN
          UPDATE public.invoices
             SET notes = 'Stay canceled less than ' || COALESCE(_refund_days, 7) || ' days before it started. The deposit is kept as a cancellation fee. Its credit was already applied to other invoices, so the rest of this fee is due.'
           WHERE id = _fee;
        END IF;
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

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.tg_stays_follow()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_stays_follow()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_stays_follow is callable by a signed-in user';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%houndstack.stay_deposit_refund%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%restate_stay_billing%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.tg_stays_follow()'::regprocedure)
       NOT LIKE '%already applied to other invoices%' THEN
    RAISE EXCEPTION 'the deposit rule is not wired into the cancel path';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.stays'::regclass AND tgname = 'stays_follow' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'stays_follow is missing or disabled';
  END IF;
END
$check$;
