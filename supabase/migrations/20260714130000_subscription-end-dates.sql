-- Client detail rework: subscriptions get an optional end date. Visit
-- generation stops at ends_on (all frequencies), and shortening/setting the
-- end date trims already-generated future visits that fall past it.
-- generate_visits_through and admin_generate_visits_through previously
-- duplicated the same 90-line body; both now delegate to one core so the
-- schedule logic can't drift between them again.

ALTER TABLE public.subscriptions ADD COLUMN ends_on date;

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
BEGIN
  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on, s.ends_on, s.preferred_weekdays
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    _prefs := _sub.preferred_weekdays;
    -- Generation never runs past the subscription's end date.
    _stop := LEAST(_through, COALESCE(_sub.ends_on, _through));
    IF _stop < _sub.started_on THEN CONTINUE; END IF;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;
      IF _sub.ends_on IS NULL OR _candidate <= _sub.ends_on THEN
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
                              WHERE organization_id = _org_id AND blackout_on = _next) THEN
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
      WHEN 'weekly'       THEN 7
      WHEN 'biweekly'     THEN 14
      WHEN 'twice_weekly' THEN 3
      WHEN 'monthly'      THEN NULL
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
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;

      IF _candidate > _stop THEN EXIT; END IF;

      INSERT INTO public.visits
        (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      IF FOUND THEN _inserted := _inserted + 1; END IF;

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

-- Core is internal: callable only through the two wrappers below.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.generate_visits_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to generate visits for this organization';
  END IF;
  RETURN public.generate_visits_core(_org_id, _through);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.admin_generate_visits_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  RETURN public.generate_visits_core(_org_id, _through);
END;
$fn$;

-- Preserve the existing grant posture on the admin variant.
REVOKE EXECUTE ON FUNCTION public.admin_generate_visits_through(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_visits_through(uuid, date) TO service_role;

-- Setting or shortening an end date removes future scheduled visits that now
-- fall past it (started/completed visits are never touched).
CREATE OR REPLACE FUNCTION public.tg_subscriptions_trim_after_end()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.ends_on IS NOT NULL AND NEW.ends_on IS DISTINCT FROM OLD.ends_on THEN
    DELETE FROM public.visits
     WHERE subscription_id = NEW.id
       AND scheduled_on > NEW.ends_on
       AND status = 'scheduled';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS subscriptions_trim_after_end ON public.subscriptions;
CREATE TRIGGER subscriptions_trim_after_end
  AFTER UPDATE OF ends_on ON public.subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.tg_subscriptions_trim_after_end();
