-- The schedule lived only in the app.
--
-- Jobber syncs a technician's work to Google, Apple and Outlook calendars.
-- Here the only place a tech could see Thursday was inside HoundStack, and the
-- only place an owner could see the whole week was the dispatch board. A phone
-- already has a calendar the person looks at forty times a day; this puts the
-- visits in it.
--
-- And the customer's half of the same schedule could only be changed by
-- phoning: nobody could ask for an extra cleanup before a party from the
-- portal. PART 2, at the end of this file, adds that request.
--
-- ══ PART 1: CALENDAR FEEDS ═══════════════════════════════════════════════════
--
-- A feed is an iCalendar URL a calendar app polls. It carries no session, so
-- the URL IS the credential: whoever has it can read the feed. That decides
-- most of the shape below.
--
-- 1. public.calendar_feeds: one row per person per scope.
--      scope 'mine' - the visits assigned to that person's staff record.
--      scope 'org'  - every visit in the organization, for whoever holds
--                     view_client_directory (owner, office manager,
--                     dispatcher: the roles that already see every client's
--                     name and address on the board).
--    The token is 32 random bytes made by the server. Only its SHA-256 is
--    stored, so a read of this table (a backup, a support query, a leaked
--    service key) yields nothing that opens a feed. Lookup is by that hash
--    through a unique index: the comparison happens on a digest the caller
--    cannot steer, so there is no byte-by-byte timing to measure.
--    UNIQUE (user_id, scope): regenerating REPLACES the hash, which is what
--    revokes the old URL. There is no list of old tokens to forget to clear.
--
-- 2. organizations.calendar_feed_access_codes, default false. Gate codes,
--    lock-box codes and key locations are left out of every feed unless the
--    owner turns this on, and even then only the 'mine' feed carries them,
--    never the org-wide one. A subscribed calendar is copied into Google's,
--    Apple's or Microsoft's servers, shared with a spouse's account, shown on
--    a lock screen and a watch face. A client's gate code in that copy is out
--    of this product's reach for good: rotating the feed does not un-sync
--    what a calendar already stored. The field app shows the code at the gate,
--    which is where it is needed.
--
-- 3. Functions. The table itself is closed to every client role; these are
--    the only ways in.
--      calendar_feed_rotate(scope, hash)  authenticated: mint or replace the
--                                         caller's own link. Refuses a scope
--                                         the caller is not entitled to.
--      calendar_feed_revoke(scope)        authenticated: turn a link off.
--      calendar_feed_status()             authenticated: the caller's own
--                                         links, without their hashes.
--      calendar_feed_events(hash)         service_role only: what the public
--                                         route serves. NULL for a hash that
--                                         matches nothing, AND for one whose
--                                         owner has since lost the right to
--                                         it (removed from the org, staff
--                                         record deactivated, role lowered),
--                                         because a link minted last month
--                                         must not outlive the reason it was
--                                         allowed.
--
-- Replays into an empty database: one column, one table, four functions,
-- grants. The DO block at the end asserts only what this file creates.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS calendar_feed_access_codes boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.calendar_feed_access_codes IS
  'Whether a technician''s own calendar feed carries gate codes, lock-box codes and key locations. Off by default; the org-wide feed never carries them.';

CREATE TABLE IF NOT EXISTS public.calendar_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz,
  CONSTRAINT calendar_feeds_scope_check CHECK (scope IN ('mine', 'org')),
  -- A hex SHA-256 and nothing else, so a raw token can never be stored here
  -- by mistake: it would be 43 base64url characters and fail this.
  CONSTRAINT calendar_feeds_token_hash_check CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT calendar_feeds_one_per_scope UNIQUE (user_id, scope)
);

CREATE UNIQUE INDEX IF NOT EXISTS calendar_feeds_token_hash_key
  ON public.calendar_feeds (token_hash);
CREATE INDEX IF NOT EXISTS calendar_feeds_org_idx
  ON public.calendar_feeds (organization_id);

COMMENT ON TABLE public.calendar_feeds IS
  'Subscribable iCalendar links. Only the SHA-256 of each token is stored; regenerating replaces it, which revokes the old URL.';

ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;
-- The default privileges on public hand every new table to anon and
-- authenticated with ALL. Nobody but the service role reads this table
-- directly; the functions below are the whole interface.
REVOKE ALL ON public.calendar_feeds FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.calendar_feeds TO service_role;

