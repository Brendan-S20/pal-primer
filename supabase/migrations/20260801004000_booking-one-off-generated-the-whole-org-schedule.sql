-- Booking a one-off visit regenerated the WHOLE organization's schedule.
--
-- ── THE DEFECT ─────────────────────────────────────────────────────────────
--
-- createOneOffVisit needs one visit to exist immediately, and the only tool
-- available was generate_visits_through(_org_id, _through) — which is
-- org-wide. It was called with _through = the booking date.
--
-- Within the org's normal 60-day horizon that is harmless: the work is
-- idempotent and identical to what the nightly run does anyway. Beyond it, a
-- single booking materialises visits for EVERY active subscription in the
-- organization across a window nobody has configured yet. And that is not
-- reversible in the way it looks: addBlackout only inserts a blackout row, it
-- does not delete visits already generated. So booking one call-out 90 days
-- out pins the whole org's schedule across a period whose holidays have not
-- been entered, and every blackout added afterwards leaves live, routed visits
-- sitting on top of it.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
--
-- Let the generator be told to consider ONE subscription. Everything else is
-- unchanged: the same blackout, work-day, client-hold, ends_on and ON CONFLICT
-- rules apply, because it is the same code path — not a second copy of it.
--
-- generate_visits_core gains `_subscription_id uuid DEFAULT NULL`, and the
-- cursor gains exactly one predicate:
--
--     AND (_subscription_id IS NULL OR s.id = _subscription_id)
--
-- DROP-then-CREATE rather than adding an overload, deliberately. A second
-- signature of the same name is precisely what rule 4 of the dead-machinery
-- check now refuses, after skip_visit sat granted-and-uncalled for a month
-- behind exactly that. Existing two-argument callers
-- (generate_visits_through, admin_generate_visits_through) keep working
-- untouched because the new parameter has a DEFAULT.
--
-- ── HOW THIS BODY WAS PRODUCED ─────────────────────────────────────────────
--
-- Copied verbatim from pg_get_functiondef() of the live function and edited in
-- exactly two places. Earlier in this cycle I broke run_billing_cycles in
-- production by rebuilding its body from a fragment I half-remembered; the
-- migration that followed it is checked by diffing the new body against the
-- old one and confirming the ONLY differences are the two intended edits.

DROP FUNCTION IF EXISTS public.generate_visits_core(uuid, date);

