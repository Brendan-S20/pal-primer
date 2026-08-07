-- Recurring add-ons never billed. Not "billed wrong" — never billed at all.
--
-- The chain: `addon_subscriptions` holds the recurring sale (frequency,
-- price, next_charge_on). `generate_addon_charges_through` walks the due ones
-- and writes `addon_charges` rows. `run_billing_cycles` and
-- `admin_generate_invoice_for_client` then pick up any `addon_charges` with
-- status = 'pending' and put them on the invoice.
--
-- Every link exists except the first. Measured:
--
--   * `generate_addon_charges_through` has exactly ONE caller in the entire
--     repo — `generateAddonCharges` in src/lib/addons.functions.ts.
--   * `generateAddonCharges` has NO caller. It is one of the 28 server
--     functions the dead-machinery detector has been carrying since Rule 5.
--   * It is in no cron job. `cron.job` runs nightly-automation, the email
--     queue, run_billing_cycles and the weekly digest. None of them touch it.
--   * `addon_charges` has 0 rows with source = 'recurring'. Ever.
--
-- So a tenant can sell a monthly add-on, the subscription row sits there with
-- next_charge_on quietly in the past, and no charge is ever produced. Nobody
-- has been hurt yet only because there are 0 addon_subscriptions in any org —
-- the same way the win-back button was inert rather than wrong.
--
-- ── WHY THE NIGHTLY JOB COULD NOT JUST CALL IT ────────────────────────────
--
-- `generate_addon_charges_through` opens with
--
--     IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing')
--
-- and the nightly hook runs as service_role, where auth.uid() is NULL. Calling
-- it from cron would have raised 'Not authorized' on every org — swapping a
-- silent no-op for a nightly error, which is not a fix.
--
-- Same split the invoice path already uses: `admin_generate_invoice_for_client`
-- carries the logic and `generate_invoice_for_client` is the permission-checked
-- wrapper over it. This applies that shape here, so the loop that creates money
-- rows exists exactly once and both entry points share it.

-- ── Pre-flight: the live definition is the one this was written against ────
DO $pre$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_addon_charges_through';
  IF _def IS NULL THEN
    RAISE EXCEPTION 'generate_addon_charges_through is not installed';
  END IF;
  IF position('admin_generate_addon_charges_through' IN _def) > 0 THEN
    RAISE NOTICE 'already delegating to the admin core; replacing with the same bodies';
  ELSIF position('has_permission(auth.uid(), _org_id' IN _def) = 0 THEN
    RAISE EXCEPTION
      'generate_addon_charges_through is neither the version this migration was written against nor its result; refusing to clobber it';
  END IF;
END
$pre$;

-- The loop, with no permission check: callable by the nightly cron under
-- service_role. Named `admin_` for the same reason every other function in this
-- schema is — the prefix IS the marker that the caller is responsible for
-- authorization, and grepping for it is how that stays auditable.
CREATE OR REPLACE FUNCTION public.admin_generate_addon_charges_through(_org_id uuid, _through date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _s record; _n integer := 0; _step interval; _next date; _charge_id uuid;
BEGIN
  FOR _s IN
    SELECT * FROM public.addon_subscriptions
     WHERE organization_id = _org_id AND status = 'active' AND next_charge_on <= _through
  LOOP
    _step := CASE _s.frequency
      WHEN 'weekly' THEN interval '7 days'
      WHEN 'biweekly' THEN interval '14 days'
      WHEN 'monthly' THEN interval '1 month'
      WHEN 'quarterly' THEN interval '3 months'
      WHEN 'yearly' THEN interval '1 year'
    END;

    -- A frequency the CASE does not cover leaves _step NULL, and `_next + NULL`
    -- is NULL, so the WHILE below would exit immediately and next_charge_on
    -- would be set to NULL — quietly retiring the subscription forever. Skip
    -- the row instead and say so, so an unmapped enum value is visible.
    IF _step IS NULL THEN
      RAISE WARNING 'admin_generate_addon_charges_through: addon_subscription % has unmapped frequency %, skipped',
        _s.id, _s.frequency;
      CONTINUE;
    END IF;

    _next := _s.next_charge_on;
    WHILE _next <= _through LOOP
      INSERT INTO public.addon_charges(
        organization_id, client_id, addon_service_id, addon_subscription_id,
        description, unit_price_cents, quantity, amount_cents, occurred_on, source
      )
      SELECT _s.organization_id, _s.client_id, _s.addon_service_id, _s.id,
             svc.name, _s.price_cents, _s.quantity, _s.price_cents * _s.quantity, _next, 'recurring'
        FROM public.addon_services svc WHERE svc.id = _s.addon_service_id
      RETURNING id INTO _charge_id;

      -- A prepaid client pays from the credit balance immediately; a postpaid
      -- one leaves the charge 'pending' for the invoice run to collect.
      IF public.client_default_billing_cadence(_s.client_id) = 'prepaid' THEN
        DECLARE _lid uuid; _amt integer;
        BEGIN
          SELECT amount_cents INTO _amt FROM public.addon_charges WHERE id = _charge_id;
          INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
          VALUES (_s.organization_id, _s.client_id, -_amt, 'addon_debit',
                  'Recurring add-on ' || _next::text)
          RETURNING id INTO _lid;
          UPDATE public.addon_charges
             SET status='paid_from_credit', credit_ledger_id=_lid, updated_at=now()
           WHERE id=_charge_id;
        END;
      END IF;

      _n := _n + 1;
      _next := (_next + _step)::date;
    END LOOP;

    UPDATE public.addon_subscriptions SET next_charge_on = _next, updated_at = now() WHERE id = _s.id;
  END LOOP;

  RETURN _n;
END;
$function$;

-- The staff-facing entry point keeps its gate and delegates. Same relationship
-- as generate_invoice_for_client -> admin_generate_invoice_for_client.
CREATE OR REPLACE FUNCTION public.generate_addon_charges_through(_org_id uuid, _through date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  RETURN public.admin_generate_addon_charges_through(_org_id, _through);
END;
$function$;

COMMENT ON FUNCTION public.admin_generate_addon_charges_through(uuid, date) IS
  'Turns due addon_subscriptions into addon_charges. NO permission check — the '
  'caller is responsible. Called by the nightly automation hook under '
  'service_role, immediately before run_billing_cycles so the charges it '
  'creates are invoiced in the same pass.';

COMMENT ON FUNCTION public.generate_addon_charges_through(uuid, date) IS
  'Permission-checked wrapper over admin_generate_addon_charges_through, for a '
  'staff-initiated catch-up. Requires manage_client_billing.';
