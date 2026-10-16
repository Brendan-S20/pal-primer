-- A stay's codes are for the stay's sitter, during the stay (#411 review,
-- blocker 2).
--
-- Walking already limits the gate code, lock box code, key location and key
-- tag (20261015215000): plain SELECT of those columns is revoked, and
-- property_access_codes returns them to the office or to a tech assigned to
-- a visit there today. A stay is a home left empty for a week, so it gets
-- the same shape with its own window:
--
--   stay_access_codes(_stay_ids) returns the gate code, lock box code, key
--   location, key tag and alarm details for a stay's property to
--     - the office (can_write_org), or
--     - an active sitter assigned to a visit of that stay that is scheduled
--       or in progress, or who is the stay's sitter and has a visit on it,
--       from the day before the stay's first visit to the end of its last
--       visit day, in the business's timezone.
--   Taking the sitter off the stay (setStaySitter) moves the visits to come
--   and changes stays.assigned_staff_id, so the old sitter loses access the
--   same moment. A canceled stay gives nobody a code.
--
--   Every row it returns is written to activity_log (kind
--   stay.access_viewed), the business's existing audit trail, with who asked
--   and which stay. So it is VOLATILE and plpgsql, unlike the walking read.
--
-- property_access_codes keeps its rule and gains alarm_notes, but a tech's
-- visit that belongs to a stay no longer opens it. Otherwise a sitter on a
-- stay visit today would read the same codes there, unlogged. A tech with an
-- ordinary walk or scoop visit at the home today still gets the codes there.
--
-- properties.alarm_notes is new, and like the lock box code it is not
-- granted to authenticated: 20261015215000 replaced the table grant with a
-- column list, and this column is left out of it on purpose. The gate code
-- keeps its place in property_access_codes: dropping the function must not
-- drop it from the return, or nobody signed in could read it. My Day reads a
-- stay visit's gate code from stay_access_codes, like its other codes.
--
-- Replays into an empty database: one column and two functions. No row is
-- needed and no number is asserted.

ALTER TABLE public.properties ADD COLUMN IF NOT EXISTS alarm_notes text;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.properties'::regclass AND conname = 'properties_alarm_notes_length') THEN
    ALTER TABLE public.properties ADD CONSTRAINT properties_alarm_notes_length
      CHECK (alarm_notes IS NULL OR char_length(alarm_notes) <= 500);
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.properties.alarm_notes IS
  'Alarm details for whoever lets themselves in: code, panel, who to call. Not granted to authenticated; read through property_access_codes or stay_access_codes. Migration 20261017010000.';

-- The return type changes, so the walking function is dropped and made again
-- with the same grants.
DROP FUNCTION IF EXISTS public.property_access_codes(uuid[]);