-- ── mint / replace ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.calendar_feed_rotate(_scope text, _token_hash text)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _at timestamptz := now();
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  IF _scope IS NULL OR _scope NOT IN ('mine', 'org') THEN RAISE EXCEPTION 'invalid_scope'; END IF;
  IF _token_hash IS NULL OR _token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid_token_hash'; END IF;

  SELECT organization_id INTO _org FROM public.user_roles WHERE user_id = _uid LIMIT 1;
  IF _org IS NULL THEN RAISE EXCEPTION 'no_organization'; END IF;

  IF _scope = 'mine' AND NOT EXISTS (
    SELECT 1 FROM public.staff
     WHERE user_id = _uid AND organization_id = _org AND active = true
  ) THEN
    RAISE EXCEPTION 'no_staff_record';
  END IF;
  IF _scope = 'org' AND NOT public.has_permission(_uid, _org, 'view_client_directory') THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;

  INSERT INTO public.calendar_feeds (organization_id, user_id, scope, token_hash, created_at, last_fetched_at)
  VALUES (_org, _uid, _scope, _token_hash, _at, NULL)
  ON CONFLICT (user_id, scope) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        token_hash = EXCLUDED.token_hash,
        created_at = EXCLUDED.created_at,
        last_fetched_at = NULL;
  RETURN _at;
END $function$;

