
ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS latitude double precision,
  ADD COLUMN IF NOT EXISTS longitude double precision;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS rescheduled_from date,
  ADD COLUMN IF NOT EXISTS weather_flagged boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS weather_note text;

CREATE OR REPLACE FUNCTION public.reschedule_visit(_visit_id uuid, _new_date date, _note text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE _org uuid; _old date; _status public.visit_status;
BEGIN
  SELECT organization_id, scheduled_on, status INTO _org, _old, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress') THEN
    RAISE EXCEPTION 'Only scheduled visits can be rescheduled';
  END IF;
  IF _new_date = _old THEN RETURN; END IF;

  UPDATE public.visits
     SET scheduled_on = _new_date,
         rescheduled_from = COALESCE(rescheduled_from, _old),
         weather_flagged = COALESCE(_note IS NOT NULL, false) OR weather_flagged,
         weather_note = COALESCE(_note, weather_note),
         assigned_staff_id = NULL,
         sequence = NULL,
         updated_at = now()
   WHERE id = _visit_id;
END;
$$;
