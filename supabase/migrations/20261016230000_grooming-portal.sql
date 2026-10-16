-- Mobile grooming in the customer portal (#412, part B). Follows
-- 20261016220000.
--
-- 1. A groom request is a qc_tickets row with category 'groom_request', in
--    the inbox the office already works (/concerns), so the client never
--    books a visit themselves. It carries the pet (dog_id), the pet's
--    address (property_id), the groom service (service_id), the add-ons
--    (groom_addons, [{addon_service_id, quantity}]), the day (requested_on),
--    the preferred window (requested_time to requested_time_end, both NULL
--    for any time) and the price and length the client was shown
--    (quoted_cents, quoted_minutes). The quote is groomQuote's, worked out by
--    the portal server with the office's rules; the office re-quotes when it
--    books, so a stale quote never reaches an invoice.
--    One open request per pet per day, held by a partial unique index.
--
--    requested_time is also added by the training portal migration
--    (20261016210000, PR #476) with the same type, so either order applies.
--    For the same reason the category list below keeps
--    'training_lesson_request': whichever of the two files runs second
--    rebuilds the constraint, and it must not drop the other's category.
--
-- 2. portal_request_groom, granted like portal_request_one_off: service_role
--    only, reached through a server function after the portal session check.
--    It refuses a business that does not run mobile grooming, a pet that is
--    not this client's, a service that is not an active groom service of
--    this business, an add-on that is not a groom add-on of this business, a
--    day that is not tomorrow through 90 days out, a non-working or blacked
--    out day, a window that ends before it starts, and a client with ten
--    groom requests already open. A second tap for the same pet and day hands
--    back the first request.
--
-- 3. A portal vaccine upload can be rejected with a reason: rejected_at,
--    rejected_by and rejection_reason on pet_vaccinations. A rejected record
--    is neither verified nor current; vaccineStatus skips it. Only a portal
--    upload can be rejected, a record cannot be both verified and rejected,
--    and a rejection always has a reason. pet_vaccinations_review_stamp takes
--    the reviewer from the session, as pet_vaccinations_before_write does for
--    the verifier. A partial index serves the office's pending queue.
--
-- Replays into an empty database: columns, constraints, two indexes on
-- qc_tickets, one on pet_vaccinations, a trigger and a function. The check
-- block asserts only what this file creates.

-- ── 1. Groom requests in the office inbox ────────────────────────────────

ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS requested_time time;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS requested_time_end time;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS dog_id uuid;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS groom_addons jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS quoted_cents integer;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS quoted_minutes integer;

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_dog_id_fkey;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_dog_id_fkey
  FOREIGN KEY (dog_id) REFERENCES public.dogs(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS qc_tickets_dog_idx ON public.qc_tickets (dog_id)
  WHERE dog_id IS NOT NULL;

COMMENT ON COLUMN public.qc_tickets.requested_time IS
  'The start time the client asked for (a training lesson), or the start of the window they prefer (a groom request).';
COMMENT ON COLUMN public.qc_tickets.requested_time_end IS
  'For a groom_request: the end of the window the client prefers. NULL with requested_time NULL is any time.';
COMMENT ON COLUMN public.qc_tickets.dog_id IS
  'For a groom_request: the pet to be groomed.';
COMMENT ON COLUMN public.qc_tickets.groom_addons IS
  'For a groom_request: [{addon_service_id, quantity}], the add-ons the client picked.';
COMMENT ON COLUMN public.qc_tickets.quoted_cents IS
  'For a groom_request: the price the portal showed, from groomQuote. The office re-quotes when it books.';
COMMENT ON COLUMN public.qc_tickets.quoted_minutes IS
  'For a groom_request: the appointment length the portal showed, setup and cleanup included.';

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_category_check;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_category_check
  CHECK (category IN ('missed_spot','gate_left_open','damage','wrong_yard','other',
    'reclean_request','one_off_request','training_lesson_request','groom_request'));

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_groom_request_shape;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_groom_request_shape
  CHECK (category <> 'groom_request' OR (
    requested_on IS NOT NULL AND service_id IS NOT NULL
    AND (requested_time IS NULL) = (requested_time_end IS NULL)
    AND (requested_time IS NULL OR requested_time < requested_time_end)
    AND (quoted_cents IS NULL OR quoted_cents >= 0)
    AND (quoted_minutes IS NULL OR quoted_minutes BETWEEN 1 AND 720)
  ));
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_groom_addons_is_a_list;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_groom_addons_is_a_list
  CHECK (jsonb_typeof(groom_addons) = 'array' AND jsonb_array_length(groom_addons) <= 20);

CREATE UNIQUE INDEX IF NOT EXISTS qc_tickets_one_open_groom_request_per_pet_day
  ON public.qc_tickets (dog_id, requested_on)
  WHERE category = 'groom_request' AND status <> 'resolved';

DROP FUNCTION IF EXISTS public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer);

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

-- ── 3. Rejecting a portal vaccine upload ─────────────────────────────────

ALTER TABLE public.pet_vaccinations ADD COLUMN IF NOT EXISTS rejected_at timestamptz;
ALTER TABLE public.pet_vaccinations ADD COLUMN IF NOT EXISTS rejected_by uuid;
ALTER TABLE public.pet_vaccinations ADD COLUMN IF NOT EXISTS rejection_reason text;

ALTER TABLE public.pet_vaccinations DROP CONSTRAINT IF EXISTS pet_vaccinations_rejected_by_fkey;
ALTER TABLE public.pet_vaccinations ADD CONSTRAINT pet_vaccinations_rejected_by_fkey
  FOREIGN KEY (rejected_by) REFERENCES auth.users(id) ON DELETE SET NULL;
ALTER TABLE public.pet_vaccinations DROP CONSTRAINT IF EXISTS pet_vaccinations_review_shape;
ALTER TABLE public.pet_vaccinations ADD CONSTRAINT pet_vaccinations_review_shape
  CHECK (
    (rejected_at IS NULL OR (verified_at IS NULL AND source = 'portal'))
    AND (rejected_at IS NULL) = (rejection_reason IS NULL)
    AND (rejection_reason IS NULL OR char_length(btrim(rejection_reason)) BETWEEN 1 AND 500)
  );

COMMENT ON COLUMN public.pet_vaccinations.rejected_at IS
  'When the office rejected this portal upload. A rejected record is not verified and does not count as current.';
COMMENT ON COLUMN public.pet_vaccinations.rejection_reason IS
  'What the office told the client when it rejected the upload. The portal shows it.';

CREATE INDEX IF NOT EXISTS pet_vaccinations_pending_review_idx
  ON public.pet_vaccinations (organization_id, created_at)
  WHERE source = 'portal' AND verified_at IS NULL AND rejected_at IS NULL;

CREATE OR REPLACE FUNCTION public.pet_vaccinations_review_stamp()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.rejected_at IS NULL THEN
    NEW.rejected_by := NULL;
  ELSIF auth.uid() IS NOT NULL AND (TG_OP = 'INSERT'
    OR NEW.rejected_at IS DISTINCT FROM OLD.rejected_at
    OR NEW.rejected_by IS DISTINCT FROM OLD.rejected_by) THEN
    -- A signed-in caller rejects as themselves, never as someone else.
    NEW.rejected_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pet_vaccinations_review_stamp() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS pet_vaccinations_review_stamp ON public.pet_vaccinations;
CREATE TRIGGER pet_vaccinations_review_stamp BEFORE INSERT OR UPDATE ON public.pet_vaccinations
  FOR EACH ROW EXECUTE FUNCTION public.pet_vaccinations_review_stamp();

-- ── What this file establishes, checked from any starting state ──────────

DO $check$
DECLARE _def text; _fn text; _col text;
BEGIN
  FOREACH _col IN ARRAY ARRAY['requested_time', 'requested_time_end', 'dog_id', 'groom_addons',
    'quoted_cents', 'quoted_minutes'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'qc_tickets' AND column_name = _col) THEN
      RAISE EXCEPTION 'qc_tickets.% is missing', _col;
    END IF;
  END LOOP;

  _def := pg_get_constraintdef((SELECT oid FROM pg_constraint
            WHERE conrelid = 'public.qc_tickets'::regclass AND conname = 'qc_tickets_category_check'));
  IF _def !~ 'groom_request' THEN
    RAISE EXCEPTION 'qc_tickets does not accept groom_request';
  END IF;
  IF _def !~ 'missed_spot.*gate_left_open.*damage.*wrong_yard.*other.*reclean_request.*one_off_request.*training_lesson_request' THEN
    RAISE EXCEPTION 'qc_tickets_category_check dropped an existing category';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.qc_tickets'::regclass
       AND conname = 'qc_tickets_groom_request_shape')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.qc_tickets'::regclass
       AND conname = 'qc_tickets_groom_addons_is_a_list') THEN
    RAISE EXCEPTION 'The groom request constraints are missing.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_index i
       WHERE i.indexrelid = to_regclass('public.qc_tickets_one_open_groom_request_per_pet_day')
         AND i.indisunique AND i.indisvalid) THEN
    RAISE EXCEPTION 'The one-open-groom-request-per-pet-day index is missing, not unique, or invalid.';
  END IF;

  _fn := 'public.portal_request_groom(uuid, uuid, uuid, jsonb, date, time, time, text, integer, integer)';
  IF to_regprocedure(_fn) IS NULL THEN
    RAISE EXCEPTION '% was not created', _fn;
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE')
     OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is callable with a client key; the portal reaches it as service_role.', _fn;
  END IF;
  IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '% is not callable by the portal server.', _fn;
  END IF;

  FOREACH _col IN ARRAY ARRAY['rejected_at', 'rejected_by', 'rejection_reason'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
         AND table_name = 'pet_vaccinations' AND column_name = _col) THEN
      RAISE EXCEPTION 'pet_vaccinations.% is missing', _col;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.pet_vaccinations'::regclass
       AND conname = 'pet_vaccinations_review_shape') THEN
    RAISE EXCEPTION 'pet_vaccinations_review_shape is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
       AND indexname = 'pet_vaccinations_pending_review_idx') THEN
    RAISE EXCEPTION 'pet_vaccinations_pending_review_idx is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.pet_vaccinations'::regclass
       AND tgname = 'pet_vaccinations_review_stamp' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'pet_vaccinations_review_stamp trigger is missing';
  END IF;
  IF has_function_privilege('anon', 'public.pet_vaccinations_review_stamp()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.pet_vaccinations_review_stamp()', 'EXECUTE') THEN
    RAISE EXCEPTION 'pet_vaccinations_review_stamp is callable with a client key';
  END IF;
END
$check$;
