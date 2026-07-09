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
         sequence = NULL,
         assigned_staff_id = NULL,
         eta_start = NULL,
         eta_end = NULL,
         travel_km = NULL,
         travel_min = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = _visit_id;
END; $$;

GRANT EXECUTE ON FUNCTION public.portal_reschedule_visit(uuid, uuid, date) TO anon, authenticated;