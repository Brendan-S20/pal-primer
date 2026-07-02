
CREATE OR REPLACE FUNCTION public.portal_list_recent_visits(_token uuid)
RETURNS TABLE(visit_id uuid, scheduled_on date, status public.visit_status, photo_paths text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.scheduled_on, v.status,
         COALESCE(ARRAY(
           SELECT vp.storage_path FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at
         ), ARRAY[]::text[])
    FROM public.visits v
    JOIN public.clients c ON c.id = v.client_id
   WHERE c.portal_token = _token AND c.active = true
     AND v.status IN ('completed','skipped')
   ORDER BY v.scheduled_on DESC
   LIMIT 20
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_recent_visits(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_list_dogs(_token uuid)
RETURNS TABLE(dog_id uuid, name text, breed text, weight_class text,
              temperament text, notes text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.name, d.breed, d.weight_class,
         d.temperament::text, d.notes
    FROM public.dogs d
    JOIN public.properties p ON p.id = d.property_id
    JOIN public.clients c ON c.id = p.client_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY d.name
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_dogs(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_report_concern(
  _token uuid, _visit_id uuid, _category text, _message text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _client_id uuid; _org_id uuid; _ticket_id uuid;
BEGIN
  SELECT id, organization_id INTO _client_id, _org_id
    FROM public.clients WHERE portal_token = _token AND active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;
  IF _category NOT IN ('missed_spot','gate_left_open','damage','wrong_yard','other') THEN
    RAISE EXCEPTION 'invalid_category';
  END IF;
  IF _visit_id IS NOT NULL THEN
    PERFORM 1 FROM public.visits WHERE id = _visit_id AND client_id = _client_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'visit_not_found'; END IF;
  END IF;
  INSERT INTO public.qc_tickets(organization_id, client_id, visit_id, category, message)
    VALUES(_org_id, _client_id, _visit_id, _category, NULLIF(_message,''))
  RETURNING id INTO _ticket_id;
  RETURN _ticket_id;
END $$;
GRANT EXECUTE ON FUNCTION public.portal_report_concern(uuid, uuid, text, text) TO anon, authenticated;
