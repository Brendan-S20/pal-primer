-- Seasonal deep cleans were generated for services that had already ended.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- admin_generate_seasonal_deepcleans selected `WHERE s.status = 'active'` and
-- nothing else. But "ended" is not expressed as a status in this schema:
-- end_subscription / endSubscription write `ends_on` and LEAVE status 'active'
-- — see src/lib/subscriptions.functions.ts, which updates ends_on only. The
-- Services tab knows this and tests `isServiceEnded` (canceled OR ends_on
-- passed); this generator tested status alone.
--
-- So every service a tenant had ever ended remained a deep-clean candidate,
-- twice a year, for ever. A deep clean is not a free artifact either: it is
-- billed as the subscription price PLUS deepclean_charge_cents (default 4900)
-- as a second invoice line — so a client whose service ended last spring would
-- be invoiced for a visit on a plan they had cancelled, and a tech would be
-- routed to them.
--
-- It also had no frequency filter, which is how it was found: booking a
-- one-off visit creates a `one_time` subscription with ends_on = the visit
-- date, and a probe showed a FINISHED one-off receiving a deep clean
-- (deepcleans_on_the_finished_one_off = 1).
--
-- ── EXPOSURE, STATED HONESTLY ──────────────────────────────────────────────
--
-- Latent, not active. Verified against the live database before writing this:
-- zero organizations have seasonal_deepclean_enabled, and zero subscriptions
-- are currently in the ended-but-active state. Nobody has been billed. This is
-- a bug that was waiting for the first tenant to switch the feature on.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Two predicates, both conservative:
--
--   * `ends_on IS NULL OR ends_on >= _target` — a service that had finished
--     before the deep-clean date does not get one. `>=` and not `>` because a
--     service ending ON the target date is still running that day.
--
--   * `frequency <> 'one_time'` — a seasonal deep clean is for the buildup a
--     STANDING service leaves between visits. A single call-out has no season
--     and no next visit to prepare for, and the client has no plan to bill it
--     against.
--
-- Everything else is byte-for-byte the previous definition, including the
-- NOT EXISTS month guard and ON CONFLICT DO NOTHING. Reconstructing a function
-- body from memory is how run_billing_cycles got broken earlier in this cycle,
-- so this was taken from pg_get_functiondef of the live function and edited in
-- exactly two places.

CREATE OR REPLACE FUNCTION public.admin_generate_seasonal_deepcleans(_org_id uuid, _year integer, _month integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _target date;
  _charge int;
  _inserted int := 0;
BEGIN
  SELECT COALESCE(seasonal_deepclean_charge_cents, 4900) INTO _charge
  FROM public.organizations WHERE id = _org_id;

  _target := make_date(_year, _month, 1);
  IF EXTRACT(DOW FROM _target) = 0 THEN _target := _target + 1; END IF;
  IF EXTRACT(DOW FROM _target) = 6 THEN _target := _target + 2; END IF;

  INSERT INTO public.visits (
    organization_id, subscription_id, client_id, property_id,
    scheduled_on, status, is_deepclean, deepclean_charge_cents
  )
  SELECT
    s.organization_id, s.id, s.client_id, s.property_id,
    _target, 'scheduled'::visit_status, true, _charge
  FROM public.subscriptions s
  WHERE s.organization_id = _org_id
    AND s.status = 'active'
    -- Ended services are still status='active' in this schema; ends_on is the
    -- real test. Without this every cancelled plan kept being deep-cleaned.
    AND (s.ends_on IS NULL OR s.ends_on >= _target)
    -- A one-off call-out is not a standing service with seasonal buildup.
    AND s.frequency <> 'one_time'
    AND NOT EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.subscription_id = s.id
        AND v.is_deepclean = true
        AND date_trunc('month', v.scheduled_on::timestamp) = date_trunc('month', _target::timestamp)
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  RETURN _inserted;
END;
$function$;
