
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS preferred_weekdays int[] NULL;

ALTER TABLE public.subscriptions
  ADD CONSTRAINT preferred_weekdays_range
    CHECK (
      preferred_weekdays IS NULL OR (
        array_length(preferred_weekdays, 1) BETWEEN 1 AND 7
        AND preferred_weekdays <@ ARRAY[0,1,2,3,4,5,6]
      )
    );

CREATE TABLE IF NOT EXISTS public.blackout_dates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  blackout_on date NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, blackout_on)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.blackout_dates TO authenticated;
GRANT ALL ON public.blackout_dates TO service_role;

ALTER TABLE public.blackout_dates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blackout read" ON public.blackout_dates
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "blackout write" ON public.blackout_dates
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public.generate_visits_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _sub record;
  _next date;
  _candidate date;
  _inserted integer := 0;
  _prefs int[];
  _step int;
  _dow int;
  _guard int;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to generate visits for this organization';
  END IF;

  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on, s.preferred_weekdays
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    _prefs := _sub.preferred_weekdays;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;
      INSERT INTO public.visits
        (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      CONTINUE;
    END IF;

    IF _sub.frequency = 'twice_weekly' AND _prefs IS NOT NULL AND array_length(_prefs,1) >= 2 THEN
      _candidate := _sub.started_on;
      _candidate := _candidate - EXTRACT(DOW FROM _candidate)::int;
      WHILE _candidate <= _through LOOP
        FOREACH _dow IN ARRAY _prefs LOOP
          _next := _candidate + _dow;
          IF _next >= _sub.started_on AND _next <= _through
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

    WHILE _candidate <= _through LOOP
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;

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
$$;
