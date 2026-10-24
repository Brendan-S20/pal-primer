-- A Coming soon service is not for sale (#506).
--
-- Only pet waste is in BOOKABLE_SERVICE_LINES (src/lib/service-lines.ts), and
-- public.bookable_service_lines() (20261017004000) is its one SQL copy. An
-- owner may still add a walk or a sit in Settings -> Services, to have prices
-- ready for launch, and that is meant to keep working: nothing here touches
-- the services table, and no trigger or constraint is added to it.
--
-- What was open, on main today and not only on this branch: the three doors a
-- stranger or a client reaches a service through did not ask about the line.
--
--   public_services         listed every active, priced service to anon, so
--                           the public signup and quote form offered a walk
--   public_quote            priced that walk for anon, so a card could be
--                           taken for it at signup
--   portal_request_one_off  recorded a request for it from the portal
--
-- The app now refuses each of these too (publicServiceChoices, the signup
-- server functions, /api/public/leads, portalRequestOneOff). This puts the
-- same rule where the publishable key and the service role both meet it, as
-- defence in depth.
--
-- Each function is its newest definition copied unchanged (public_services
-- from 20261011170000, public_quote from 20261011100000,
-- portal_request_one_off from 20261011100200) with ONE condition added to its
-- service filter: `s.service_line = ANY (public.bookable_service_lines())`.
-- A Coming soon service is then treated exactly like an unknown or a
-- deactivated one: public_services leaves it out, public_quote answers
-- nothing, portal_request_one_off raises 'service_not_offered'. Signatures,
-- SECURITY DEFINER, search_path, grants and comments are as they were.
--
-- bookable_service_lines() is not callable by anon. It does not need to be:
-- all three functions are SECURITY DEFINER and call it as their owner.
--
-- Replays into an empty database: three function bodies, no rows read.
-- Idempotent.

-- ── 1. public_services: lists only what is bookable ──────────────────────

CREATE OR REPLACE FUNCTION public.public_services(_slug text)
RETURNS TABLE(
  id uuid,
  name text,
  service_line text,
  price_unit text,
  base_price_cents integer,
  extra_pet_cents integer,
  default_duration_min integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.id, s.name, s.service_line, s.price_unit,
           s.base_price_cents, s.extra_pet_cents, s.default_duration_min::integer
      FROM public.services s
     WHERE s.organization_id = _org.id
       AND s.active
       AND s.service_line = ANY (public.bookable_service_lines())
       AND (s.service_line = 'pet_waste' OR s.base_price_cents IS NOT NULL)
     ORDER BY array_position(ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other'], s.service_line),
              lower(s.name),
              s.id;
END;
$$;

REVOKE ALL ON FUNCTION public.public_services(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_services(text) TO anon, authenticated, service_role;

-- ── 2. public_quote: a Coming soon service is quoted as an unknown one ────

CREATE OR REPLACE FUNCTION public.public_quote(
  _slug text,
  _postal_code text,
  _dog_count integer,
  _frequency text,
  -- The tier the customer picked for "when was your yard last cleaned?". Only
  -- an id: the price is the owner's, read here, never the caller's.
  _last_cleaned text DEFAULT NULL,
  -- The service being quoted (phase 5). NULL, or a pet-waste service, is the
  -- zone quote exactly as before this argument existed.
  _service_id uuid DEFAULT NULL
)
RETURNS TABLE(
  organization_id uuid,
  zone_id uuid,
  zone_name text,
  base_price_cents integer,
  per_dog_addl_cents integer,
  recurring_price_cents integer,
  initial_cleanup_cents integer,
  currency text,
  first_cleanup_mode text,
  first_cleanup_label text,
  first_cleanup_options jsonb
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
  _zone public.zones;
  _svc public.services;
  _mult numeric;
  _base_visit_cents integer;
  _recurring integer;
  _zip text := btrim(coalesce(_postal_code, ''));
  _cfg jsonb;
  _mode text;
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT z.* INTO _zone FROM public.zones z
    WHERE z.organization_id = _org.id
      AND (_zip = ANY(z.zip_codes)
           OR (z.postal_prefix IS NOT NULL AND _zip LIKE z.postal_prefix || '%'))
    ORDER BY (CASE WHEN _zip = ANY(z.zip_codes) THEN 0 ELSE 1 END),
             z.priority DESC,
             (CASE WHEN z.account_type = 'residential' THEN 0
                   WHEN z.account_type IS NULL THEN 1
                   ELSE 2 END),
             length(coalesce(z.postal_prefix,'')) DESC,
             z.id
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  -- The service, when one is named: this business's, or nothing. Another
  -- business's id is the same silence as a ZIP nobody serves. So is a
  -- service on a line that is still Coming soon (20261018150000).
  IF _service_id IS NOT NULL THEN
    SELECT s.* INTO _svc FROM public.services s
      WHERE s.id = _service_id AND s.organization_id = _org.id
        AND s.service_line = ANY (public.bookable_service_lines());
    IF NOT FOUND THEN RETURN; END IF;
  END IF;

  IF _svc.id IS NOT NULL AND _svc.service_line <> 'pet_waste' THEN
    -- A walk, a sit, a groom: the service's own price, through the one rule.
    -- Not for sale once deactivated. No frequency multiplier (1.0 for every
    -- line but pet waste), and no first cleanup: that is a yard's.
    IF NOT _svc.active THEN RETURN; END IF;
    _base_visit_cents := public.service_price_cents(
      _svc.price_unit, _svc.base_price_cents, _svc.extra_pet_cents,
      _svc.default_duration_min, _dog_count, NULL, 1, 1);

    organization_id := _org.id;
    zone_id := _zone.id;
    zone_name := _zone.name;
    base_price_cents := _base_visit_cents;
    -- Per dog PER VISIT, like the zone's per_dog_addl_cents: the extra-pet
    -- rate × the same units (the service's duration for an hourly service,
    -- one night for a nightly one), so a "+$X per dog" label is right.
    per_dog_addl_cents := public.service_price_cents(
      _svc.price_unit, _svc.extra_pet_cents, 0, _svc.default_duration_min, 1, NULL, 1, 1);
    recurring_price_cents := _base_visit_cents;
    initial_cleanup_cents := 0;
    currency := _org.currency;
    first_cleanup_mode := 'off';
    first_cleanup_label := NULL;
    first_cleanup_options := '[]'::jsonb;
    RETURN NEXT;
    RETURN;
  END IF;

  -- Pet waste, or no service named: the 20260929120000 body, verbatim.
  _mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);
  _base_visit_cents := _zone.base_price_cents + GREATEST(_dog_count - 1, 0) * _zone.per_dog_addl_cents;
  _recurring := round(_base_visit_cents * _mult)::integer;

  _cfg := COALESCE(_org.first_cleanup_pricing, '{"mode":"off"}'::jsonb);
  _mode := COALESCE(_cfg ->> 'mode', 'off');

  organization_id := _org.id;
  zone_id := _zone.id;
  zone_name := _zone.name;
  base_price_cents := _base_visit_cents;
  per_dog_addl_cents := _zone.per_dog_addl_cents;
  recurring_price_cents := _recurring;
  initial_cleanup_cents := public.first_cleanup_price_cents(
    _cfg, _zone.initial_cleanup_cents, _dog_count, _last_cleaned);
  currency := _org.currency;
  first_cleanup_mode := _mode;
  first_cleanup_label := CASE WHEN _mode = 'by_last_cleaned' THEN (
      SELECT t ->> 'label' FROM jsonb_array_elements(COALESCE(_cfg -> 'tiers', '[]'::jsonb)) AS e(t)
       WHERE t ->> 'id' = _last_cleaned LIMIT 1) END;
  first_cleanup_options := CASE WHEN _mode = 'by_last_cleaned' THEN COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'id', t ->> 'id',
               'label', t ->> 'label',
               'price_cents', public.first_cleanup_price_cents(
                  _cfg, _zone.initial_cleanup_cents, _dog_count, t ->> 'id')
             ) ORDER BY ord)
        FROM jsonb_array_elements(_cfg -> 'tiers') WITH ORDINALITY AS e(t, ord)), '[]'::jsonb)
    ELSE '[]'::jsonb END;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.public_quote(text, text, integer, text, text, uuid) IS
  'The public price for a visitor: the zone''s rate card for pet waste (or when no service is named), the service''s own price (service_price_cents) for any other service. Anon-callable; takes no price. Migration 20261011100000 added _service_id.';

