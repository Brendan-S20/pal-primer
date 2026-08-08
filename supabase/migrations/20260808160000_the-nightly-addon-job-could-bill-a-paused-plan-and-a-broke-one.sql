-- Two defects in the recurring add-on generator. Both mine, from
-- 20260807040000 — the migration that took a loop nobody had ever run and put
-- it on the nightly cron.
--
-- ── ONE: RESUME BACKFILLS THE PAUSE ───────────────────────────────────────
--
-- Pausing an add-on subscription writes `status` and nothing else. The
-- generator skips non-active rows, so while paused, `next_charge_on` sits
-- where it was. The clock stops; the pointer doesn't move.
--
-- Pause a $45/month add-on in November and resume it in March, and that
-- night's run walks the WHILE loop from November's date to today and writes
-- five charges — $225 — all landing on one invoice, for four months during
-- which the customer received nothing. Resume is one click with no confirm.
--
-- I wrote that loop and did not check what pause does to the pointer.
--
-- The fix is where the pause is: on any transition back INTO active, roll
-- `next_charge_on` forward to the first occurrence on or after today, keeping
-- the original cadence anchor so a subscription that always billed on the 3rd
-- goes on billing on the 3rd. `set_addon_subscription_status` exists so that
-- roll-forward and the permission check are one operation the UI cannot do
-- half of — the previous path was a bare table UPDATE from TypeScript.
--
-- The generator also gains a per-run cap. That is a backstop, not the fix: it
-- rate-limits catch-up rather than forgiving it, since the pointer advances
-- only as far as the charges actually written, so a genuine backlog (cron
-- down for a week) still bills in full over the following nights. What it
-- stops is one run silently emitting a year of charges, and it RAISEs a
-- WARNING naming the subscription so a stale pointer is visible rather than
-- inferred from a customer's invoice.
--
-- ── TWO: PREPAID CLIENTS COULD BE DEBITED PAST ZERO, AND NEVER BILLED ─────
--
-- The prepaid branch debited `credit_ledger` with no balance check and marked
-- the charge `paid_from_credit`. The invoice generator collects only `pending`
-- charges, so a `paid_from_credit` charge is never invoiced — which is correct
-- when credit really paid for it, and a hole when it didn't. A client at $0
-- went to −$45 and the work was never billed to anyone. Twelve months of that
-- is a year of delivered service recorded as paid and collected as nothing.
--
-- This branch was pre-existing; I copied it forward and made it run nightly
-- for the first time, which is what turned it from dormant into a leak.
--
-- The fix is all-or-nothing per charge, and that is a deliberate departure
-- from the "debit up to the balance, invoice the remainder" the review
-- suggested. `addon_charges` carries ONE status and ONE credit_ledger_id;
-- there is no column for a partially-credited charge. A half-debited charge
-- left `pending` would be invoiced for its FULL amount — the customer pays
-- twice for the same half — and one left `paid_from_credit` loses the
-- remainder entirely. Until the table can express a split, the only
-- representable answer that is correct on both sides is: take the credit when
-- it covers the charge, otherwise leave the whole charge to the invoice.
--
-- Nothing to repair. Checked before writing: 0 addon_subscriptions exist at
-- all, 0 charges are paid_from_credit, and 0 clients carry a negative
-- balance. Both defects are latent.

-- ── The cadence, named once ───────────────────────────────────────────────
-- The generator and the resume path both need "how long is one period", and
-- two copies of a CASE over an enum is how they drift.
CREATE OR REPLACE FUNCTION public.addon_frequency_step(_f public.addon_frequency)
 RETURNS interval
 LANGUAGE sql
 IMMUTABLE
 SET search_path = public, pg_temp
AS $function$
  SELECT CASE _f
    WHEN 'weekly'    THEN interval '7 days'
    WHEN 'biweekly'  THEN interval '14 days'
    WHEN 'monthly'   THEN interval '1 month'
    WHEN 'quarterly' THEN interval '3 months'
    WHEN 'yearly'    THEN interval '1 year'
  END;
$function$;

COMMENT ON FUNCTION public.addon_frequency_step(public.addon_frequency) IS
  'One billing period for an add-on subscription. NULL for a frequency this function has not been taught, which callers must treat as "skip and warn" rather than "zero".';

