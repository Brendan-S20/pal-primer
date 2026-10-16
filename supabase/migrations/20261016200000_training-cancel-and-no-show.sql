-- Follow-up to 20261016180000 (a trainer sells a package of sessions).
--
-- 1. Canceling a package no longer strands its lessons. Canceling stops new
--    bookings. The office chooses whether lessons booked after today are
--    canceled with it or kept. A kept lesson can still be completed, skipped
--    or moved, and a lesson on or before today can always be completed or
--    skipped, so a trainer is never refused for work already done.
--    cancel_client_package does both writes in one transaction.
--
-- 2. A no-show or a late cancel can use a session. Two business settings:
--    training_late_cancel_hours (default 24) and
--    training_missed_uses_session (default true). When a package lesson is
--    marked missed, or skipped inside the window for a reason that is not the
--    business's own, skip_billable is set from the rule. On a package lesson
--    skip_billable means "uses a session": package plans are priced at zero,
--    so no charge follows from it, and admin_generate_invoice_for_client
--    already leaves package lessons out. The office can override it later;
--    a trainer cannot.
--
-- "Uses a session" and "holds a session" are now one helper each, so the
-- recount, the guards and the session number cannot disagree about missed.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS training_late_cancel_hours integer NOT NULL DEFAULT 24
    CHECK (training_late_cancel_hours BETWEEN 0 AND 168),
  ADD COLUMN IF NOT EXISTS training_missed_uses_session boolean NOT NULL DEFAULT true;

