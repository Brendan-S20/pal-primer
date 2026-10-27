-- A dispatcher books the lessons of a package the office already sold (#555).
--
-- Found in the Training QA on #548: dispatcher@demo.test could open
-- /training-packages, see Priya's 4-pack (1 used, 3 free) and see the lesson
-- on /routes, but the client's package card had no Book controls, and an
-- owner looking at the same unpaid package did. Role-gated, not unpaid-gated.
--
-- Booking a lesson writes one zero-price plan (public.subscriptions) for the
-- package and generates its visits. Everything else in that path already
-- answers to public.can_write_org, which admits owner, office_manager and
-- dispatcher: requireTrainingOffice, generate_visits_for_subscription, the
-- visits write policy, cancel_client_package and the client_packages update
-- policy. The plan insert was the one write that did not. The subscriptions
-- write policy is manage_pricing, deliberately (rls-is-the-boundary: a
-- dispatcher once repriced 24 plans), and it stays exactly as it is.
--
-- So this is a narrow door rather than a wider policy. It can write one kind
-- of row only: a plan on an existing package, for an address of that
-- package's own client, in the package's own business. It takes no price, no
-- cadence, no service and no client from the caller. The price could not be
-- set anyway: training_subscription_package_guard forces price_cents = 0 and
-- billing_cadence = 'postpaid' on any plan with a package, and refuses a
-- canceled, expired or fully booked package. The money moved when the package
-- was sold, which stays manage_client_billing (sellTrainingPackage).
--
-- Replays into an empty database: it creates a function and checks the
-- function. No rows, no tenant, no cron.

CREATE OR REPLACE FUNCTION public.book_training_package_plan(
  _client_package_id uuid,
  _property_id uuid,
  _started_on date,
  _ends_on date,
  _weekday smallint DEFAULT NULL,
  _earliest_time time DEFAULT NULL,
  _latest_time time DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _p public.client_packages%ROWTYPE;
  _zone uuid;
  _account public.account_type;
  _dogs integer;
  _id uuid;
BEGIN
  SELECT * INTO _p FROM public.client_packages WHERE id = _client_package_id;
  IF NOT FOUND OR NOT public.can_write_org((select auth.uid()), _p.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized';
  END IF;

  SELECT pr.zone_id, c.account_type INTO _zone, _account
    FROM public.properties pr
    JOIN public.clients c ON c.id = pr.client_id
   WHERE pr.id = _property_id
     AND pr.client_id = _p.client_id
     AND pr.organization_id = _p.organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose an address for this client.';
  END IF;

  -- No weekday is one lesson on one day; a weekday is weekly until _ends_on.
  IF _started_on IS NULL OR _ends_on IS NULL OR _ends_on < _started_on
     OR (_weekday IS NULL AND _ends_on <> _started_on)
     OR (_weekday IS NOT NULL AND _weekday NOT BETWEEN 0 AND 6) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose the lesson dates again.';
  END IF;
  IF (_earliest_time IS NULL) <> (_latest_time IS NULL) OR _latest_time <= _earliest_time THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose the lesson time again.';
  END IF;

  SELECT count(*) INTO _dogs FROM public.dogs d WHERE d.property_id = _property_id AND d.active;

  INSERT INTO public.subscriptions (
    organization_id, client_id, property_id, service_id, client_package_id,
    account_type, preferred_time_of_day, dog_count, unit_count,
    frequency, weekdays, price_cents, billing_cadence,
    started_on, ends_on, zone_id, priced_from_zone_id,
    earliest_time, latest_time
  ) VALUES (
    _p.organization_id, _p.client_id, _property_id, _p.service_id, _p.id,
    _account, 'any',
    CASE WHEN _account = 'commercial' THEN NULL ELSE GREATEST(1, _dogs) END,
    CASE WHEN _account = 'commercial' THEN 1 ELSE NULL END,
    CASE WHEN _weekday IS NULL THEN 'one_time' ELSE 'weekly' END::public.service_frequency,
    CASE WHEN _weekday IS NULL THEN NULL ELSE ARRAY[_weekday] END,
    0, 'postpaid',
    _started_on, _ends_on, _zone, NULL,
    _earliest_time, _latest_time
  )
  RETURNING id INTO _id;
  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.book_training_package_plan(uuid, uuid, date, date, smallint, time, time) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_training_package_plan(uuid, uuid, date, date, smallint, time, time) TO authenticated, service_role;

COMMENT ON FUNCTION public.book_training_package_plan(uuid, uuid, date, date, smallint, time, time) IS
  'Writes the zero-price plan that books a sold training package''s lessons, for anyone public.can_write_org admits (owner, office_manager, dispatcher). Takes no price, cadence, service or client from the caller; training_subscription_package_guard holds the price at 0. The subscriptions write policy stays manage_pricing. Migration 20261027130000 (#555).';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn constant regprocedure :=
    'public.book_training_package_plan(uuid, uuid, date, date, smallint, time, time)'::regprocedure;
BEGIN
  IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = _fn) THEN
    RAISE EXCEPTION 'book_training_package_plan must be SECURITY DEFINER to write past the manage_pricing policy';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'book_training_package_plan is executable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'book_training_package_plan is not executable by authenticated';
  END IF;
  IF (SELECT p.prosrc FROM pg_proc p WHERE p.oid = _fn) NOT LIKE '%public.can_write_org((select auth.uid()), _p.organization_id)%' THEN
    RAISE EXCEPTION 'book_training_package_plan lost its can_write_org check';
  END IF;
END;
$post$;
