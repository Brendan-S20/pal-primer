-- The portal reads a lesson's shared note through a function that cannot
-- return the trainer's own note.
--
-- training_session_notes holds two notes: `note`, which the client sees, and
-- `trainer_note` (20261023121200), which is staff only. Until now the portal
-- kept trainer_note back by selecting `visit_id, note` from the table. That
-- holds only while every portal read names its columns. A `select('*')`, or
-- a new staff-only column, would reach the customer.
--
-- portal_training_lesson_notes returns (visit_id, note) and nothing else: its
-- RETURNS TABLE is the column list. It is the service role's, like the other
-- portal functions; the portal handler calls it after the session check, for
-- the session's own organization and client. A visit belongs to a client
-- through visits.client_id, so a visit id from another client in the same
-- business returns nothing. A row with only a trainer note returns nothing.
--
-- Replays into an empty database: one function and its grants, then a check
-- on the function's own signature.

-- An earlier draft of this file took (_organization_id, _visit_ids) with no
-- client. It was never merged; dropping it keeps a database that ran the
-- draft from holding that overload.
DROP FUNCTION IF EXISTS public.portal_training_lesson_notes(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.portal_training_lesson_notes(
  _organization_id uuid, _client_id uuid, _visit_ids uuid[]
)
RETURNS TABLE (visit_id uuid, note text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT n.visit_id, n.note
    FROM public.training_session_notes n
    JOIN public.visits v ON v.id = n.visit_id
   WHERE n.organization_id = _organization_id
     AND v.organization_id = _organization_id
     AND v.client_id = _client_id
     AND n.visit_id = ANY(_visit_ids)
     AND n.note IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.portal_training_lesson_notes(uuid, uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_training_lesson_notes(uuid, uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.portal_training_lesson_notes(uuid, uuid, uuid[]) IS
  'The customer portal''s read of lesson notes: visit_id and the shared note only, for the client''s own visits. The staff-only note is never returned.';

DO $post$
DECLARE _cols text[];
BEGIN
  SELECT array_agg(a ORDER BY o)
    INTO _cols
    FROM pg_proc p,
         unnest(p.proargnames, p.proargmodes::text[]) WITH ORDINALITY AS u(a, m, o)
   WHERE p.oid = 'public.portal_training_lesson_notes(uuid, uuid, uuid[])'::regprocedure
     AND u.m = 't';
  IF _cols IS DISTINCT FROM ARRAY['visit_id', 'note'] THEN
    RAISE EXCEPTION 'portal_training_lesson_notes returns %, expected {visit_id,note}', _cols;
  END IF;
  IF has_function_privilege('anon', 'public.portal_training_lesson_notes(uuid, uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_training_lesson_notes(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_training_lesson_notes is reachable by anon or authenticated';
  END IF;
  IF to_regprocedure('public.portal_training_lesson_notes(uuid, uuid[])') IS NOT NULL THEN
    RAISE EXCEPTION 'portal_training_lesson_notes(uuid, uuid[]) still exists, with no client filter';
  END IF;
END $post$;
