-- A tech could not skip a visit for any reason that charges the customer.
--
-- Found 2026-09-27 by a field-tech persona test: My Day -> Skip -> "Dog was
-- outside" -> Confirm, and the toast "Not authorized to change skip_billable,
-- skip_charge_cents on a visit." The same skip with "Weather" worked.
--
-- Two correct things met. visits_guard_privileged_columns (20260825060000)
-- refuses a signed-in non-writer who changes the money columns on a visit,
-- because a tech writing skip_charge_cents directly is never legitimate. And
-- skip_visit (20260804110000) is the product's own SECURITY DEFINER function
-- that COMPUTES those columns from the org's skip rules. But SECURITY DEFINER
-- changes the privilege role, not request.jwt.claims -- auth.uid() inside the
-- function is still the tech -- so the guard could not tell the product's
-- computed charge from a tech's forged one, and refused both. Every reason a
-- tech actually meets in a driveway charges by default (gate locked, dog
-- outside, access blocked, late cancellation at 100%; unsafe conditions at
-- 50%), so every one of them failed. An offline-queued billable skip failed
-- the same way on replay, five times, and was then discarded.
--
-- The fix is a narrow, visit-specific trust mark. skip_visit sets a
-- transaction-local setting naming the ONE visit it is skipping, immediately
-- around its UPDATE, and clears it after. The guard lets skip_billable and
-- skip_charge_cents through only when that setting names the row being
-- updated. Nothing else is relaxed: identity columns and the deep-clean money
-- columns stay locked for a tech in every case, and any other visit is judged
-- exactly as before. A client cannot forge the mark: set_config is not
-- exposed through the API, and each API request is its own transaction, so
-- the setting can only ever exist inside a skip_visit call.
--
-- Also here, for a different reason: nothing in the migrations creates the
-- `visit-photos` bucket. Production has it (made at a console), with policies
-- from 20260701161658, so every fresh build -- local, CI, any new environment
-- -- answered "Bucket not found" to the first completion photo, and
-- complete_visit requires one. Created here to match production (private, no
-- size or type limits), and ON CONFLICT DO NOTHING so production is untouched.
--
-- Replays into an empty database: functions, a trigger function and one
-- storage row; the assertions are about what this file establishes.

INSERT INTO storage.buckets (id, name, public)
VALUES ('visit-photos', 'visit-photos', false)
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.visits_guard_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _changed text[] := ARRAY[]::text[];  -- array_append below, never ||: `text[] || 'literal'` is
                                      -- ambiguous and Postgres parses the literal as an ARRAY,
                                      -- raising "malformed array literal" at runtime.
  -- skip_visit names the one visit it is computing a charge for. Anything
  -- else (another row, no mark, a mark from nowhere) is judged as before.
  _trusted_skip boolean :=
    COALESCE(current_setting('houndstack.trusted_skip_visit', true), '') = NEW.id::text;
BEGIN
  -- No JWT: service role, pg_cron, the nightly runner. See 20260825060000.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Owner / office manager / dispatcher.
  IF public.can_write_org(auth.uid(), OLD.organization_id) THEN
    RETURN NEW;
  END IF;

  -- Tenancy and identity: never, for a tech, in any path.
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    _changed := array_append(_changed, 'organization_id');
  END IF;
  IF NEW.client_id IS DISTINCT FROM OLD.client_id THEN
    _changed := array_append(_changed, 'client_id');
  END IF;
  IF NEW.property_id IS DISTINCT FROM OLD.property_id THEN
    _changed := array_append(_changed, 'property_id');
  END IF;
  IF NEW.subscription_id IS DISTINCT FROM OLD.subscription_id THEN
    _changed := array_append(_changed, 'subscription_id');
  END IF;
  IF NEW.zone_id IS DISTINCT FROM OLD.zone_id THEN
    _changed := array_append(_changed, 'zone_id');
  END IF;

  -- Money. The skip pair is the one exception, and only for the visit
  -- skip_visit itself is charging.
  IF NOT _trusted_skip THEN
    IF NEW.skip_billable IS DISTINCT FROM OLD.skip_billable THEN
      _changed := array_append(_changed, 'skip_billable');
    END IF;
    IF NEW.skip_charge_cents IS DISTINCT FROM OLD.skip_charge_cents THEN
      _changed := array_append(_changed, 'skip_charge_cents');
    END IF;
  END IF;
  IF NEW.is_deepclean IS DISTINCT FROM OLD.is_deepclean THEN
    _changed := array_append(_changed, 'is_deepclean');
  END IF;
  IF NEW.deepclean_charge_cents IS DISTINCT FROM OLD.deepclean_charge_cents THEN
    _changed := array_append(_changed, 'deepclean_charge_cents');
  END IF;

  IF array_length(_changed, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'Not authorized to change % on a visit.', array_to_string(_changed, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.visits_guard_privileged_columns() FROM public, anon, authenticated;

CREATE OR REPLACE FUNCTION public.skip_visit(
  _visit_id uuid,
  _reason text,
  _code skip_reason_code DEFAULT 'other'::skip_reason_code,
  _skipped_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
  _when timestamptz := now();
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to skip a visit';
  END IF;

  IF _skipped_at IS NOT NULL
     AND _skipped_at <= now()
     AND _skipped_at >= now() - interval '7 days'
  THEN
    _when := _skipped_at;
  END IF;

  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  -- The charge is ours, computed above from the org's rules, not the
  -- caller's. Mark THIS visit as trusted for the guard, for this UPDATE only.
  PERFORM set_config('houndstack.trusted_skip_visit', _visit_id::text, true);

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         skipped_at = _when,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');

  PERFORM set_config('houndstack.trusted_skip_visit', '', true);
END;
$function$;

REVOKE ALL ON FUNCTION public.skip_visit(uuid, text, skip_reason_code, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.skip_visit(uuid, text, skip_reason_code, timestamptz)
  TO authenticated, service_role;

-- What this file establishes.
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'visit-photos') THEN
    RAISE EXCEPTION 'visit-photos bucket missing after this migration';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.skip_visit(uuid, text, skip_reason_code, timestamptz)'::regprocedure)
       !~ 'trusted_skip_visit' THEN
    RAISE EXCEPTION 'skip_visit does not mark its own visit for the guard';
  END IF;
END
$check$;