CREATE OR REPLACE FUNCTION public.generate_visits_core(
  _org_id uuid,
  _through date,
  _subscription_id uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _sub record;
  _next date;
  _candidate date;
  _stop date;
  _inserted integer := 0;
  _prefs int[];
  _step int;
  _dow int;
  _guard int;
  _work_days int[];
  _base date;
BEGIN
  SELECT COALESCE(work_days, '{0,1,2,3,4,5,6}') INTO _work_days
    FROM public.organizations WHERE id = _org_id;
  IF _work_days IS NULL OR array_length(_work_days, 1) IS NULL THEN
    _work_days := '{0,1,2,3,4,5,6}';
  END IF;

  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on,
           s.ends_on, s.preferred_weekdays, s.interval_weeks, s.interval_days
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
       -- THE ONLY BEHAVIOURAL EDIT. NULL keeps the org-wide behaviour every
       -- existing caller depends on.
       AND (_subscription_id IS NULL OR s.id = _subscription_id)
  LOOP
    _prefs := _sub.preferred_weekdays;
    _stop := LEAST(_through, COALESCE(_sub.ends_on, _through));
    IF _stop < _sub.started_on THEN CONTINUE; END IF;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE (EXISTS (SELECT 1 FROM public.blackout_dates
                      WHERE organization_id = _org_id AND blackout_on = _candidate)
             OR (_prefs IS NULL
                 AND NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_work_days))))
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;
      IF (_sub.ends_on IS NULL OR _candidate <= _sub.ends_on)
         AND NOT EXISTS (SELECT 1 FROM public.client_holds h
                          WHERE h.client_id = _sub.client_id
                            AND h.organization_id = _org_id
                            AND _candidate BETWEEN h.starts_on AND h.ends_on) THEN
        INSERT INTO public.visits
          (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
        VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
        ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
        IF FOUND THEN _inserted := _inserted + 1; END IF;
      END IF;
      CONTINUE;
    END IF;

    IF _sub.frequency = 'twice_weekly' AND _prefs IS NOT NULL AND array_length(_prefs,1) >= 2 THEN
      _candidate := _sub.started_on;
      _candidate := _candidate - EXTRACT(DOW FROM _candidate)::int;
      WHILE _candidate <= _stop LOOP
        FOREACH _dow IN ARRAY _prefs LOOP
          _next := _candidate + _dow;
          IF _next >= _sub.started_on AND _next <= _stop
             AND NOT EXISTS (SELECT 1 FROM public.blackout_dates
                              WHERE organization_id = _org_id AND blackout_on = _next)
             AND NOT EXISTS (SELECT 1 FROM public.client_holds h
                              WHERE h.client_id = _sub.client_id
                                AND h.organization_id = _org_id
                                AND _next BETWEEN h.starts_on AND h.ends_on) THEN
            INSERT INTO public.visits
              (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _next)
            ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
        END LOOP;
        _candidate := _candidate + 7;
      END LOOP;
      CONTINUE;
    END IF;

    _step := CASE _sub.frequency
      WHEN 'weekly'        THEN 7 * GREATEST(COALESCE(_sub.interval_weeks, 1), 1)
      WHEN 'biweekly'      THEN 14
      WHEN 'twice_weekly'  THEN 3
      WHEN 'every_n_days'  THEN GREATEST(COALESCE(_sub.interval_days, 1), 1)
      WHEN 'monthly'       THEN NULL
    END;

    SELECT MAX(scheduled_on) INTO _next FROM public.visits WHERE subscription_id = _sub.id;
    IF _next IS NULL THEN
      _candidate := _sub.started_on;
      IF _prefs IS NOT NULL AND _sub.frequency IN ('weekly','biweekly') THEN
        _guard := 0;
        WHILE NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_prefs)) AND _guard < 7 LOOP
          _candidate := _candidate + 1;
          _guard := _guard + 1;
        END LOOP;
      END IF;
    ELSE
      IF _sub.frequency = 'monthly' THEN
        _candidate := (_next + INTERVAL '1 month')::date;
      ELSE
        _candidate := _next + _step;
      END IF;
    END IF;

    WHILE _candidate <= _stop LOOP
      _base := _candidate;
      _guard := 0;
      WHILE (EXISTS (SELECT 1 FROM public.blackout_dates
                      WHERE organization_id = _org_id AND blackout_on = _candidate)
             OR (_prefs IS NULL
                 AND NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_work_days))))
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;

      IF _candidate > _stop THEN EXIT; END IF;

      IF NOT EXISTS (SELECT 1 FROM public.client_holds h
                      WHERE h.client_id = _sub.client_id
                        AND h.organization_id = _org_id
                        AND _candidate BETWEEN h.starts_on AND h.ends_on) THEN
        INSERT INTO public.visits
          (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
        VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
        ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
        IF FOUND THEN _inserted := _inserted + 1; END IF;
      END IF;

      IF _sub.frequency = 'monthly' THEN
        _candidate := (_base + INTERVAL '1 month')::date;
      ELSE
        _candidate := _candidate + _step;
      END IF;
    END LOOP;
  END LOOP;

  RETURN _inserted;
END;
$function$;

-- Same posture as every previous definition: the core is not callable by the
-- app, only through a wrapper that authorizes first.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

-- The wrapper createOneOffVisit calls. Same authorization as
-- generate_visits_through, scoped to one subscription, and it refuses a
-- subscription belonging to another organization rather than silently
-- generating nothing.
CREATE OR REPLACE FUNCTION public.generate_visits_for_subscription(
  _org_id uuid,
  _subscription_id uuid,
  _through date
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to generate visits for this organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.subscriptions
     WHERE id = _subscription_id AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'That service does not belong to this organization';
  END IF;
  RETURN public.generate_visits_core(_org_id, _through, _subscription_id);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.generate_visits_for_subscription(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_visits_for_subscription(uuid, uuid, date) TO authenticated;