CREATE FUNCTION public.property_access_codes(_property_ids uuid[])
RETURNS TABLE (property_id uuid, gate_code text, lock_box_code text, key_location text, key_tag text, alarm_notes text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT p.id, p.gate_code, p.lock_box_code, p.key_location, p.key_tag, p.alarm_notes
    FROM public.properties p
    JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = ANY (COALESCE(_property_ids, '{}'::uuid[]))
     AND (
       public.has_permission((SELECT auth.uid()), p.organization_id, 'view_client_directory')
       OR EXISTS (
         SELECT 1
           FROM public.visits v
           JOIN public.staff s ON s.id = v.assigned_staff_id
          WHERE v.property_id = p.id
            AND v.organization_id = p.organization_id
            AND s.user_id = (SELECT auth.uid())
            AND s.organization_id = p.organization_id
            AND s.active
            AND v.status IN ('scheduled', 'in_progress')
            AND v.scheduled_on = (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date
            -- A stay visit opens the codes only through stay_access_codes.
            AND NOT EXISTS (SELECT 1 FROM public.subscriptions sub
                             WHERE sub.id = v.subscription_id AND sub.stay_id IS NOT NULL)
       )
     );
$function$;

REVOKE ALL ON FUNCTION public.property_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.property_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.property_access_codes(uuid[]) IS
  'Gate code, lock box code, key location, key tag and alarm details. Office (view_client_directory), or an active tech assigned to a scheduled or in-progress visit at the property today that is not a stay visit. Plain SELECT of these columns is revoked from authenticated. Migrations 20261015215000, 20261017010000.';

CREATE OR REPLACE FUNCTION public.stay_access_codes(_stay_ids uuid[])
RETURNS TABLE (
  stay_id uuid,
  property_id uuid,
  gate_code text,
  lock_box_code text,
  key_location text,
  key_tag text,
  alarm_notes text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  _uid uuid := auth.uid();
  _row record;
  _staff_name text;
BEGIN
  IF _uid IS NULL THEN RETURN; END IF;
  FOR _row IN
    SELECT st.id AS stay_id, st.organization_id, st.client_id, p.id AS property_id,
           p.gate_code, p.lock_box_code, p.key_location, p.key_tag, p.alarm_notes,
           public.can_write_org(_uid, st.organization_id) AS office
      FROM (SELECT DISTINCT a.id FROM unnest(COALESCE(_stay_ids, '{}'::uuid[])) AS a(id)) asked
      JOIN public.stays st ON st.id = asked.id
      JOIN public.properties p ON p.id = st.property_id
      JOIN public.organizations o ON o.id = st.organization_id
      CROSS JOIN LATERAL (
        SELECT min(v.scheduled_on) AS first_day, max(v.scheduled_on) AS last_day
          FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
         WHERE s.stay_id = st.id AND v.status <> 'canceled'
      ) w
     WHERE st.status <> 'canceled'
       AND (
         public.can_write_org(_uid, st.organization_id)
         OR EXISTS (
           SELECT 1
             FROM public.staff sf
             JOIN public.visits v ON v.assigned_staff_id = sf.id
             JOIN public.subscriptions s ON s.id = v.subscription_id
            WHERE sf.user_id = _uid
              AND sf.organization_id = st.organization_id
              AND sf.active
              AND s.stay_id = st.id
              AND (v.status IN ('scheduled', 'in_progress')
                   OR (st.assigned_staff_id = sf.id AND v.status <> 'canceled'))
              AND (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date
                  BETWEEN w.first_day - 1 AND w.last_day
         )
       )
     LIMIT 200
  LOOP
    SELECT display_name INTO _staff_name FROM public.staff
     WHERE user_id = _uid AND organization_id = _row.organization_id LIMIT 1;
    INSERT INTO public.activity_log (organization_id, client_id, property_id, actor_user_id, actor_label, kind, summary, meta)
    VALUES (_row.organization_id, _row.client_id, _row.property_id, _uid, _staff_name, 'stay.access_viewed',
            'Viewed the access codes for a stay',
            jsonb_build_object('stay_id', _row.stay_id, 'as', CASE WHEN _row.office THEN 'office' ELSE 'sitter' END));
    stay_id := _row.stay_id;
    property_id := _row.property_id;
    gate_code := _row.gate_code;
    lock_box_code := _row.lock_box_code;
    key_location := _row.key_location;
    key_tag := _row.key_tag;
    alarm_notes := _row.alarm_notes;
    RETURN NEXT;
  END LOOP;
END;
$function$;

REVOKE ALL ON FUNCTION public.stay_access_codes(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stay_access_codes(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.stay_access_codes(uuid[]) IS
  'Gate code, lock box code, key location, key tag and alarm details for each stay''s home. The office (can_write_org), or an active sitter assigned to the stay, from the day before its first visit to its last visit day. Every row returned is logged to activity_log as stay.access_viewed. Migration 20261017010000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _fn text;
BEGIN
  IF has_column_privilege('authenticated', 'public.properties', 'alarm_notes', 'SELECT')
     OR has_column_privilege('anon', 'public.properties', 'alarm_notes', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated or anon can select properties.alarm_notes';
  END IF;
  IF has_column_privilege('authenticated', 'public.properties', 'lock_box_code', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can select properties.lock_box_code again';
  END IF;
  IF has_column_privilege('authenticated', 'public.properties', 'gate_code', 'SELECT')
     OR has_column_privilege('anon', 'public.properties', 'gate_code', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated or anon can select properties.gate_code again';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure)
       !~ '\mp\.gate_code\M' THEN
    RAISE EXCEPTION 'property_access_codes does not return the gate code';
  END IF;
  FOREACH _fn IN ARRAY ARRAY['public.property_access_codes(uuid[])', 'public.stay_access_codes(uuid[])'] LOOP
    IF to_regprocedure(_fn) IS NULL
       OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure(_fn)) THEN
      RAISE EXCEPTION '% is missing or does not run as its owner', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% grants are wrong', _fn;
    END IF;
  END LOOP;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure)
       NOT LIKE '%sub.stay_id IS NOT NULL%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.property_access_codes(uuid[])'::regprocedure)
       NOT LIKE '%v.status IN (''scheduled'', ''in_progress'')%' THEN
    RAISE EXCEPTION 'property_access_codes does not keep its rule or still opens for a stay visit';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure)
       NOT LIKE '%w.first_day - 1 AND w.last_day%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure)
       NOT LIKE '%INSERT INTO public.activity_log%'
     OR (SELECT prosrc FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure)
       !~ '\msf\.active\M' THEN
    RAISE EXCEPTION 'stay_access_codes does not check the window, the staff row or log the view';
  END IF;
END
$check$;