DO $pre$
DECLARE _src text; _missing text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_generate_addon_charges_through';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'admin_generate_addon_charges_through does not exist';
  END IF;
  -- The version this was written against: the unmapped-frequency guard from
  -- 20260807040000, and the unguarded prepaid debit this migration removes.
  IF _src NOT LIKE '%has unmapped frequency%' THEN
    RAISE EXCEPTION 'not the version this migration was written against (no unmapped-frequency guard)';
  END IF;
  IF _src LIKE '%credit_balance_cents%' THEN
    RAISE EXCEPTION 'the prepaid branch already reads a balance — read it before replacing it';
  END IF;

  -- Every enum member must map, or the generator skips real subscriptions.
  SELECT string_agg(e.enumlabel, ', ') INTO _missing
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
   WHERE t.typname = 'addon_frequency'
     AND public.addon_frequency_step(e.enumlabel::public.addon_frequency) IS NULL;
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'addon_frequency_step has no interval for: %', _missing;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.admin_generate_addon_charges_through(_org_id uuid, _through date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _s record; _n integer := 0; _step interval; _next date; _charge_id uuid;
  _emitted integer;
  -- One run should never owe more than a couple of periods per subscription.
  -- The pointer advances only as far as the charges written, so a real
  -- backlog continues on the following nights instead of being forgiven.
  _max_per_run constant integer := 3;
BEGIN
  FOR _s IN
    SELECT * FROM public.addon_subscriptions
     WHERE organization_id = _org_id AND status = 'active' AND next_charge_on <= _through
  LOOP
    _step := public.addon_frequency_step(_s.frequency);

    IF _step IS NULL THEN
      RAISE WARNING 'admin_generate_addon_charges_through: addon_subscription % has unmapped frequency %, skipped',
        _s.id, _s.frequency;
      CONTINUE;
    END IF;

    _next := _s.next_charge_on;
    _emitted := 0;
    WHILE _next <= _through AND _emitted < _max_per_run LOOP
      INSERT INTO public.addon_charges(
        organization_id, client_id, addon_service_id, addon_subscription_id,
        description, unit_price_cents, quantity, amount_cents, occurred_on, source
      )
      SELECT _s.organization_id, _s.client_id, _s.addon_service_id, _s.id,
             svc.name, _s.price_cents, _s.quantity, _s.price_cents * _s.quantity, _next, 'recurring'
        FROM public.addon_services svc WHERE svc.id = _s.addon_service_id
      RETURNING id INTO _charge_id;

      IF public.client_default_billing_cadence(_s.client_id) = 'prepaid' THEN
        DECLARE _lid uuid; _amt integer; _bal integer;
        BEGIN
          SELECT amount_cents INTO _amt FROM public.addon_charges WHERE id = _charge_id;
          -- Locked and re-read every iteration: the balance changes underneath
          -- a catch-up that writes more than one charge.
          SELECT COALESCE(credit_balance_cents, 0) INTO _bal
            FROM public.clients WHERE id = _s.client_id FOR UPDATE;

          IF _bal >= _amt THEN
            INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
            VALUES (_s.organization_id, _s.client_id, -_amt, 'addon_debit',
                    'Recurring add-on ' || _next::text)
            RETURNING id INTO _lid;
            UPDATE public.addon_charges
               SET status='paid_from_credit', credit_ledger_id=_lid, updated_at=now()
             WHERE id=_charge_id;
          END IF;
          -- Otherwise the charge stays 'pending' and the invoice generator
          -- picks it up. Silence here is the correct outcome, not a skip:
          -- a prepaid client who has run out is simply an invoiced client
          -- for this charge.
        END;
      END IF;

      _n := _n + 1;
      _emitted := _emitted + 1;
      _next := (_next + _step)::date;
    END LOOP;

    IF _next <= _through THEN
      RAISE WARNING 'admin_generate_addon_charges_through: addon_subscription % still owes charges from % after % this run — pointer was stale; continuing next run',
        _s.id, _next, _max_per_run;
    END IF;

    UPDATE public.addon_subscriptions SET next_charge_on = _next, updated_at = now() WHERE id = _s.id;
  END LOOP;

  RETURN _n;
END;
$function$;

-- ── Status changes, with the pointer kept honest ──────────────────────────
CREATE OR REPLACE FUNCTION public.set_addon_subscription_status(_id uuid, _status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _s record; _step interval; _next date; _skipped integer := 0;
BEGIN
  IF _status NOT IN ('active', 'paused', 'canceled') THEN
    RAISE EXCEPTION 'Unknown add-on subscription status %', _status;
  END IF;

  SELECT * INTO _s FROM public.addon_subscriptions WHERE id = _id FOR UPDATE;
  IF _s.id IS NULL THEN RAISE EXCEPTION 'Add-on subscription not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _s.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  _next := _s.next_charge_on;

  -- Coming back to active: skip the periods that elapsed while it was not
  -- active. The customer did not receive those, so they are not billed for
  -- them. Stepping by the cadence rather than jumping to CURRENT_DATE keeps
  -- the anchor — a plan that billed on the 3rd goes on billing on the 3rd.
  IF _status = 'active' AND _s.status <> 'active' AND _next < CURRENT_DATE THEN
    _step := public.addon_frequency_step(_s.frequency);
    IF _step IS NULL THEN
      RAISE EXCEPTION 'Cannot resume: no billing period is defined for frequency %', _s.frequency;
    END IF;
    WHILE _next < CURRENT_DATE LOOP
      _next := (_next + _step)::date;
      _skipped := _skipped + 1;
    END LOOP;
  END IF;

  UPDATE public.addon_subscriptions
     SET status = _status, next_charge_on = _next, updated_at = now()
   WHERE id = _id;

  RETURN jsonb_build_object(
    'ok', true,
    'status', _status,
    'next_charge_on', _next,
    'skipped_periods', _skipped);
END;
$function$;

REVOKE ALL ON FUNCTION public.set_addon_subscription_status(uuid, text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_addon_subscription_status(uuid, text) TO authenticated;

DO $post$
DECLARE _src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_generate_addon_charges_through';
  IF _src NOT LIKE '%_bal >= _amt%' THEN
    RAISE EXCEPTION 'the prepaid balance gate is missing';
  END IF;
  IF _src NOT LIKE '%_emitted < _max_per_run%' THEN
    RAISE EXCEPTION 'the per-run cap is missing';
  END IF;
  IF _src LIKE '%WHEN ''biweekly'' THEN%' THEN
    RAISE EXCEPTION 'the generator still carries its own copy of the cadence CASE';
  END IF;
END
$post$;