-- ── turn off ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.calendar_feed_revoke(_scope text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _n integer;
BEGIN
  IF _uid IS NULL THEN RAISE EXCEPTION 'not_signed_in'; END IF;
  DELETE FROM public.calendar_feeds WHERE user_id = _uid AND scope = _scope;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n > 0;
END $function$;

-- ── the caller's own links, never their hashes ──────────────────────────────
CREATE OR REPLACE FUNCTION public.calendar_feed_status()
RETURNS TABLE (scope text, created_at timestamptz, last_fetched_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT f.scope, f.created_at, f.last_fetched_at
    FROM public.calendar_feeds f
   WHERE f.user_id = auth.uid()
     AND f.organization_id = (SELECT organization_id FROM public.user_roles WHERE user_id = auth.uid() LIMIT 1)
   ORDER BY f.scope
$function$;

-- ── what the public route serves ────────────────────────────────────────────
--
-- Today minus 7 through today plus 60, on the ORGANIZATION's calendar: a feed
-- polled from a server in another zone must not shift the window by a day.
-- Every join is pinned to the feed's organization as well as to the visit, so
-- a visit row that somehow pointed across tenants still cannot bring the other
-- tenant's client or address into the result.
CREATE OR REPLACE FUNCTION public.calendar_feed_events(_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _feed public.calendar_feeds%ROWTYPE;
  _org public.organizations%ROWTYPE;
  _tz text;
  _today date;
  _codes boolean;
  _events jsonb;
  _holder text;
BEGIN
  IF _token_hash IS NULL OR _token_hash !~ '^[0-9a-f]{64}$' THEN RETURN NULL; END IF;

  SELECT * INTO _feed FROM public.calendar_feeds WHERE token_hash = _token_hash;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- Still a member of the organization the link was minted in.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = _feed.user_id AND organization_id = _feed.organization_id
  ) THEN
    RETURN NULL;
  END IF;
  -- Still entitled to this scope. has_permission answers for the named user
  -- when no one is signed in, which is the service role calling here.
  IF _feed.scope = 'org'
     AND NOT public.has_permission(_feed.user_id, _feed.organization_id, 'view_client_directory') THEN
    RETURN NULL;
  END IF;
  IF _feed.scope = 'mine' AND NOT EXISTS (
    SELECT 1 FROM public.staff
     WHERE user_id = _feed.user_id AND organization_id = _feed.organization_id AND active = true
  ) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO _org FROM public.organizations WHERE id = _feed.organization_id;
  _tz := COALESCE(NULLIF(_org.timezone, ''), 'America/Chicago');
  _today := (now() AT TIME ZONE _tz)::date;
  -- Access codes: the owner's switch, and never on the org-wide feed.
  _codes := _feed.scope = 'mine' AND COALESCE(_org.calendar_feed_access_codes, false);

  SELECT s.display_name INTO _holder FROM public.staff s
   WHERE s.user_id = _feed.user_id AND s.organization_id = _feed.organization_id
   ORDER BY s.active DESC, s.created_at LIMIT 1;

  SELECT COALESCE(jsonb_agg(e ORDER BY e->>'scheduled_on', e->>'eta_start', e->>'id'), '[]'::jsonb)
    INTO _events
    FROM (
      SELECT jsonb_build_object(
               'id', v.id,
               'scheduled_on', v.scheduled_on,
               'status', v.status,
               'eta_start', v.eta_start,
               'eta_end', v.eta_end,
               'updated_at', v.updated_at,
               'client_name', c.display_name,
               'street', p.street,
               'city', p.city,
               'region', p.region,
               'postal_code', p.postal_code,
               'tech_name', st.display_name,
               'gate_code', CASE WHEN _codes THEN p.gate_code END,
               'lock_box_code', CASE WHEN _codes THEN p.lock_box_code END,
               'key_location', CASE WHEN _codes THEN p.key_location END
             ) AS e
        FROM public.visits v
        JOIN public.clients c
          ON c.id = v.client_id AND c.organization_id = _feed.organization_id
        JOIN public.properties p
          ON p.id = v.property_id AND p.organization_id = _feed.organization_id
        LEFT JOIN public.staff st
          ON st.id = v.assigned_staff_id AND st.organization_id = _feed.organization_id
       WHERE v.organization_id = _feed.organization_id
         AND v.scheduled_on BETWEEN _today - 7 AND _today + 60
         AND (
           _feed.scope = 'org'
           OR v.assigned_staff_id IN (
             SELECT id FROM public.staff
              WHERE user_id = _feed.user_id AND organization_id = _feed.organization_id
           )
         )
       LIMIT 5000
    ) q;

  -- A calendar app polls every few minutes to every few hours. Recording
  -- each poll would be a write per poll per subscriber; recording it at most
  -- every quarter hour still answers "is my calendar actually reading this".
  UPDATE public.calendar_feeds SET last_fetched_at = now()
   WHERE id = _feed.id
     AND (last_fetched_at IS NULL OR last_fetched_at < now() - interval '15 minutes');

  RETURN jsonb_build_object(
    'scope', _feed.scope,
    'org_name', _org.name,
    'timezone', _tz,
    'holder_name', _holder,
    'from', _today - 7,
    'through', _today + 60,
    'events', _events
  );
END $function$;

-- The three a signed-in person calls on their own behalf: authenticated and
-- service_role. The feed itself: service_role only, because the public route
-- reaches it with the service key after hashing the token, and nothing else
-- should be able to ask it anything.
REVOKE ALL ON FUNCTION public.calendar_feed_rotate(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_feed_revoke(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_feed_status() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.calendar_feed_events(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calendar_feed_rotate(text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calendar_feed_revoke(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calendar_feed_status() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.calendar_feed_events(text) TO service_role;

-- What part 1 establishes.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'calendar_feed_access_codes' AND is_nullable = 'NO'
       AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'organizations.calendar_feed_access_codes is missing, nullable, or not off by default';
  END IF;

  IF to_regclass('public.calendar_feeds') IS NULL THEN
    RAISE EXCEPTION 'public.calendar_feeds was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.calendar_feeds'::regclass) THEN
    RAISE EXCEPTION 'calendar_feeds does not have row level security enabled';
  END IF;
  IF has_table_privilege('anon', 'public.calendar_feeds', 'SELECT')
     OR has_table_privilege('authenticated', 'public.calendar_feeds', 'SELECT')
     OR has_table_privilege('authenticated', 'public.calendar_feeds', 'INSERT')
     OR has_table_privilege('authenticated', 'public.calendar_feeds', 'UPDATE') THEN
    RAISE EXCEPTION 'calendar_feeds is readable or writable by a client role';
  END IF;
  IF NOT (SELECT indisunique FROM pg_index
            WHERE indexrelid = 'public.calendar_feeds_token_hash_key'::regclass) THEN
    RAISE EXCEPTION 'calendar_feeds.token_hash is not uniquely indexed';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.calendar_feeds'::regclass
         AND conname = 'calendar_feeds_token_hash_check')) !~ '64' THEN
    RAISE EXCEPTION 'calendar_feeds.token_hash is not constrained to a SHA-256 hex digest';
  END IF;

  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.calendar_feed_events(text)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'calendar_feed_events is not SECURITY DEFINER';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.calendar_feed_events(text)'::regprocedure)
       !~ 'calendar_feed_access_codes' THEN
    RAISE EXCEPTION 'calendar_feed_events does not read the owner''s access-code switch';
  END IF;
  IF has_function_privilege('anon', 'public.calendar_feed_events(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.calendar_feed_events(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'calendar_feed_events is callable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.calendar_feed_events(text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute calendar_feed_events';
  END IF;
  IF has_function_privilege('anon', 'public.calendar_feed_rotate(text, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calendar_feed_revoke(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.calendar_feed_status()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a calendar feed function is callable by anon';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.calendar_feed_rotate(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot mint its own calendar link';
  END IF;
END
$check$;


-- ══ PART 2: A CUSTOMER CAN ASK FOR AN EXTRA CLEANUP ══════════════════════════
--
-- Jobber has online booking; the review listed "customer self-booking of
-- one-off dates" as missing. Here a customer wanting a cleanup before a party
-- had to phone. Now they REQUEST one from the portal: a working day from the
-- org's tomorrow through 30 days out, at one of their properties, with an
-- optional note. It is a request the office approves, not a visit, unless the
-- owner switched auto-accept on.
--
-- It rides the plumbing the re-clean request (20260928110000) already built,
-- because it is the same kind of thing: a customer asking the office for a
-- visit. qc_tickets is the inbox the office already works (/concerns), and
-- the portal's "Your requests" list already reads it with its status.
--
-- 1. organizations.portal_auto_accept_bookings (default false) and
--    organizations.one_off_price_cents (NULL = the office prices each one).
--    Auto-accept needs a price: with none set, a request waits for the office
--    whatever the switch says, because booking a visit means setting a price.
--
-- 2. qc_tickets accepts category 'one_off_request' and carries
--      requested_on     the day the customer asked for,
--      property_id      where,
--      booked_visit_id  the visit once booked (by the office through
--                       createOneOffVisit, or by auto-accept through the same
--                       code), so the portal can say "Booked for Tue, Oct 6".
--    One open request per property per day, held by a partial unique index.
--
-- 3. portal_request_one_off(_token, _property_id, _on, _message), modelled on
--    portal_request_reclean and granted exactly as it is: service_role only,
--    the portal reaching it through a server function after the session
--    check. Refuses a property that is not this client's, a day before the
--    org's tomorrow, a day more than 30 out, a day that is not one of the
--    org's work_days, a blackout day, and a day the property already has a
--    visit. Idempotent: the same property and day again returns the first
--    request (created = false), whether it is still open or already booked,
--    so a double tap -- or a second device -- makes one request and at most
--    one visit.
--
-- 4. portal_list_my_requests gains requested_on and booked_on. Its return
--    type changes, so it is dropped and recreated, and re-granted exactly as
--    it was (service_role only).
--
-- Replays into an empty database: columns, constraints, indexes, two
-- functions, grants. The DO block asserts only what this part creates.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS portal_auto_accept_bookings boolean NOT NULL DEFAULT false;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS one_off_price_cents integer;
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_one_off_price_cents_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_one_off_price_cents_check
  CHECK (one_off_price_cents IS NULL OR one_off_price_cents BETWEEN 0 AND 1000000);

COMMENT ON COLUMN public.organizations.portal_auto_accept_bookings IS
  'Whether an extra cleanup requested from the customer portal is booked straight away (at one_off_price_cents) instead of waiting for the office. Off by default; needs a price to take effect.';
COMMENT ON COLUMN public.organizations.one_off_price_cents IS
  'The price of a one-off visit a customer requests from the portal. NULL: the office sets it when booking each one.';

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_category_check;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_category_check
  CHECK (category IN ('missed_spot','gate_left_open','damage','wrong_yard','other','reclean_request','one_off_request'));

ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS requested_on date;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS property_id uuid;
ALTER TABLE public.qc_tickets ADD COLUMN IF NOT EXISTS booked_visit_id uuid;

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_property_id_fkey;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_property_id_fkey
  FOREIGN KEY (property_id) REFERENCES public.properties(id) ON DELETE SET NULL;
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_booked_visit_id_fkey;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_booked_visit_id_fkey
  FOREIGN KEY (booked_visit_id) REFERENCES public.visits(id) ON DELETE SET NULL;
-- A request for an extra visit without a day is not a request anyone can act on.
ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_one_off_has_a_day;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_one_off_has_a_day
  CHECK (category <> 'one_off_request' OR requested_on IS NOT NULL);

CREATE INDEX IF NOT EXISTS qc_tickets_booked_visit_idx ON public.qc_tickets (booked_visit_id);
CREATE INDEX IF NOT EXISTS qc_tickets_property_idx ON public.qc_tickets (property_id);
CREATE UNIQUE INDEX IF NOT EXISTS qc_tickets_one_open_one_off_per_property_day
  ON public.qc_tickets (property_id, requested_on)
  WHERE category = 'one_off_request' AND status <> 'resolved';

COMMENT ON COLUMN public.qc_tickets.requested_on IS
  'For a one_off_request: the day the customer asked for.';
COMMENT ON COLUMN public.qc_tickets.booked_visit_id IS
  'For a one_off_request: the visit booked for it, by the office or by auto-accept.';

CREATE OR REPLACE FUNCTION public.portal_request_one_off(
  _token uuid, _property_id uuid, _on date, _message text
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

  INSERT INTO public.qc_tickets (organization_id, client_id, property_id, category, requested_on, message)
  VALUES (_org_id, _client_id, _property_id, 'one_off_request', _on,
          left(NULLIF(btrim(COALESCE(_message, '')), ''), 1000))
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
REVOKE ALL ON FUNCTION public.portal_request_one_off(uuid, uuid, date, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_request_one_off(uuid, uuid, date, text) TO service_role;

-- The portal's "Your requests", now with the day asked for and the day booked.
DROP FUNCTION IF EXISTS public.portal_list_my_requests(uuid);
CREATE FUNCTION public.portal_list_my_requests(_token uuid)
RETURNS TABLE (
  ticket_id uuid, visit_id uuid, visit_date date, category text, message text,
  status text, resolution_note text, resolved_at timestamptz, created_at timestamptz,
  requested_on date, booked_on date
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT t.id, t.visit_id, v.scheduled_on, t.category, t.message,
         t.status, t.resolution_note, t.resolved_at, t.created_at,
         t.requested_on, b.scheduled_on
    FROM public.clients c
    JOIN public.qc_tickets t ON t.client_id = c.id AND t.organization_id = c.organization_id
    LEFT JOIN public.visits v ON v.id = t.visit_id
    LEFT JOIN public.visits b ON b.id = t.booked_visit_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY t.created_at DESC
   LIMIT 40
$function$;
REVOKE ALL ON FUNCTION public.portal_list_my_requests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_my_requests(uuid) TO service_role;

-- What part 2 establishes.
DO $check$
DECLARE _def text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'portal_auto_accept_bookings' AND is_nullable = 'NO'
       AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'organizations.portal_auto_accept_bookings is missing, nullable, or not off by default';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'one_off_price_cents' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'organizations.one_off_price_cents is missing or not nullable';
  END IF;

  _def := pg_get_constraintdef((SELECT oid FROM pg_constraint
            WHERE conrelid = 'public.qc_tickets'::regclass AND conname = 'qc_tickets_category_check'));
  IF _def !~ 'one_off_request' THEN
    RAISE EXCEPTION 'qc_tickets does not accept one_off_request';
  END IF;
  IF _def !~ 'missed_spot.*gate_left_open.*damage.*wrong_yard.*other.*reclean_request' THEN
    RAISE EXCEPTION 'qc_tickets_category_check dropped an existing category';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.qc_tickets'::regclass
                    AND conname = 'qc_tickets_booked_visit_id_fkey'
                    AND confrelid = 'public.visits'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'qc_tickets.booked_visit_id does not reference visits ON DELETE SET NULL';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.qc_tickets'::regclass
                    AND conname = 'qc_tickets_property_id_fkey'
                    AND confrelid = 'public.properties'::regclass AND confdeltype = 'n') THEN
    RAISE EXCEPTION 'qc_tickets.property_id does not reference properties ON DELETE SET NULL';
  END IF;
  IF NOT (SELECT indisunique FROM pg_index
            WHERE indexrelid = 'public.qc_tickets_one_open_one_off_per_property_day'::regclass) THEN
    RAISE EXCEPTION 'one open one-off request per property per day is not enforced';
  END IF;

  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.portal_request_one_off(uuid, uuid, date, text)'::regprocedure) IS NOT TRUE THEN
    RAISE EXCEPTION 'portal_request_one_off is not SECURITY DEFINER';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.portal_request_one_off(uuid, uuid, date, text)'::regprocedure)
       !~ 'work_days' THEN
    RAISE EXCEPTION 'portal_request_one_off does not read the organization''s working days';
  END IF;
  IF has_function_privilege('anon', 'public.portal_request_one_off(uuid, uuid, date, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_one_off(uuid, uuid, date, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_request_one_off is callable by a client role; the portal reaches it only through service_role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_request_one_off(uuid, uuid, date, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute portal_request_one_off';
  END IF;

  IF has_function_privilege('anon', 'public.portal_list_my_requests(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_list_my_requests(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_list_my_requests came back callable by a client role';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_list_my_requests(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute portal_list_my_requests';
  END IF;
END
$check$;