CREATE OR REPLACE FUNCTION public.training_visit_uses_session(_status public.visit_status, _skip_billable boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT _status = 'completed'
    OR (_status IN ('skipped', 'missed') AND COALESCE(_skip_billable, false));
$$;
REVOKE ALL ON FUNCTION public.training_visit_uses_session(public.visit_status, boolean) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_visit_holds_session(_status public.visit_status, _skip_billable boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT _status IN ('scheduled', 'in_progress')
    OR public.training_visit_uses_session(_status, _skip_billable);
$$;
REVOKE ALL ON FUNCTION public.training_visit_holds_session(public.visit_status, boolean) FROM PUBLIC, anon, authenticated;

-- ── The no-show and late-cancel rule ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.training_lesson_session_rule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _o public.organizations%ROWTYPE; _start time; _starts timestamptz;
BEGIN
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    -- The office override. A trainer records the lesson but does not decide
    -- whether the client loses a session for it.
    IF NEW.skip_billable IS DISTINCT FROM OLD.skip_billable
       AND (select auth.uid()) IS NOT NULL
       AND NOT public.can_write_org((select auth.uid()), NEW.organization_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege',
        MESSAGE = 'Only the office can change whether this lesson uses a session.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('skipped', 'missed') THEN
    -- Back on the schedule, or completed: a later skip starts from the rule again.
    NEW.skip_billable := false;
    RETURN NEW;
  END IF;
  SELECT * INTO _o FROM public.organizations WHERE id = NEW.organization_id;
  IF NEW.status = 'missed' THEN
    NEW.skip_billable := COALESCE(_o.training_missed_uses_session, true);
    RETURN NEW;
  END IF;
  -- The business's own reasons never cost the client a session.
  IF NEW.skip_reason_code IN ('our_fault', 'weather', 'unsafe_conditions') THEN
    NEW.skip_billable := false;
    RETURN NEW;
  END IF;
  -- A lesson starts at its plan's start time, or at midnight when it has none.
  SELECT s.earliest_time INTO _start FROM public.subscriptions s WHERE s.id = NEW.subscription_id;
  _starts := (NEW.scheduled_on + COALESCE(_start, time '00:00'))
    AT TIME ZONE COALESCE(_o.timezone, 'America/Chicago');
  NEW.skip_billable := COALESCE(NEW.skip_billable, false) OR (
    COALESCE(_o.training_missed_uses_session, true)
    AND now() >= _starts - make_interval(hours => COALESCE(_o.training_late_cancel_hours, 24))
  );
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_lesson_session_rule() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_lesson_session_rule ON public.visits;
-- Named to sort before zz_training_visit_package_guard, which then sees the
-- skip_billable this rule chose.
CREATE TRIGGER training_lesson_session_rule BEFORE UPDATE OF status, skip_billable ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.training_lesson_session_rule();

-- ── The guards and counts, with missed counted and cancel loosened ───────

CREATE OR REPLACE FUNCTION public.training_client_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.service_packages%ROWTYPE; _actual integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO _p FROM public.service_packages WHERE id = NEW.service_package_id FOR SHARE;
    IF NOT FOUND OR _p.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a package from this business.';
    END IF;
    IF NOT _p.active THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package is not available for sale.';
    END IF;
    NEW.service_id := _p.service_id;
    NEW.name := _p.name;
    NEW.sessions_count := _p.sessions_count;
    NEW.price_cents := _p.price_cents;
    SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO NEW.purchased_on
      FROM public.organizations o WHERE o.id = NEW.organization_id;
    NEW.expires_on := NEW.purchased_on + _p.expires_after_days;
    IF NEW.sessions_used <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session usage is maintained by visits.';
    END IF;
  ELSE
    IF ROW(NEW.organization_id, NEW.client_id, NEW.service_package_id, NEW.service_id,
      NEW.name, NEW.sessions_count, NEW.price_cents, NEW.purchased_on, NEW.request_id)
      IS DISTINCT FROM ROW(OLD.organization_id, OLD.client_id, OLD.service_package_id, OLD.service_id,
      OLD.name, OLD.sessions_count, OLD.price_cents, OLD.purchased_on, OLD.request_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'A sold package keeps its original details.';
    END IF;
    IF NEW.sessions_used IS DISTINCT FROM OLD.sessions_used THEN
      SELECT count(*) INTO _actual FROM public.visits v WHERE v.client_package_id = NEW.id
        AND public.training_visit_uses_session(v.status, v.skip_billable);
      -- Nested recounts must match reality. A caller cannot forge usage.
      IF pg_trigger_depth() < 2 OR NEW.sessions_used <> _actual THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session usage is maintained by visits.';
      END IF;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a client from this business.';
  END IF;
  IF NEW.dog_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d JOIN public.properties p ON p.id = d.property_id
    WHERE d.id = NEW.dog_id AND d.organization_id = NEW.organization_id AND p.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a dog belonging to this client.';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.invoices i
    WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id AND i.client_id = NEW.client_id
      AND (TG_OP <> 'INSERT' OR i.subtotal_cents = NEW.price_cents)) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose an invoice belonging to this client.';
  END IF;
  NEW.canceled_at := CASE
    WHEN NEW.status <> 'canceled' THEN NULL
    WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.canceled_at, now())
    ELSE now()
  END;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_client_package_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_visit_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.client_packages%ROWTYPE; _derived boolean := false; _held integer; _message text; _today date;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_package_id IS DISTINCT FROM OLD.client_package_id
     AND (select auth.uid()) IS NOT NULL AND NOT public.can_write_org((select auth.uid()), OLD.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized to change this visit package.';
  END IF;
  IF NEW.client_package_id IS NULL AND NEW.subscription_id IS NOT NULL THEN
    -- A deleted package must stay unlinked during ON DELETE SET NULL.
    SELECT s.client_package_id INTO NEW.client_package_id FROM public.subscriptions s
      JOIN public.client_packages p ON p.id = s.client_package_id WHERE s.id = NEW.subscription_id;
    _derived := NEW.client_package_id IS NOT NULL AND TG_OP = 'INSERT';
  END IF;
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  -- Give a session back even after cancellation or expiry.
  IF TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id
     AND NOT public.training_visit_holds_session(NEW.status, NEW.skip_billable) THEN
    RETURN NEW;
  END IF;
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  SELECT * INTO _p FROM public.client_packages WHERE id = NEW.client_package_id FOR UPDATE;
  IF NOT FOUND OR _p.organization_id <> NEW.organization_id OR _p.client_id <> NEW.client_id
     OR _p.service_id <> NEW.service_id THEN
    _message := 'Choose a package for this client and training service.';
  -- A canceled package takes no new lessons. A lesson already on it can be
  -- completed, skipped or marked missed; a kept lesson can be moved; and a
  -- lesson on or before today can go back on the schedule.
  ELSIF _p.status = 'canceled' AND NOT (
    TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id AND (
      NEW.status NOT IN ('scheduled', 'in_progress')
      OR public.training_visit_holds_session(OLD.status, OLD.skip_billable)
      OR OLD.scheduled_on <= _today
    )
  ) THEN
    _message := 'This package was canceled.';
  ELSIF _p.expires_on IS NOT NULL AND NEW.scheduled_on > _p.expires_on THEN
    _message := 'This package expired on ' || to_char(_p.expires_on, 'YYYY-MM-DD') || '.';
  ELSE
    SELECT count(*) INTO _held FROM public.visits v
      WHERE v.client_package_id = _p.id AND v.id <> NEW.id
      AND public.training_visit_holds_session(v.status, v.skip_billable);
    IF _held + (CASE WHEN public.training_visit_holds_session(NEW.status, NEW.skip_billable) THEN 1 ELSE 0 END) > _p.sessions_count THEN
      _message := format('No sessions left in this package: %s of %s are booked or used.', _held, _p.sessions_count);
    END IF;
  END IF;
  IF _message IS NOT NULL THEN
    IF _derived THEN RETURN NULL; END IF;
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = _message;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_visit_package_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_package_recount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _old uuid; _new uuid; _id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.client_package_id, OLD.status, OLD.skip_billable) IS NOT DISTINCT FROM
       ROW(NEW.client_package_id, NEW.status, NEW.skip_billable) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN _old := OLD.client_package_id; END IF;
  IF TG_OP <> 'DELETE' THEN _new := NEW.client_package_id; END IF;
  -- Lock in a consistent order when a visit changes package.
  FOR _id IN SELECT DISTINCT p.id FROM public.client_packages p WHERE p.id IN (_old, _new) ORDER BY p.id LOOP
    PERFORM 1 FROM public.client_packages WHERE id = _id FOR UPDATE;
    UPDATE public.client_packages SET sessions_used = (
      SELECT count(*) FROM public.visits v WHERE v.client_package_id = _id
        AND public.training_visit_uses_session(v.status, v.skip_billable)
    ), updated_at = now() WHERE id = _id;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.training_package_recount() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.training_subscription_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.client_packages%ROWTYPE; _held integer;
BEGIN
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO _p FROM public.client_packages WHERE id = NEW.client_package_id FOR UPDATE;
  IF NOT FOUND OR _p.organization_id <> NEW.organization_id OR _p.client_id <> NEW.client_id OR _p.service_id <> NEW.service_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a package for this client and training service.';
  END IF;
  -- A plan cannot be converted to prepaid or charged per session later.
  NEW.price_cents := 0;
  NEW.billing_cadence := 'postpaid';
  IF TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id
    AND NEW.started_on = OLD.started_on THEN RETURN NEW; END IF;
  IF _p.status = 'canceled' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package was canceled.';
  END IF;
  IF _p.expires_on IS NOT NULL AND NEW.started_on > _p.expires_on THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package expired on ' || to_char(_p.expires_on, 'YYYY-MM-DD') || '.';
  END IF;
  SELECT count(*) INTO _held FROM public.visits v WHERE v.client_package_id = _p.id
    AND public.training_visit_holds_session(v.status, v.skip_billable);
  IF _held >= _p.sessions_count THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('No sessions left in this package: %s of %s are booked or used.', _held, _p.sessions_count);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_subscription_package_guard() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.client_package_session_number(_visit_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Check the target before reading the whole package, including other trainers' visits.
  WITH target AS (
    SELECT v.client_package_id FROM public.visits v WHERE v.id = _visit_id
      AND ((select auth.role()) = 'service_role' OR (public.is_org_member((select auth.uid()), v.organization_id)
        AND public.may_read_client_row(v.organization_id, v.client_id)))
  )
  SELECT numbered.n::integer FROM (
    SELECT v.id, row_number() OVER (ORDER BY v.scheduled_on, v.id) AS n
    FROM public.visits v JOIN target t ON t.client_package_id = v.client_package_id
    WHERE public.training_visit_holds_session(v.status, v.skip_billable)
  ) numbered WHERE numbered.id = _visit_id;
$$;
REVOKE ALL ON FUNCTION public.client_package_session_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_package_session_number(uuid) TO authenticated, service_role;

-- ── Office actions ───────────────────────────────────────────────────────

-- Cancel a package and say what happens to lessons booked after today, in
-- one transaction. Returns how many lessons were canceled with it.
CREATE OR REPLACE FUNCTION public.cancel_client_package(_client_package_id uuid, _cancel_booked boolean)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.client_packages%ROWTYPE; _today date; _n integer := 0;
BEGIN
  SELECT * INTO _p FROM public.client_packages WHERE id = _client_package_id FOR UPDATE;
  IF NOT FOUND OR (select auth.uid()) IS NULL
     OR NOT public.can_write_org((select auth.uid()), _p.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized';
  END IF;
  IF _cancel_booked IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose what happens to the booked lessons.';
  END IF;
  IF _p.status = 'canceled' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package was already canceled.';
  END IF;
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = _p.organization_id;
  IF _cancel_booked THEN
    UPDATE public.visits SET status = 'canceled', updated_at = now()
     WHERE client_package_id = _p.id AND status = 'scheduled' AND scheduled_on > _today;
    GET DIAGNOSTICS _n = ROW_COUNT;
  END IF;
  UPDATE public.client_packages SET status = 'canceled' WHERE id = _p.id;
  RETURN _n;
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_client_package(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_client_package(uuid, boolean) TO authenticated, service_role;

-- The same two roles that change the other business settings. The only UPDATE
-- policy on organizations is owner-only, so this goes through a function.
CREATE OR REPLACE FUNCTION public.set_training_session_rules(
  _org_id uuid, _late_cancel_hours integer, _missed_uses_session boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT (
    public.has_role((select auth.uid()), _org_id, 'owner')
    OR public.has_role((select auth.uid()), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized to update training settings';
  END IF;
  IF _late_cancel_hours IS NULL OR _late_cancel_hours NOT BETWEEN 0 AND 168 THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a late-cancel window from 0 to 168 hours.';
  END IF;
  IF _missed_uses_session IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose whether a no-show uses a session.';
  END IF;
  UPDATE public.organizations
     SET training_late_cancel_hours = _late_cancel_hours,
         training_missed_uses_session = _missed_uses_session
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_training_session_rules(uuid, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_training_session_rules(uuid, integer, boolean) TO authenticated, service_role;

DO $check$
DECLARE _src text; _fn text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'organizations' AND column_name = 'training_late_cancel_hours')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
       AND table_name = 'organizations' AND column_name = 'training_missed_uses_session') THEN
    RAISE EXCEPTION 'Training session rule columns are missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'training_lesson_session_rule'
       AND tgrelid = 'public.visits'::regclass AND NOT tgisinternal AND tgenabled <> 'D') THEN
    RAISE EXCEPTION 'Training trigger is missing: training_lesson_session_rule';
  END IF;
  IF NOT public.training_visit_uses_session('missed', true)
     OR public.training_visit_uses_session('missed', false)
     OR NOT public.training_visit_holds_session('scheduled', false)
     OR public.training_visit_holds_session('canceled', true) THEN
    RAISE EXCEPTION 'Training session helpers do not count missed lessons as the rule says.';
  END IF;
  -- Every count reads the helpers, so none of them still counts missed as given back.
  FOREACH _fn IN ARRAY ARRAY[
    'public.training_client_package_guard()', 'public.training_visit_package_guard()',
    'public.training_package_recount()', 'public.training_subscription_package_guard()',
    'public.client_package_session_number(uuid)'
  ] LOOP
    SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn::regprocedure;
    IF _src IS NULL OR strpos(_src, 'public.training_visit_') = 0
       OR strpos(_src, 'v.skip_billable = true') > 0 THEN
      RAISE EXCEPTION '% does not count sessions through the shared helpers.', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY[
    'public.cancel_client_package(uuid, boolean)',
    'public.set_training_session_rules(uuid, integer, boolean)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable with the publishable key', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not callable by a signed-in office user', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY[
    'public.training_visit_uses_session(public.visit_status, boolean)',
    'public.training_visit_holds_session(public.visit_status, boolean)'
  ] LOOP
    IF has_function_privilege('authenticated', _fn, 'EXECUTE') OR has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is callable from the API', _fn;
    END IF;
  END LOOP;
END
$check$;
