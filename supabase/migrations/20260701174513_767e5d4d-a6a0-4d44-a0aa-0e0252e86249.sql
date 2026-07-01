
CREATE OR REPLACE FUNCTION public.reassign_visit(_visit_id uuid, _staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.visits WHERE id = _visit_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;
  IF NOT public.can_write_org(v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  IF _staff_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = v_org) THEN
    RAISE EXCEPTION 'staff not in org';
  END IF;
  UPDATE public.visits SET assigned_staff_id = _staff_id, sequence = NULL, updated_at = now() WHERE id = _visit_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reorder_route(_staff_id uuid, _day date, _ordered_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_org uuid; v_id uuid; v_seq integer := 1; v_updated integer := 0;
BEGIN
  SELECT organization_id INTO v_org FROM public.staff WHERE id = _staff_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'staff not found'; END IF;
  IF NOT public.can_write_org(v_org) THEN RAISE EXCEPTION 'forbidden'; END IF;
  FOREACH v_id IN ARRAY _ordered_ids LOOP
    UPDATE public.visits
       SET assigned_staff_id = _staff_id, sequence = v_seq, updated_at = now()
     WHERE id = v_id AND organization_id = v_org AND scheduled_on = _day;
    IF FOUND THEN v_updated := v_updated + 1; END IF;
    v_seq := v_seq + 1;
  END LOOP;
  RETURN v_updated;
END;
$$;

REVOKE ALL ON FUNCTION public.reassign_visit(uuid, uuid) FROM public;
REVOKE ALL ON FUNCTION public.reorder_route(uuid, date, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.reassign_visit(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reorder_route(uuid, date, uuid[]) TO authenticated;