REVOKE ALL ON FUNCTION public.public_quote(text, text, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_quote(text, text, integer, text, text, uuid)
  TO anon, authenticated, service_role;

-- ── 3. portal_request_one_off: refused like a deactivated service ────────

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
  -- business's id, a deactivated one and one on a line that is still Coming
  -- soon (20261018150000) are the same refusal.
  IF _service_id IS NOT NULL THEN
    PERFORM 1 FROM public.services s
      WHERE s.id = _service_id AND s.organization_id = _org_id AND s.active
        AND s.service_line = ANY (public.bookable_service_lines());
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
  -- Each of the three asks about the line. Named functions only, read
  -- through prosrc, which cannot raise for any kind of routine.
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

  -- The grants are what they were.
  IF NOT has_function_privilege('anon', 'public.public_services(text)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_services or public_quote';
  END IF;
  IF has_function_privilege('anon', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_request_one_off is reachable by an API role; it is the server''s to call';
  END IF;
  IF has_function_privilege('anon', 'public.bookable_service_lines()', 'EXECUTE') THEN
    RAISE EXCEPTION 'bookable_service_lines is callable by anon';
  END IF;

  -- An owner can still set up a walk: nothing here may gate services rows.
  IF EXISTS (
    SELECT 1 FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'public.services'::regclass
       AND NOT t.tgisinternal
       AND p.prosrc LIKE '%bookable_service_lines%'
  ) THEN
    RAISE EXCEPTION 'a trigger on public.services refuses a Coming soon line; owners set those up before launch';
  END IF;
END
$post$;
