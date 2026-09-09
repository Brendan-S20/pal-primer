-- The customer was told which photo was "before" by counting.
--
-- src/lib/portal-ui.tsx labelled a visit's photos `i % 2 === 0 ? "Before" :
-- "After"` -- the position in the array, not the photograph. And the array
-- came from this function, which selects `vp.storage_path` and nothing else,
-- so position was genuinely all the page had.
--
-- `visit_photos.kind` exists, is populated, and is written explicitly by the
-- field app: recordVisitPhoto validates `completion | before | issue` and My
-- Day reads it straight back. Only the customer's view dropped it. So:
--
--   * any odd number of photos mislabels everything after the gap
--   * two consecutive photos of the same kind mislabel each other
--   * a `completion` photo is captioned "Before" or "After" at random --
--     which is what happened to the one genuine field upload in this database
--   * an `issue` photo, taken to document a problem, is served to the
--     customer captioned as a routine before-and-after
--
-- Returned as a parallel array rather than a composite so the existing
-- `photo_paths` shape is untouched and no caller has to change at once. Both
-- come from the same subquery with the same ORDER BY, so index i in one is
-- index i in the other -- which is the property the page needs and the only
-- thing that makes parallel arrays safe.
-- DROP first, because this ADDS a column to the returned row.
--
-- `CREATE OR REPLACE FUNCTION` cannot change a function's return type:
-- Postgres answers "cannot change return type of existing function / Row type
-- defined by OUT parameters is different / Use DROP FUNCTION ... first". The
-- replace succeeds only where the function does not exist yet, which is why
-- this passed against a scratch database and failed the moment it ran on top
-- of the definition an earlier migration had already created -- which is what
-- a replay is, and the only thing a replay is for.
DROP FUNCTION IF EXISTS public.portal_list_recent_visits(uuid);

CREATE OR REPLACE FUNCTION public.portal_list_recent_visits(_token uuid)
RETURNS TABLE(visit_id uuid, scheduled_on date, status visit_status, photo_paths text[],
              photo_kinds text[], tech_name text, completed_at timestamp with time zone,
              skip_reason text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.id, v.scheduled_on, v.status,
         COALESCE(ARRAY(
           SELECT vp.storage_path FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at, vp.id
         ), ARRAY[]::text[]),
         COALESCE(ARRAY(
           SELECT vp.kind::text FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at, vp.id
         ), ARRAY[]::text[]),
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         v.completed_at, v.skip_reason
    FROM public.visits v
    JOIN public.clients c ON c.id = v.client_id
   WHERE c.portal_token = _token AND c.active = true
     AND v.status IN ('completed','skipped')
   ORDER BY v.scheduled_on DESC
   LIMIT 30
$function$;

REVOKE ALL ON FUNCTION public.portal_list_recent_visits(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_recent_visits(uuid) TO service_role;

DO $est$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_list_recent_visits';
  IF regexp_replace(_src, '--[^\n]*', '', 'g') NOT LIKE '%vp.kind::text%' THEN
    RAISE EXCEPTION 'portal_list_recent_visits still does not return what kind each photo is';
  END IF;

  -- The two arrays must be ordered identically or the labels are worse than
  -- counting was. `created_at` alone is not a total order -- the seeder writes
  -- a whole visit's photos in one statement, so they share a timestamp to the
  -- microsecond -- hence the id tiebreaker, in both.
  IF (length(_src) - length(replace(_src, 'ORDER BY vp.created_at, vp.id', ''))) / length('ORDER BY vp.created_at, vp.id') <> 2 THEN
    RAISE EXCEPTION 'the path and kind arrays are not ordered by the same total order';
  END IF;
END $est$;
