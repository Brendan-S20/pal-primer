-- Mobile grooming is bookable (#549, part of #412).
--
-- Grooming (#412, #477, #535) is built on main and was Coming soon. Since
-- #531 the flip is one row of the platform switch, public.platform_service_lines,
-- and not a list in code: 20261025200000 seeded mobile_grooming bookable =
-- false, customer_requestable = false, and this turns BOTH columns on, so the
-- portal's groom request (customerCanRequestService in src/lib/service-lines.ts,
-- which reads both) and the database agree:
--
--   bookable_service_lines()        answers {dog_walking, mobile_grooming,
--                                   pet_sitting, pet_waste, training}
--   customer_requestable_service_lines()
--                                   gains mobile_grooming. A client may ask
--                                   for a groom from the portal; the office
--                                   still books it (Book this groom), so a
--                                   request never becomes a visit on its own.
--                                   The app's booking doors (public signup,
--                                   booking link, receptionist, portal
--                                   one-off) leave grooming out by line
--                                   (OFFICE_BOOKED_LINES).
--   organizations_service_lines_bookable
--                                   an owner may now add mobile grooming
--
-- Training stays customer_requestable = false: it is sold by the office.
-- Pet waste, walking, sitting and training are not touched. Portal vaccine
-- uploads stay off (PORTAL_VACCINE_UPLOADS_ENABLED in code); records the
-- office keeps on file are unchanged.
--
-- portal_request_groom is restated with one change. 20261024100400 refused a
-- request only while grooming was not bookable. With grooming bookable, a
-- platform admin who turns customer_requestable off (keeping grooming
-- office-only) must close the portal door too, as customerCanRequestService
-- already does in the app. The refusal
-- is the same 'groom_requests_off', in the same place: before any pet,
-- service or day is looked at. Every other line of the body is as
-- 20261024100400 wrote it, and the grants are restated with it.
--
-- The UPDATE goes through tg_platform_service_lines_audit like any other
-- change, so it is in platform_admin_audit with no actor ("nobody did it":
-- a migration). A database where a platform admin already turned grooming
-- on matches no row and is left as it is, so nothing is logged twice.
--
-- Replays into an empty database: 20261025200000 seeds the row this updates,
-- and 20261024100400 creates the function this replaces. Idempotent.

UPDATE public.platform_service_lines
   SET bookable = true, customer_requestable = true
 WHERE service_line = 'mobile_grooming'
   AND (bookable IS DISTINCT FROM true OR customer_requestable IS DISTINCT FROM true);

-- ── portal_request_groom asks both switches ──────────────────────────────

