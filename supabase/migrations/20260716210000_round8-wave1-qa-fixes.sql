-- QA fixes for round 8 wave 1 (adversarial review findings).
--
-- 1. client_holds cross-tenant hardening: the hold's client must belong to
--    the hold's org (validation trigger), and both the visit-clearing
--    trigger and generation guards filter by organization_id.
-- 2. complete_visit / office_complete_visit: only debit prepaid credit when
--    THIS call actually flipped the row (IF NOT FOUND guard) so two
--    concurrent completions can't double-debit.
-- 3. portal_list_client_addons: pending portal requests are visible to the
--    client (status 'pending') so they can see and withdraw them.

CREATE OR REPLACE FUNCTION public.tg_client_holds_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Client does not belong to this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS client_holds_validate ON public.client_holds;
CREATE TRIGGER client_holds_validate
  BEFORE INSERT OR UPDATE ON public.client_holds
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_holds_validate();

CREATE OR REPLACE FUNCTION public.tg_client_holds_remove_visits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  DELETE FROM public.visits
   WHERE client_id = NEW.client_id
     AND organization_id = NEW.organization_id
     AND status = 'scheduled'
     AND scheduled_on BETWEEN NEW.starts_on AND NEW.ends_on;
  RETURN NEW;
END;
$fn$;

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
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
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
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
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

CREATE OR REPLACE FUNCTION public.office_complete_visit(_visit_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _status public.visit_status; _sub_id uuid; _client uuid;
        _cadence public.billing_cadence; _price integer;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress') THEN
    RAISE EXCEPTION 'Only scheduled or in-progress visits can be completed';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(),
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END; $$;

CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE _has_photo boolean; _sub_id uuid; _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(),
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

drop function if exists public.portal_list_client_addons(uuid);
create or replace function public.portal_list_client_addons(_token uuid)
 returns table(addon_subscription_id uuid, addon_service_id uuid, name text,
   frequency addon_frequency, price_cents integer, quantity integer,
   next_charge_on date, status text, property_label text)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT s.id, s.addon_service_id, a.name, s.frequency, s.price_cents,
         s.quantity, s.next_charge_on, s.status, p.label
    FROM public.clients c
    JOIN public.addon_subscriptions s ON s.client_id = c.id
    JOIN public.addon_services a ON a.id = s.addon_service_id
    LEFT JOIN public.properties p ON p.id = s.property_id
   WHERE c.portal_token = _token AND c.active = true
  UNION ALL
  SELECT r.id, r.addon_service_id, a.name, r.frequency,
         r.unit_price_cents, r.quantity, NULL::date, 'pending', p.label
    FROM public.clients c
    JOIN public.addon_requests r ON r.client_id = c.id AND r.status = 'pending'
    JOIN public.addon_services a ON a.id = r.addon_service_id
    LEFT JOIN public.properties p ON p.id = r.property_id
   WHERE c.portal_token = _token AND c.active = true
  ORDER BY 8, 3;
$function$;
GRANT EXECUTE ON FUNCTION public.portal_list_client_addons(uuid) TO anon, authenticated;
