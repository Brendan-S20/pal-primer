-- Nobody could see the truck coming.
--
-- "On my way" tells a customer the tech has left. It cannot tell them where
-- the tech is, which is the thing a pet-waste customer actually needs: when to
-- put the dogs in. Uber and DoorDash taught everyone to expect a live map, and
-- Jobber's GPS is for the office only. This adds one, for the customer, with
-- the privacy rules written into the database rather than left to the app.
--
-- 1. organizations.live_tracking_enabled: OFF for every organization, the ones
--    that exist now AND the ones created later. Sharing a person's location
--    is a choice the business makes for its techs; nobody gets it by default.
--
-- 2. visits.tracking_token: the capability in the customer's link
--    (/track/<token>), minted when "on my way" is sent with tracking on, and
--    unguessable (gen_random_uuid-grade, like quotes.public_token).
--    visits.live_tracking_stopped_at: the tech pressed Stop.
--
-- 3. visit_live_locations: the tech's LATEST position for a visit, one row per
--    visit, upserted. Never a trail. A tech writes only for a visit assigned
--    to them, in their org, while the window is open; the office reads its
--    own org; the tech reads their own rows (an upsert has to); anon holds no
--    privilege on it at all.
--
-- THE WINDOW, which is the whole privacy rule, in one function
-- (live_tracking_window_open) used by the write check, the public page and
-- the prune, and mirrored in src/lib/live-tracking.ts (sharingWindow):
--
--   open   when the org has tracking on, the visit is still 'scheduled', an
--          "on my way" has been sent, it was sent less than 2 hours ago, and
--          the tech has not pressed Stop since it was sent.
--   closed the moment the visit starts, completes, is skipped or cancelled,
--          2 hours after the message, when the tech presses Stop, or when the
--          owner turns tracking off.
--
-- And a closed window leaves nothing behind: starting a visit or pressing Stop
-- deletes its row (trigger), turning tracking off deletes the org's rows
-- (trigger), and the nightly job deletes anything whose window has closed
-- (prune_visit_live_locations).
--
-- 4. public_visit_tracking(_token): what the customer's page shows. SECURITY
--    DEFINER, granted to service_role only, called from a server function
--    holding the service-role client, exactly as public_quote_document is.
--    The tech's position is rounded to 3 decimal places (about 110 m north to
--    south, less east to west) INSIDE the database, so the exact fix never
--    leaves it, and it is shown only while the window is open and the fix is
--    under 10 minutes old. Once the visit starts the page says the tech has
--    arrived and shows no location of anyone; once it is done or 2 hours
--    have passed, nothing locational at all. NULL for an unknown token and
--    for a token whose message never went, so the two cannot be told apart.
--
-- Replays into an empty database: columns, a table, its policies, functions
-- and triggers. Every assertion in the DO block is about what this file
-- establishes; none needs a tenant or a row.

-- ── 1. The switch ───────────────────────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS live_tracking_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.organizations.live_tracking_enabled IS
  'Share the assigned tech''s approximate location with the customer between the "on my way" message and the start of the visit (at most 2 hours), while the tech''s app is open. Off by default for every organization.';

-- ── 2. The link, and the Stop button ────────────────────────────────────────

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS tracking_token uuid,
  ADD COLUMN IF NOT EXISTS live_tracking_stopped_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS visits_tracking_token_key
  ON public.visits (tracking_token) WHERE tracking_token IS NOT NULL;

COMMENT ON COLUMN public.visits.tracking_token IS
  'The capability in the customer''s live-tracking link (/track/<token>). Minted by the server when "on my way" is sent with live tracking on. Read only through public_visit_tracking.';
COMMENT ON COLUMN public.visits.live_tracking_stopped_at IS
  'When the tech pressed Stop on location sharing. Sharing stays off for this visit unless a newer "on my way" is sent.';

-- ── 3. The window, stated once ──────────────────────────────────────────────
--
-- No table access, so it answers nothing about anybody's tenant. It is
-- called only from inside the SECURITY DEFINER functions below, which run as
-- their owner, so no API role needs EXECUTE on it.

