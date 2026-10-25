-- A sitter covering one visit of a stay sees the codes on that visit's day
-- (#478 review).
--
-- 20261024080500 let any active staff member with a scheduled or in-progress
-- visit on a stay read its codes for the whole stay window. A sitter covering
-- one drop-in on day 5 could read the lock box code from the day before day 1.
--
-- stay_access_codes(_stay_ids) now returns a stay's codes to
--   - the office, checked with view_client_directory, the same check
--     property_access_codes makes, so a role that cannot see the client
--     directory cannot read a stay's codes either;
--   - the stay's sitter (stays.assigned_staff_id), active, with a visit on
--     the stay that is not canceled, from the day before the stay's first
--     visit to the end of its last visit day. Unchanged;
--   - anyone else who is active and assigned to a scheduled or in-progress
--     visit of the stay, on that visit's day only.
-- All dates are in the business's timezone.
--
-- A covering sitter does not get the day before. The stay's sitter gets it
-- because the home is about to be left and the keys change hands then. A
-- covering visit happens while the stay is already running, and the day
-- before it belongs to the stay's sitter.
--
-- Same signature, same grants, same activity_log row (stay.access_viewed,
-- with 'as' office or sitter).
--
-- Replays into an empty database: one function replaced. No row is needed
-- and no number is asserted.

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
           public.has_permission(_uid, st.organization_id, 'view_client_directory') AS office
      FROM (SELECT DISTINCT a.id FROM unnest(COALESCE(_stay_ids, '{}'::uuid[])) AS a(id)) asked
      JOIN public.stays st ON st.id = asked.id
      JOIN public.properties p ON p.id = st.property_id
      JOIN public.organizations o ON o.id = st.organization_id
      CROSS JOIN LATERAL (
        SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date AS today
      ) t
      CROSS JOIN LATERAL (
        SELECT min(v.scheduled_on) AS first_day, max(v.scheduled_on) AS last_day
          FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
         WHERE s.stay_id = st.id AND v.status <> 'canceled'
      ) w
     WHERE st.status <> 'canceled'
       AND (
         public.has_permission(_uid, st.organization_id, 'view_client_directory')
         -- The stay's sitter: the whole window.
         OR EXISTS (
           SELECT 1
             FROM public.staff sf
             JOIN public.visits v ON v.assigned_staff_id = sf.id
             JOIN public.subscriptions s ON s.id = v.subscription_id
            WHERE sf.id = st.assigned_staff_id
              AND sf.user_id = _uid
              AND sf.organization_id = st.organization_id
              AND sf.active
              AND s.stay_id = st.id
              AND v.status <> 'canceled'
              AND t.today BETWEEN w.first_day - 1 AND w.last_day
         )
         -- Anyone covering a visit: that visit's day.
         OR EXISTS (
           SELECT 1
             FROM public.staff sf
             JOIN public.visits v ON v.assigned_staff_id = sf.id
             JOIN public.subscriptions s ON s.id = v.subscription_id
            WHERE sf.user_id = _uid
              AND sf.organization_id = st.organization_id
              AND sf.active
              AND s.stay_id = st.id
              AND v.status IN ('scheduled', 'in_progress')
              AND v.scheduled_on = t.today
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
  'Gate code, lock box code, key location, key tag and alarm details for each stay''s home. The office (view_client_directory); the stay''s sitter (stays.assigned_staff_id) from the day before its first visit to its last visit day; anyone else assigned to a scheduled or in-progress visit of the stay on that visit''s day only. Every row returned is logged to activity_log as stay.access_viewed. Migrations 20261024080500, 20261024081000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _src text;
BEGIN
  IF to_regprocedure('public.stay_access_codes(uuid[])') IS NULL
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'stay_access_codes is missing or does not run as its owner';
  END IF;
  IF has_function_privilege('anon', 'public.stay_access_codes(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stay_access_codes(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'stay_access_codes grants are wrong';
  END IF;
  SELECT prosrc INTO _src FROM pg_proc WHERE oid = 'public.stay_access_codes(uuid[])'::regprocedure;
  IF _src LIKE '%can_write_org%'
     OR _src NOT LIKE '%''view_client_directory''%' THEN
    RAISE EXCEPTION 'stay_access_codes does not use the property_access_codes office check';
  END IF;
  IF _src NOT LIKE '%sf.id = st.assigned_staff_id%'
     OR _src NOT LIKE '%w.first_day - 1 AND w.last_day%'
     OR _src NOT LIKE '%v.scheduled_on = t.today%' THEN
    RAISE EXCEPTION 'stay_access_codes does not limit the window to the stay''s sitter and a covering sitter to their visit day';
  END IF;
  IF _src NOT LIKE '%INSERT INTO public.activity_log%' OR _src !~ '\msf\.active\M' THEN
    RAISE EXCEPTION 'stay_access_codes does not check the staff row or log the view';
  END IF;
END
$check$;
