-- Org-level working days (owner QA round 4): "there should be a way to enter
-- work hours and work days, so the route isn't scheduled through non-working
-- hours". Work HOURS already exist (workday_start/end/timezone, anchored by
-- optimize_route_v2); this adds work DAYS and teaches visit generation to
-- respect them.
--
-- Default is all seven days so existing orgs' schedules do not shift until
-- the owner configures the setting (I2 regression protection). A
-- subscription's explicit preferred_weekdays always wins over the org-level
-- work days — a client-agreed Saturday stays a Saturday.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS work_days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}';

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_work_days_valid;
ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_work_days_valid CHECK (
    array_length(work_days, 1) >= 1
    AND work_days <@ '{0,1,2,3,4,5,6}'::integer[]
  );

-- Rebuild generate_visits_core: candidate dates that land on a non-working
-- day are shifted forward to the next working day (combined with the existing
-- blackout skip so a shift can't land on a blackout), EXCEPT when the
-- subscription carries explicit preferred_weekdays.
CREATE OR REPLACE FUNCTION public.generate_visits_core(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
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
  LOOP
    _prefs := _sub.preferred_weekdays;
    _stop := LEAST(_through, COALESCE(_sub.ends_on, _through));
    IF _stop < _sub.started_on THEN CONTINUE; END IF;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE (EXISTS (SELECT 1 FROM public.blackout_dates
                      WHERE organization_id = _org_id AND blackout_on = _candidate)
             OR NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_work_days)))
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
      -- Explicit client weekdays win over org work days.
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
        _candidate := (_candidate + INTERVAL '1 month')::date;
      ELSE
        _candidate := _candidate + _step;
      END IF;
    END LOOP;
  END LOOP;

  RETURN _inserted;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date) FROM PUBLIC, anon, authenticated;
