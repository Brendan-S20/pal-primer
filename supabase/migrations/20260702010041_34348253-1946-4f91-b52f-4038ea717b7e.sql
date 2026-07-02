
CREATE OR REPLACE FUNCTION public.portal_reschedule_visit(
  _token uuid, _visit_id uuid, _new_date date
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _sub uuid; _old date;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  SELECT v.subscription_id, v.scheduled_on INTO _sub, _old
    FROM public.visits v
   WHERE v.id = _visit_id AND v.client_id = _cid AND v.status = 'scheduled';
  IF _sub IS NULL THEN RAISE EXCEPTION 'Visit not eligible to reschedule'; END IF;

  IF _new_date < (CURRENT_DATE + 1) THEN
    RAISE EXCEPTION 'Choose a date at least one day in the future';
  END IF;
  IF _new_date > (CURRENT_DATE + 60) THEN
    RAISE EXCEPTION 'Reschedule window is 60 days';
  END IF;

  IF EXISTS (SELECT 1 FROM public.visits
              WHERE subscription_id = _sub AND scheduled_on = _new_date AND id <> _visit_id) THEN
    RAISE EXCEPTION 'A visit is already scheduled on that date';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_line_items WHERE visit_id = _visit_id) THEN
    RAISE EXCEPTION 'Visit is already invoiced';
  END IF;

  UPDATE public.visits
     SET scheduled_on = _new_date,
         route_order = NULL,
         assigned_staff_id = NULL,
         eta_start = NULL,
         eta_end = NULL,
         travel_km = NULL,
         travel_min = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = _visit_id;
END; $$;

CREATE OR REPLACE FUNCTION public.portal_change_frequency(
  _token uuid, _subscription_id uuid, _new_frequency public.service_frequency
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _cur public.service_frequency;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  SELECT frequency INTO _cur FROM public.subscriptions
   WHERE id = _subscription_id AND client_id = _cid;
  IF _cur IS NULL THEN RAISE EXCEPTION 'Subscription not found'; END IF;
  IF _new_frequency = 'one_time' THEN RAISE EXCEPTION 'Cannot switch to one-time via portal'; END IF;
  IF _new_frequency = _cur THEN RETURN; END IF;

  UPDATE public.subscriptions
     SET frequency = _new_frequency, updated_at = now()
   WHERE id = _subscription_id;

  DELETE FROM public.visits v
   WHERE v.subscription_id = _subscription_id
     AND v.scheduled_on > CURRENT_DATE
     AND v.status = 'scheduled'
     AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id);
END; $$;

CREATE OR REPLACE FUNCTION public.portal_list_addon_catalog(_token uuid)
RETURNS TABLE(
  addon_service_id uuid, code text, name text, description text,
  kind public.addon_kind, unit_price_cents integer,
  default_frequency public.addon_frequency
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.code, a.name, a.description, a.kind, a.unit_price_cents, a.default_frequency
    FROM public.clients c
    JOIN public.addon_services a ON a.organization_id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true AND a.active = true
   ORDER BY a.name;
$$;

CREATE OR REPLACE FUNCTION public.portal_list_client_addons(_token uuid)
RETURNS TABLE(
  addon_subscription_id uuid, addon_service_id uuid, name text,
  frequency public.addon_frequency, price_cents integer, quantity integer,
  next_charge_on date, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.addon_service_id, a.name, s.frequency, s.price_cents,
         s.quantity, s.next_charge_on, s.status
    FROM public.clients c
    JOIN public.addon_subscriptions s ON s.client_id = c.id
    JOIN public.addon_services a ON a.id = s.addon_service_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY s.status, a.name;
$$;

CREATE OR REPLACE FUNCTION public.portal_subscribe_addon(
  _token uuid, _addon_service_id uuid, _frequency public.addon_frequency, _quantity integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _svc record; _id uuid; _q integer;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  _q := GREATEST(1, COALESCE(_quantity, 1));

  SELECT * INTO _svc FROM public.addon_services
   WHERE id = _addon_service_id AND organization_id = _org AND active = true;
  IF _svc.id IS NULL THEN RAISE EXCEPTION 'Add-on unavailable'; END IF;

  IF _svc.kind = 'one_time' THEN
    INSERT INTO public.addon_charges(organization_id, client_id, addon_service_id,
      description, unit_price_cents, quantity, amount_cents, source)
    VALUES (_org, _cid, _svc.id, _svc.name, _svc.unit_price_cents, _q,
      _svc.unit_price_cents * _q, 'office')
    RETURNING id INTO _id;
    RETURN _id;
  END IF;

  IF _frequency IS NULL AND _svc.default_frequency IS NULL THEN
    RAISE EXCEPTION 'Frequency required for this add-on';
  END IF;
  INSERT INTO public.addon_subscriptions(organization_id, client_id, addon_service_id,
    frequency, price_cents, quantity, next_charge_on, status)
  VALUES (_org, _cid, _svc.id, COALESCE(_frequency, _svc.default_frequency),
    _svc.unit_price_cents, _q, CURRENT_DATE, 'active')
  RETURNING id INTO _id;
  RETURN _id;
END; $$;

CREATE OR REPLACE FUNCTION public.portal_cancel_addon(
  _token uuid, _addon_subscription_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid;
BEGIN
  SELECT id INTO _cid FROM public.clients WHERE portal_token = _token AND active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  UPDATE public.addon_subscriptions
     SET status = 'canceled', updated_at = now()
   WHERE id = _addon_subscription_id AND client_id = _cid;
END; $$;

GRANT EXECUTE ON FUNCTION public.portal_reschedule_visit(uuid, uuid, date) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_change_frequency(uuid, uuid, public.service_frequency) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_addon_catalog(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_client_addons(uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_subscribe_addon(uuid, uuid, public.addon_frequency, integer) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_cancel_addon(uuid, uuid) TO anon, authenticated;