CREATE OR REPLACE FUNCTION public.live_tracking_window_open(
  _enabled boolean,
  _status public.visit_status,
  _sent_at timestamptz,
  _stopped_at timestamptz,
  _at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE(_enabled, false)
     AND _status = 'scheduled'
     AND _sent_at IS NOT NULL
     AND _at < _sent_at + interval '2 hours'
     AND (_stopped_at IS NULL OR _stopped_at < _sent_at)
$function$;

REVOKE ALL ON FUNCTION public.live_tracking_window_open(boolean, public.visit_status, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;

-- ── 4. The latest position, and nothing else ────────────────────────────────

CREATE TABLE IF NOT EXISTS public.visit_live_locations (
  -- One row per visit: an upsert replaces it, so there is never a trail.
  visit_id uuid PRIMARY KEY REFERENCES public.visits(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  -- Metres, as the device reports it. Never shown to the customer.
  accuracy real,
  -- Set by the database, whatever the caller sends: freshness is judged on
  -- the server's clock, not the phone's.
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visit_live_locations_lat_range CHECK (lat BETWEEN -90 AND 90),
  CONSTRAINT visit_live_locations_lng_range CHECK (lng BETWEEN -180 AND 180),
  CONSTRAINT visit_live_locations_accuracy_range CHECK (accuracy IS NULL OR (accuracy >= 0 AND accuracy <= 100000))
);

COMMENT ON TABLE public.visit_live_locations IS
  'The assigned tech''s latest position for a visit while "on my way" is live: one row per visit, upserted, deleted when the visit starts, when the tech presses Stop, when tracking is turned off, and nightly once the window has closed. The customer reaches it only through public_visit_tracking, rounded.';

-- Every foreign key indexed. visit_id is the primary key.
CREATE INDEX IF NOT EXISTS visit_live_locations_organization_id
  ON public.visit_live_locations (organization_id);
CREATE INDEX IF NOT EXISTS visit_live_locations_staff_id
  ON public.visit_live_locations (staff_id);

CREATE OR REPLACE FUNCTION public.visit_live_locations_stamp()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.recorded_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.visit_live_locations_stamp() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visit_live_locations_stamp ON public.visit_live_locations;
CREATE TRIGGER visit_live_locations_stamp
  BEFORE INSERT OR UPDATE ON public.visit_live_locations
  FOR EACH ROW EXECUTE FUNCTION public.visit_live_locations_stamp();

-- ── The write check ─────────────────────────────────────────────────────────
--
-- SECURITY DEFINER so the check does not depend on what the caller can read
-- of visits, organizations and staff. It asks whose ids it was handed: the
-- staff row must be the CALLER's (auth.uid()), active, in that org, and the
-- one the visit is assigned to. So it cannot be used to ask a question about
-- another tenant; the answer for anyone else's ids is always false.

CREATE OR REPLACE FUNCTION public.may_share_live_location(
  _visit_id uuid,
  _organization_id uuid,
  _staff_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1
      FROM public.visits v
      JOIN public.organizations o ON o.id = v.organization_id
      JOIN public.staff s ON s.id = v.assigned_staff_id
     WHERE v.id = _visit_id
       AND v.organization_id = _organization_id
       AND s.id = _staff_id
       AND s.organization_id = _organization_id
       AND s.active
       AND auth.uid() IS NOT NULL
       AND s.user_id = auth.uid()
       AND public.is_org_member(auth.uid(), _organization_id)
       AND public.live_tracking_window_open(
             o.live_tracking_enabled, v.status, v.on_my_way_sent_at,
             v.live_tracking_stopped_at, now())
  )
$function$;

REVOKE ALL ON FUNCTION public.may_share_live_location(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_share_live_location(uuid, uuid, uuid) TO authenticated, service_role;

ALTER TABLE public.visit_live_locations ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.visit_live_locations FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visit_live_locations TO authenticated;
GRANT ALL ON public.visit_live_locations TO service_role;

-- The tech's own rows (an upsert reads the row it replaces), and the office's
-- whole org. Not another tech's: a tech has no reason to watch a colleague.
DROP POLICY IF EXISTS "live locations: own, or the office's (select)" ON public.visit_live_locations;
CREATE POLICY "live locations: own, or the office's (select)" ON public.visit_live_locations
  FOR SELECT TO authenticated
  USING (
    staff_id IN (SELECT s.id FROM public.staff s WHERE s.user_id = (SELECT auth.uid()))
    OR public.can_write_org((SELECT auth.uid()), organization_id)
  );

DROP POLICY IF EXISTS "live locations: assigned tech, window open (insert)" ON public.visit_live_locations;
CREATE POLICY "live locations: assigned tech, window open (insert)" ON public.visit_live_locations
  FOR INSERT TO authenticated
  WITH CHECK (public.may_share_live_location(visit_id, organization_id, staff_id));

DROP POLICY IF EXISTS "live locations: assigned tech, window open (update)" ON public.visit_live_locations;
CREATE POLICY "live locations: assigned tech, window open (update)" ON public.visit_live_locations
  FOR UPDATE TO authenticated
  USING (public.may_share_live_location(visit_id, organization_id, staff_id))
  WITH CHECK (public.may_share_live_location(visit_id, organization_id, staff_id));

-- Forgetting is always allowed to the tech whose position it is, and to the
-- office. Nobody needs a window to be open to delete.
DROP POLICY IF EXISTS "live locations: own, or the office's (delete)" ON public.visit_live_locations;
CREATE POLICY "live locations: own, or the office's (delete)" ON public.visit_live_locations
  FOR DELETE TO authenticated
  USING (
    staff_id IN (SELECT s.id FROM public.staff s WHERE s.user_id = (SELECT auth.uid()))
    OR public.can_write_org((SELECT auth.uid()), organization_id)
  );

-- ── A closed window leaves nothing behind ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.visit_live_locations_forget_visit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM public.visit_live_locations WHERE visit_id = NEW.id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.visit_live_locations_forget_visit() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visit_live_locations_forget_visit ON public.visits;
CREATE TRIGGER visit_live_locations_forget_visit
  AFTER UPDATE OF status, live_tracking_stopped_at ON public.visits
  FOR EACH ROW
  WHEN (
    (OLD.status IS DISTINCT FROM NEW.status AND NEW.status <> 'scheduled')
    OR (NEW.live_tracking_stopped_at IS NOT NULL
        AND OLD.live_tracking_stopped_at IS DISTINCT FROM NEW.live_tracking_stopped_at)
  )
  EXECUTE FUNCTION public.visit_live_locations_forget_visit();

CREATE OR REPLACE FUNCTION public.visit_live_locations_forget_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  DELETE FROM public.visit_live_locations WHERE organization_id = NEW.id;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.visit_live_locations_forget_org() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visit_live_locations_forget_org ON public.organizations;
CREATE TRIGGER visit_live_locations_forget_org
  AFTER UPDATE OF live_tracking_enabled ON public.organizations
  FOR EACH ROW
  WHEN (OLD.live_tracking_enabled AND NOT NEW.live_tracking_enabled)
  EXECUTE FUNCTION public.visit_live_locations_forget_org();

-- The nightly sweep, for a window that closed by the clock (2 hours) rather
-- than by an event. Called by src/routes/api/public/hooks/nightly.ts.
CREATE OR REPLACE FUNCTION public.prune_visit_live_locations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _n integer;
BEGIN
  DELETE FROM public.visit_live_locations l
   WHERE NOT EXISTS (
     SELECT 1
       FROM public.visits v
       JOIN public.organizations o ON o.id = v.organization_id
      WHERE v.id = l.visit_id
        AND public.live_tracking_window_open(
              o.live_tracking_enabled, v.status, v.on_my_way_sent_at,
              v.live_tracking_stopped_at, now())
   );
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

REVOKE ALL ON FUNCTION public.prune_visit_live_locations() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_visit_live_locations() TO service_role;

-- ── 5. What the customer's link shows ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.public_visit_tracking(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _v public.visits%ROWTYPE;
  _org record;
  _tech_name text;
  _home_lat numeric;
  _home_lng numeric;
  _tech_lat numeric;
  _tech_lng numeric;
  _tech_at timestamptz;
  _open boolean;
  _status text;
BEGIN
  IF _token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO _v FROM public.visits WHERE tracking_token = _token;
  -- A token whose message never went has told nobody anything. NULL either
  -- way, so it cannot be told apart from a mistyped one.
  IF _v.id IS NULL OR _v.on_my_way_sent_at IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT name, timezone, live_tracking_enabled INTO _org
    FROM public.organizations WHERE id = _v.organization_id;

  -- The first word of the name, which is what a customer calls the person at
  -- their gate. Never the surname.
  SELECT NULLIF((regexp_split_to_array(btrim(display_name), '\s+'))[1], '') INTO _tech_name
    FROM public.staff WHERE id = _v.assigned_staff_id;

  _open := public.live_tracking_window_open(
             _org.live_tracking_enabled, _v.status, _v.on_my_way_sent_at,
             _v.live_tracking_stopped_at, now());

  _status := CASE
    WHEN _v.status = 'in_progress' THEN 'arrived'
    WHEN _v.status = 'completed' THEN 'done'
    WHEN _v.status = 'scheduled' AND _v.on_my_way_sent_at + interval '2 hours' > now() THEN 'en_route'
    -- Two hours on, skipped, cancelled or missed: the link has ended.
    ELSE 'ended'
  END;

  IF _status <> 'en_route' THEN
    -- Nothing locational once the tech has arrived, or after.
    RETURN jsonb_build_object(
      'status', _status,
      'business_name', _org.name,
      'tech_first_name', _tech_name
    );
  END IF;

  SELECT round(p.latitude::numeric, 3), round(p.longitude::numeric, 3) INTO _home_lat, _home_lng
    FROM public.properties p
   WHERE p.id = _v.property_id AND p.latitude IS NOT NULL AND p.longitude IS NOT NULL;

  -- The tech's position only while the window is open (tracking on, not
  -- stopped), only if it is the assigned tech's, and only if it is fresh.
  IF _open THEN
    SELECT round(l.lat::numeric, 3), round(l.lng::numeric, 3), l.recorded_at
      INTO _tech_lat, _tech_lng, _tech_at
      FROM public.visit_live_locations l
     WHERE l.visit_id = _v.id
       AND l.staff_id IS NOT DISTINCT FROM _v.assigned_staff_id
       AND l.recorded_at > now() - interval '10 minutes';
  END IF;

  RETURN jsonb_build_object(
    'status', _status,
    'business_name', _org.name,
    'tech_first_name', _tech_name,
    'timezone', _org.timezone,
    'eta_start', _v.eta_start,
    'eta_end', _v.eta_end,
    'sharing', _open,
    'tech_lat', _tech_lat,
    'tech_lng', _tech_lng,
    'tech_recorded_at', _tech_at,
    'home_lat', _home_lat,
    'home_lng', _home_lng
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_visit_tracking(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_visit_tracking(uuid) TO service_role;

-- ── What this file establishes ──────────────────────────────────────────────

DO $check$
DECLARE
  _fk record;
  _fn text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'live_tracking_enabled' AND column_default = 'false' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'organizations.live_tracking_enabled is missing, nullable, or does not default to false';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits'
       AND column_name = 'tracking_token' AND data_type = 'uuid'
  ) THEN
    RAISE EXCEPTION 'visits.tracking_token is missing or not a uuid';
  END IF;
  IF NOT (SELECT indisunique FROM pg_index WHERE indexrelid = 'public.visits_tracking_token_key'::regclass) THEN
    RAISE EXCEPTION 'visits.tracking_token is not unique';
  END IF;

  IF to_regclass('public.visit_live_locations') IS NULL THEN
    RAISE EXCEPTION 'visit_live_locations was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.visit_live_locations'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on visit_live_locations';
  END IF;
  -- One row per visit: the primary key is the visit.
  IF (SELECT array_agg(a.attname::text) FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
       WHERE i.indrelid = 'public.visit_live_locations'::regclass AND i.indisprimary)
     IS DISTINCT FROM ARRAY['visit_id'] THEN
    RAISE EXCEPTION 'visit_live_locations is not keyed by visit alone, so it can hold a trail';
  END IF;
  -- anon: no privilege, and no policy.
  IF has_table_privilege('anon', 'public.visit_live_locations', 'SELECT')
     OR has_table_privilege('anon', 'public.visit_live_locations', 'INSERT')
     OR has_table_privilege('anon', 'public.visit_live_locations', 'UPDATE')
     OR has_table_privilege('anon', 'public.visit_live_locations', 'DELETE') THEN
    RAISE EXCEPTION 'anon holds a privilege on visit_live_locations';
  END IF;
  IF has_table_privilege('authenticated', 'public.visit_live_locations', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated can TRUNCATE visit_live_locations, which RLS does not see';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'visit_live_locations'
                AND ('anon' = ANY (roles) OR 'public' = ANY (roles) OR cmd = 'ALL')) THEN
    RAISE EXCEPTION 'visit_live_locations has a policy for anon or public, or a FOR ALL policy';
  END IF;
  -- Every write goes through the window check.
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'visit_live_locations'
                AND cmd IN ('INSERT', 'UPDATE')
                AND COALESCE(with_check, '') !~ 'may_share_live_location') THEN
    RAISE EXCEPTION 'a visit_live_locations write policy does not ask may_share_live_location';
  END IF;
  FOR _fk IN
    SELECT con.conname, con.conkey[1] AS attnum
      FROM pg_constraint con
     WHERE con.conrelid = 'public.visit_live_locations'::regclass AND con.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.visit_live_locations'::regclass AND i.indkey[0] = _fk.attnum
    ) THEN
      RAISE EXCEPTION 'foreign key % on visit_live_locations has no index', _fk.conname;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.visit_live_locations_stamp()',
    'public.visit_live_locations_forget_visit()',
    'public.visit_live_locations_forget_org()'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'trigger function % is executable by an API role', _fn;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visit_live_locations_forget_visit'
                   AND tgrelid = 'public.visits'::regclass) THEN
    RAISE EXCEPTION 'starting a visit does not forget its location';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visit_live_locations_forget_org'
                   AND tgrelid = 'public.organizations'::regclass) THEN
    RAISE EXCEPTION 'turning tracking off does not forget the org''s locations';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'visit_live_locations_stamp'
                   AND tgrelid = 'public.visit_live_locations'::regclass) THEN
    RAISE EXCEPTION 'visit_live_locations.recorded_at is not stamped by the database';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.public_visit_tracking(uuid)',
    'public.prune_visit_live_locations()',
    'public.live_tracking_window_open(boolean, public.visit_status, timestamptz, timestamptz, timestamptz)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable by anon or authenticated', _fn;
    END IF;
  END LOOP;
  FOREACH _fn IN ARRAY ARRAY['public.public_visit_tracking(uuid)', 'public.prune_visit_live_locations()'] LOOP
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot execute %', _fn;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.may_share_live_location(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute may_share_live_location';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.may_share_live_location(uuid, uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute may_share_live_location, so no tech can write';
  END IF;

  FOREACH _fn IN ARRAY ARRAY[
    'public.public_visit_tracking(uuid)',
    'public.may_share_live_location(uuid, uuid, uuid)',
    'public.prune_visit_live_locations()',
    'public.visit_live_locations_forget_visit()',
    'public.visit_live_locations_forget_org()'
  ] LOOP
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn::regprocedure) THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER', _fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc, unnest(proconfig) AS cfg
       WHERE oid = _fn::regprocedure AND cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION '% has no fixed search_path', _fn;
    END IF;
  END LOOP;

  -- The write check asks whose ids it was handed.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.may_share_live_location(uuid, uuid, uuid)'::regprocedure)
       !~ 's\.user_id = auth\.uid\(\)' THEN
    RAISE EXCEPTION 'may_share_live_location does not check that the staff row is the caller''s';
  END IF;
  -- The customer never gets an exact position.
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.public_visit_tracking(uuid)'::regprocedure)
       !~ 'round\(l\.lat::numeric, 3\)' THEN
    RAISE EXCEPTION 'public_visit_tracking does not round the tech''s position';
  END IF;
END
$check$;
