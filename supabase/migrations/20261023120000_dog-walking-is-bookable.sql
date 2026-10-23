-- Dog walking is bookable (#530).
--
-- Walking (#410) is built on main (#468, #470, #472, #473) and was Coming
-- soon. This is the database half of the flip; the app half is
-- BOOKABLE_SERVICE_LINES in src/lib/service-lines.ts, which now reads
-- ["pet_waste", "dog_walking"]. tests/a-service-line-is-turned-on-only-when-bookable.test.ts
-- fails while the two differ.
--
-- What changes:
--
--   1. public.bookable_service_lines() (first defined in 20261017004000,
--      which is applied and is not edited) answers {pet_waste, dog_walking}.
--      Everything that asks it follows on its own:
--        organizations_service_lines_bookable  an owner's REST write may now
--                                              add dog_walking; pet sitting,
--                                              grooming and training are
--                                              still refused
--        public_services                       lists an active walk WITH a
--                                              price; an unpriced one stays
--                                              out (its own price filter,
--                                              unchanged)
--        public_quote                          prices a walk; an unpriced
--                                              walk answers a NULL price,
--                                              which signupChargeFromQuote
--                                              refuses (no card is taken)
--        portal_request_one_off                see 2
--      public_services and public_quote are therefore not restated: their
--      newest bodies (20261018150000) gate on bookable_service_lines() and
--      not on a literal 'pet_waste', so restating them unchanged would add a
--      copy and change nothing.
--
--   2. portal_request_one_off (newest body 20261018150000, copied unchanged
--      but for ONE condition) also refuses a service with no price yet, with
--      the same 'service_not_offered'. Before walking was bookable no
--      non-pet-waste service could get this far, so the gap was unreachable;
--      now a hand-built request for an unpriced walk would be recorded as a
--      request nobody can price. The portal's own picker
--      (oneOffServiceOptions) and portalRequestOneOff already leave one out;
--      this is the same rule where the service role meets it.
--
-- Pet waste is unchanged: it is still bookable, still priced by zone (its
-- NULL base_price_cents is exempt from the price condition, exactly as in
-- public_services), and no row of any table is read or written here.
--
-- Pet sitting, mobile grooming and training stay Coming soon; each flips in
-- its own PR after its own QA.
--
-- Replays into an empty database: two function bodies, no rows. Idempotent.

-- ── 1. The launch list ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bookable_service_lines()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT ARRAY['pet_waste', 'dog_walking']::text[];
$function$;

REVOKE ALL ON FUNCTION public.bookable_service_lines() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bookable_service_lines() TO authenticated, service_role;

-- ── 2. portal_request_one_off: an unpriced service is not offered ────────

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
  _asked_service uuid;
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
  -- business's id, a deactivated one, one on a line that is still Coming
  -- soon (20261018150000) and one with no price yet (20261023120000) are the
  -- same refusal.
  IF _service_id IS NOT NULL THEN
    PERFORM 1 FROM public.services s
      WHERE s.id = _service_id AND s.organization_id = _org_id AND s.active
        AND s.service_line = ANY (public.bookable_service_lines())
        AND (s.service_line = 'pet_waste' OR s.base_price_cents IS NOT NULL);
    IF NOT FOUND THEN RAISE EXCEPTION 'service_not_offered'; END IF;
    -- The pet-waste service is the extra cleanup: recorded as no service.
    IF (SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = 'pet_waste' THEN
      _service_id := NULL;
    END IF;
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
     AND t.service_id IS NOT DISTINCT FROM _service_id
     AND (t.status <> 'resolved' OR t.booked_visit_id IS NOT NULL)
   ORDER BY t.created_at DESC
   LIMIT 1;
  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, false;
    RETURN;
  END IF;

  -- A visit of THIS service that day is already on the schedule. The extra
  -- cleanup is the business's pet-waste service (ensure_default_services, the
  -- same answer the visit triggers give a visit with no service).
  _asked_service := COALESCE(_service_id, public.ensure_default_services(_org_id));
  PERFORM 1 FROM public.visits v
    WHERE v.property_id = _property_id AND v.scheduled_on = _on
      AND v.status NOT IN ('skipped', 'canceled')
      AND COALESCE(v.service_id, public.ensure_default_services(_org_id)) IS NOT DISTINCT FROM _asked_service;
  IF FOUND THEN RAISE EXCEPTION 'already_scheduled'; END IF;

  INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category, requested_on, message, service_id)
  VALUES (_org_id, _client_id, _property_id, 'one_off_request', _on,
          left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000), _service_id)
  ON CONFLICT (property_id, requested_on, COALESCE(service_id, '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE category = 'one_off_request' AND status <> 'resolved'
  DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, true;
    RETURN;
  END IF;
  -- Lost a race with a concurrent tap: the other one's request is this one.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'one_off_request' AND t.property_id = _property_id
     AND t.requested_on = _on AND t.service_id IS NOT DISTINCT FROM _service_id
     AND t.status <> 'resolved'
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
DECLARE
  _fn text;
BEGIN
  -- Exactly pet waste and dog walking, in that order. Not a superset: sitting,
  -- grooming and training each flip after their own QA.
  IF public.bookable_service_lines() IS DISTINCT FROM ARRAY['pet_waste', 'dog_walking']::text[] THEN
    RAISE EXCEPTION 'bookable_service_lines() is %, want {pet_waste,dog_walking}',
      public.bookable_service_lines();
  END IF;
  IF NOT public.service_lines_are_valid(public.bookable_service_lines()) THEN
    RAISE EXCEPTION 'bookable_service_lines() holds a value service_lines_are_valid refuses';
  END IF;
  IF has_function_privilege('anon', 'public.bookable_service_lines()', 'EXECUTE') THEN
    RAISE EXCEPTION 'bookable_service_lines is callable by anon';
  END IF;

  -- The three doors still ask the list, so the flip reaches all of them.
  -- Named functions only, read through prosrc.
  FOREACH _fn IN ARRAY ARRAY['public_services', 'public_quote', 'portal_request_one_off'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%s.service_line = ANY (public.bookable_service_lines())%'
    ) THEN
      RAISE EXCEPTION '% does not filter on bookable_service_lines()', _fn;
    END IF;
  END LOOP;

  -- An unpriced service is offered by none of the doors that list or take one.
  FOREACH _fn IN ARRAY ARRAY['public_services', 'portal_request_one_off'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname = _fn
         AND p.prosrc LIKE '%s.service_line = ''pet_waste'' OR s.base_price_cents IS NOT NULL%'
    ) THEN
      RAISE EXCEPTION '% offers a service with no price', _fn;
    END IF;
  END LOOP;

  -- The REST gate still reads the list.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.organizations'::regclass
       AND tgname = 'organizations_service_lines_bookable'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'organizations_service_lines_bookable is not on public.organizations';
  END IF;

  -- portal_request_one_off is the server's to call, as before.
  IF has_function_privilege('anon', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_request_one_off is reachable by an API role; it is the server''s to call';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the portal server lost portal_request_one_off';
  END IF;
END
$post$;
