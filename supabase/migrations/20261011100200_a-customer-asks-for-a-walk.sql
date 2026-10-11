-- A customer asks for a walk (the service catalog, phase 5, portal booking).
--
-- The portal's one-off booking offered one thing, "an extra cleanup", at one
-- price, organizations.one_off_price_cents. A dog walker's client has no
-- cleanup to ask for; a scooper who also walks has two things a client might
-- want on Friday. The portal now lists the business's active, priced services
-- (src/lib/portal.functions.ts, portalOneOffBookingOptions), and the request
-- has to say WHICH one was asked for, or the office books the default
-- (pet waste) at the wrong price.
--
-- ── THE COLUMN ───────────────────────────────────────────────────────────
--
-- qc_tickets.service_id, nullable. NULL is every request made before this
-- file, and every request for the business's pet-waste service when it is
-- the only thing on offer: it means "the extra cleanup, at the one-off
-- price", exactly as it always has. A name written into the message instead
-- of a column would read fine in the inbox and could not be booked from.
--
-- ── THE FUNCTION ─────────────────────────────────────────────────────────
--
-- portal_request_one_off gains `_service_id uuid DEFAULT NULL`, last, so the
-- four-argument call the portal and the AI receptionist make today is the
-- same call. A service named has to be this business's and active, or the
-- request is refused with 'service_not_offered' (oneOffRefusalMessage says
-- it in words); the other rules -- tomorrow through 30 days, a working day,
-- not blacked out, one request per property per day -- are the 20260929050000
-- body unchanged. The four-argument function is dropped, not overloaded, for
-- the PostgREST reason every signature change here gives.
--
-- Mirrors portal_request_reclean: postgres and service_role, nobody else.
--
-- Replays into an empty database: a column and a function. No row is needed.

ALTER TABLE public.qc_tickets
  ADD COLUMN IF NOT EXISTS service_id uuid REFERENCES public.services(id);

COMMENT ON COLUMN public.qc_tickets.service_id IS
  'For a one_off_request: the service the customer asked for. NULL is the business''s pet-waste service at its one-off price, as every request before 20261011100200 was.';

CREATE INDEX IF NOT EXISTS qc_tickets_service_id_idx ON public.qc_tickets (service_id)
  WHERE service_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.portal_request_one_off(uuid, uuid, date, text);

CREATE OR REPLACE FUNCTION public.portal_request_one_off(
  _token uuid, _property_id uuid, _on date, _message text,
  _service_id uuid DEFAULT NULL
)
RETURNS TABLE (ticket_id uuid, created boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  _client_id uuid;
  _org_id uuid;
  _tz text;
  _work int[];
  _today date;
  _id uuid;
BEGIN
  SELECT c.id, c.organization_id INTO _client_id, _org_id
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;

  -- The client's own, live property. Anything else -- another client's, an
  -- archived one, one that does not exist -- is the same refusal, so the
  -- answer says nothing about properties that are not theirs.
  PERFORM 1 FROM public.properties p
    WHERE p.id = _property_id AND p.client_id = _client_id
      AND p.organization_id = _org_id AND p.archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'property_not_found'; END IF;

  -- The service asked for: this business's, and still offered. Another
  -- business's id and a deactivated one are the same refusal.
  IF _service_id IS NOT NULL THEN
    PERFORM 1 FROM public.services s
      WHERE s.id = _service_id AND s.organization_id = _org_id AND s.active;
    IF NOT FOUND THEN RAISE EXCEPTION 'service_not_offered'; END IF;
  END IF;

  SELECT COALESCE(NULLIF(o.timezone, ''), 'America/Chicago'), o.work_days
    INTO _tz, _work
    FROM public.organizations o WHERE o.id = _org_id;
  -- "Tomorrow" on the ORGANIZATION's calendar, not the server's.
  _today := (now() AT TIME ZONE _tz)::date;

  IF _on IS NULL OR _on < _today THEN RAISE EXCEPTION 'date_in_past'; END IF;
  IF _on = _today THEN RAISE EXCEPTION 'date_too_soon'; END IF;
  IF _on > _today + 30 THEN RAISE EXCEPTION 'date_too_far'; END IF;
  -- work_days is 0 = Sunday, the same numbering as extract(dow) and as the
  -- visit generator that would otherwise decline the booking.
  IF NOT (extract(dow FROM _on)::int = ANY (COALESCE(_work, ARRAY[0,1,2,3,4,5,6]))) THEN
    RAISE EXCEPTION 'not_a_working_day';
  END IF;
  PERFORM 1 FROM public.blackout_dates b WHERE b.organization_id = _org_id AND b.blackout_on = _on;
  IF FOUND THEN RAISE EXCEPTION 'blackout_day'; END IF;

  -- Asked already: hand back that request, open or already booked. Before the
  -- "already has a visit" refusal on purpose -- after auto-accept books the
  -- first tap, the second tap must find the request, not the visit.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'one_off_request' AND t.client_id = _client_id
     AND t.property_id = _property_id AND t.requested_on = _on
     AND (t.status <> 'resolved' OR t.booked_visit_id IS NOT NULL)
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, false;
    RETURN;
  END IF;

  PERFORM 1 FROM public.visits v
    WHERE v.property_id = _property_id AND v.scheduled_on = _on
      AND v.status NOT IN ('skipped', 'canceled');
  IF FOUND THEN RAISE EXCEPTION 'already_scheduled'; END IF;

  INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category, requested_on, message, service_id)
  VALUES (_org_id, _client_id, _property_id, 'one_off_request', _on,
          left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000), _service_id)
  ON CONFLICT (property_id, requested_on) WHERE category = 'one_off_request' AND status <> 'resolved'
  DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, true;
    RETURN;
  END IF;
  -- Lost a race with a concurrent tap: the other one's request is this one.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'one_off_request' AND t.property_id = _property_id
     AND t.requested_on = _on AND t.status <> 'resolved'
   LIMIT 1;
  RETURN QUERY SELECT _id, false;
END $function$;

-- Mirrors portal_request_reclean exactly: postgres and service_role, nobody
-- else. The default privileges on public hand new functions to authenticated
-- too, so that grant is taken back here as well.
REVOKE ALL ON FUNCTION public.portal_request_one_off(uuid, uuid, date, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_one_off(uuid, uuid, date, text, uuid) TO service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'qc_tickets' AND column_name = 'service_id'
  ) THEN
    RAISE EXCEPTION 'qc_tickets.service_id was not created';
  END IF;
  IF to_regprocedure('public.portal_request_one_off(uuid, uuid, date, text)') IS NOT NULL THEN
    RAISE EXCEPTION 'the four-argument portal_request_one_off is still there; PostgREST cannot choose between two';
  END IF;
  IF to_regprocedure('public.portal_request_one_off(uuid, uuid, date, text, uuid)') IS NULL THEN
    RAISE EXCEPTION 'portal_request_one_off(uuid, uuid, date, text, uuid) was not created';
  END IF;
  IF has_function_privilege('anon', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_request_one_off is reachable by an API role; it is the server''s to call';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot call portal_request_one_off';
  END IF;
END
$post$;