CREATE OR REPLACE FUNCTION public.portal_request_groom(
  _token uuid, _dog_id uuid, _service_id uuid, _addons jsonb, _on date,
  _from time, _until time, _message text, _quoted_cents integer, _quoted_minutes integer
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
  _lines text[];
  _tz text;
  _work int[];
  _today date;
  _property_id uuid;
  _item jsonb;
  _addon_id uuid;
  _qty integer;
  _seen uuid[] := ARRAY[]::uuid[];
  _clean jsonb := '[]'::jsonb;
  _open integer;
  _id uuid;
BEGIN
  SELECT c.id, c.organization_id INTO _client_id, _org_id
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _client_id IS NULL THEN RAISE EXCEPTION 'invalid_token'; END IF;

  SELECT o.service_lines, COALESCE(NULLIF(o.timezone, ''), 'America/Chicago'), o.work_days
    INTO _lines, _tz, _work
    FROM public.organizations o WHERE o.id = _org_id;
  IF NOT ('mobile_grooming' = ANY (COALESCE(_lines, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'grooming_not_offered';
  END IF;
  -- Both switches, as customerCanRequestService('mobile_grooming') reads
  -- them: a Coming soon line is not for sale, and a bookable line the
  -- platform keeps with the office is not for a customer to ask for.
  IF NOT ('mobile_grooming' = ANY (public.bookable_service_lines()))
     OR NOT ('mobile_grooming' = ANY (public.customer_requestable_service_lines())) THEN
    RAISE EXCEPTION 'groom_requests_off';
  END IF;

  -- Another client's pet, an inactive one and one that does not exist are
  -- the same refusal, so the answer says nothing about pets that are not
  -- theirs. The request is for the address the pet lives at.
  SELECT d.property_id INTO _property_id
    FROM public.dogs d
    JOIN public.properties p ON p.id = d.property_id
   WHERE d.id = _dog_id AND d.organization_id = _org_id AND d.active IS NOT FALSE
     AND p.client_id = _client_id AND p.organization_id = _org_id AND p.archived_at IS NULL;
  IF _property_id IS NULL THEN RAISE EXCEPTION 'pet_not_found'; END IF;

  PERFORM 1 FROM public.services s
    WHERE s.id = _service_id AND s.organization_id = _org_id AND s.active
      AND s.service_line = 'mobile_grooming';
  IF NOT FOUND THEN RAISE EXCEPTION 'service_not_offered'; END IF;

  IF _addons IS NULL OR jsonb_typeof(_addons) <> 'array' OR jsonb_array_length(_addons) > 20 THEN
    RAISE EXCEPTION 'addon_not_offered';
  END IF;
  FOR _item IN SELECT * FROM jsonb_array_elements(_addons) LOOP
    BEGIN
      _addon_id := (_item ->> 'addon_service_id')::uuid;
      _qty := (_item ->> 'quantity')::integer;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'addon_not_offered';
    END;
    IF _addon_id IS NULL OR _qty IS NULL OR _qty < 1 OR _qty > 20 OR _addon_id = ANY (_seen) THEN
      RAISE EXCEPTION 'addon_not_offered';
    END IF;
    PERFORM 1 FROM public.addon_services a
      WHERE a.id = _addon_id AND a.organization_id = _org_id AND a.active
        AND (a.service_line IS NULL OR a.service_line = 'mobile_grooming');
    IF NOT FOUND THEN RAISE EXCEPTION 'addon_not_offered'; END IF;
    _seen := _seen || _addon_id;
    _clean := _clean || jsonb_build_array(jsonb_build_object('addon_service_id', _addon_id, 'quantity', _qty));
  END LOOP;

  -- Tomorrow through 90 days on the BUSINESS's calendar.
  _today := (now() AT TIME ZONE _tz)::date;
  IF _on IS NULL OR _on <= _today THEN RAISE EXCEPTION 'date_too_soon'; END IF;
  IF _on > _today + 90 THEN RAISE EXCEPTION 'date_too_far'; END IF;
  IF NOT (extract(dow FROM _on)::int = ANY (COALESCE(_work, ARRAY[0,1,2,3,4,5,6]))) THEN
    RAISE EXCEPTION 'not_a_working_day';
  END IF;
  PERFORM 1 FROM public.blackout_dates b WHERE b.organization_id = _org_id AND b.blackout_on = _on;
  IF FOUND THEN RAISE EXCEPTION 'blackout_day'; END IF;

  IF (_from IS NULL) <> (_until IS NULL) OR (_from IS NOT NULL AND _from >= _until) THEN
    RAISE EXCEPTION 'bad_window';
  END IF;
  IF _quoted_cents IS NOT NULL AND _quoted_cents < 0
     OR _quoted_minutes IS NOT NULL AND (_quoted_minutes < 1 OR _quoted_minutes > 720) THEN
    RAISE EXCEPTION 'bad_quote';
  END IF;

  -- Asked already for this pet and day: hand back that request.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'groom_request' AND t.dog_id = _dog_id
     AND t.requested_on = _on AND t.status <> 'resolved'
   LIMIT 1;
  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, false;
    RETURN;
  END IF;

  SELECT count(*) INTO _open FROM public.qc_tickets t
   WHERE t.category = 'groom_request' AND t.client_id = _client_id AND t.status <> 'resolved';
  IF _open >= 10 THEN RAISE EXCEPTION 'too_many_open_requests'; END IF;

  INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category,
    requested_on, requested_time, requested_time_end, message, service_id, dog_id,
    groom_addons, quoted_cents, quoted_minutes)
  VALUES (_org_id, _client_id, _property_id, 'groom_request', _on, _from, _until,
    left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000), _service_id, _dog_id,
    _clean, _quoted_cents, _quoted_minutes)
  ON CONFLICT (dog_id, requested_on)
    WHERE category = 'groom_request' AND status <> 'resolved'
  DO NOTHING
  RETURNING id INTO _id;

  IF _id IS NOT NULL THEN
    RETURN QUERY SELECT _id, true;
    RETURN;
  END IF;
  -- Lost a race with a concurrent tap: the other one's request is this one.
  SELECT t.id INTO _id FROM public.qc_tickets t
   WHERE t.category = 'groom_request' AND t.dog_id = _dog_id
     AND t.requested_on = _on AND t.status <> 'resolved'
   LIMIT 1;
  RETURN QUERY SELECT _id, false;
END $function$;

REVOKE ALL ON FUNCTION public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer)
  TO service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn CONSTANT text := 'public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer)';
  _src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_service_lines
     WHERE service_line = 'mobile_grooming' AND bookable AND customer_requestable
  ) THEN
    RAISE EXCEPTION 'mobile_grooming is not bookable and customer requestable';
  END IF;
  IF NOT ('mobile_grooming' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'bookable_service_lines() does not answer mobile_grooming';
  END IF;
  IF NOT ('mobile_grooming' = ANY (public.customer_requestable_service_lines())) THEN
    RAISE EXCEPTION 'customer_requestable_service_lines() does not answer mobile_grooming';
  END IF;
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'customer_requestable_service_lines() answers training';
  END IF;

  IF to_regprocedure(_fn) IS NULL THEN
    RAISE EXCEPTION '% is missing', _fn;
  END IF;
  _src := (SELECT p.prosrc FROM pg_proc p WHERE p.oid = to_regprocedure(_fn));
  IF strpos(_src, 'public.bookable_service_lines()') = 0
     OR strpos(_src, 'public.customer_requestable_service_lines()') = 0 THEN
    RAISE EXCEPTION '% does not ask both switches before taking a groom request', _fn;
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE')
     OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is callable with a client key; the portal reaches it as service_role.', _fn;
  END IF;
  IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is not callable by the portal server.', _fn;
  END IF;
END
$post$;
