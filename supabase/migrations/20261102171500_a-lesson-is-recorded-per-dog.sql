-- A lesson's scores, notes and homework belong to a dog, not only to the visit
-- (R2-26, train-13).
--
-- Until now session_progress was unique on (visit_id, skill_id), and
-- training_session_notes and homework were keyed by visit_id alone. A lesson
-- with two dogs at the house (a reactive dog and a puppy) had one set of
-- scores, one note and one homework entry between them, and a dog's history
-- could only be pieced together through its package.
--
-- 1. Each of the three tables gets dog_id (homework already had it). A row is
--    now one dog's record of one lesson: unique on (visit_id, dog_id[,
--    skill_id]) with NULLS NOT DISTINCT, so a lesson at a house with no dog
--    on file still has exactly one record, as before. training_session_notes
--    and homework get their own id as the primary key, since visit_id alone
--    no longer identifies a row.
-- 2. dog_id is ON DELETE SET NULL, like homework's. A dog with any lesson
--    record is deactivated rather than deleted (dogDeleteOutcome counts them),
--    so the SET NULL path is only reached by a hard delete outside the app.
-- 3. Existing rows are given the lesson's dog where it is certain: the dog
--    homework already named for that visit, else the package's dog, else the
--    only active dog at the lesson's property, and only a dog at that property.
--    Anything else stays NULL (a whole-lesson record).
-- 4. training_progress_row_guard now checks dog_id on all three tables: the
--    dog must live at the lesson's property, in this business. Same function,
--    same triggers; no new trigger function.
-- 5. portal_training_lesson_notes returns (visit_id, dog_id, note). Its
--    RETURNS TABLE is still the column list, and the trainer-only note is
--    still not in it.
--
-- Replays into an empty database: columns, constraints and functions only;
-- the backfill updates no rows on a fresh build.

-- ── 1–2. Columns and keys ───────────────────────────────────────────────────

ALTER TABLE public.session_progress
  ADD COLUMN IF NOT EXISTS dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL;
ALTER TABLE public.training_session_notes
  ADD COLUMN IF NOT EXISTS dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL;

ALTER TABLE public.training_session_notes
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.homework
  ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();

-- ── 3. Backfill, before the new keys, while visit_id is still unique ─────────

DO $backfill$
DECLARE _n integer;
BEGIN
  -- The dog each lesson was for, where it can be known.
  DROP TABLE IF EXISTS pg_temp._lesson_dog;
  CREATE TEMP TABLE _lesson_dog AS
  SELECT v.id AS visit_id,
         COALESCE(
           (SELECT h.dog_id FROM public.homework h
              JOIN public.dogs d ON d.id = h.dog_id AND d.property_id = v.property_id
             WHERE h.visit_id = v.id),
           (SELECT cp.dog_id FROM public.client_packages cp
              JOIN public.dogs d ON d.id = cp.dog_id AND d.property_id = v.property_id
             WHERE cp.id = v.client_package_id),
           (SELECT min(d.id::text)::uuid FROM public.dogs d
             WHERE d.property_id = v.property_id AND d.organization_id = v.organization_id
               AND d.active
            HAVING count(*) = 1)
         ) AS dog_id
    FROM public.visits v
   WHERE EXISTS (SELECT 1 FROM public.session_progress s WHERE s.visit_id = v.id)
      OR EXISTS (SELECT 1 FROM public.training_session_notes n WHERE n.visit_id = v.id)
      OR EXISTS (SELECT 1 FROM public.homework h WHERE h.visit_id = v.id);

  UPDATE public.session_progress s SET dog_id = l.dog_id
    FROM _lesson_dog l
   WHERE l.visit_id = s.visit_id AND s.dog_id IS NULL AND l.dog_id IS NOT NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'session_progress rows given their dog: %', _n;

  UPDATE public.training_session_notes n SET dog_id = l.dog_id
    FROM _lesson_dog l
   WHERE l.visit_id = n.visit_id AND n.dog_id IS NULL AND l.dog_id IS NOT NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'training_session_notes rows given their dog: %', _n;

  UPDATE public.homework h SET dog_id = l.dog_id
    FROM _lesson_dog l
   WHERE l.visit_id = h.visit_id AND h.dog_id IS NULL AND l.dog_id IS NOT NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RAISE NOTICE 'homework rows given their dog: %', _n;
  DROP TABLE _lesson_dog;
END
$backfill$;

ALTER TABLE public.session_progress DROP CONSTRAINT IF EXISTS session_progress_visit_id_skill_id_key;
ALTER TABLE public.session_progress DROP CONSTRAINT IF EXISTS session_progress_visit_dog_skill_key;
ALTER TABLE public.session_progress
  ADD CONSTRAINT session_progress_visit_dog_skill_key
  UNIQUE NULLS NOT DISTINCT (visit_id, dog_id, skill_id);

ALTER TABLE public.training_session_notes DROP CONSTRAINT IF EXISTS training_session_notes_pkey;
ALTER TABLE public.training_session_notes ADD CONSTRAINT training_session_notes_pkey PRIMARY KEY (id);
ALTER TABLE public.training_session_notes DROP CONSTRAINT IF EXISTS training_session_notes_visit_dog_key;
ALTER TABLE public.training_session_notes
  ADD CONSTRAINT training_session_notes_visit_dog_key UNIQUE NULLS NOT DISTINCT (visit_id, dog_id);

ALTER TABLE public.homework DROP CONSTRAINT IF EXISTS homework_pkey;
ALTER TABLE public.homework ADD CONSTRAINT homework_pkey PRIMARY KEY (id);
ALTER TABLE public.homework DROP CONSTRAINT IF EXISTS homework_visit_dog_key;
ALTER TABLE public.homework
  ADD CONSTRAINT homework_visit_dog_key UNIQUE NULLS NOT DISTINCT (visit_id, dog_id);

-- A dog's history is read by dog.
CREATE INDEX IF NOT EXISTS session_progress_dog_idx ON public.session_progress(dog_id) WHERE dog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS training_session_notes_dog_idx ON public.training_session_notes(dog_id) WHERE dog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS homework_dog_idx ON public.homework(dog_id) WHERE dog_id IS NOT NULL;

COMMENT ON COLUMN public.session_progress.dog_id IS
  'The dog this score is for. NULL only for a lesson at a property with no dog on file, or a record from before 20261102171500 whose dog could not be told.';
COMMENT ON COLUMN public.training_session_notes.dog_id IS
  'The dog these notes are about. NULL as for session_progress.dog_id.';
COMMENT ON COLUMN public.homework.dog_id IS
  'The dog this homework is for. NULL as for session_progress.dog_id.';

-- ── 4. The guard checks the dog on every table ──────────────────────────────

CREATE OR REPLACE FUNCTION public.training_progress_row_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = NEW.visit_id AND v.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a lesson from this business.';
  END IF;
  -- skill_id is read inside its own IF: PL/pgSQL resolves every NEW field in
  -- an expression when it runs it, and only session_progress has skill_id.
  IF TG_TABLE_NAME = 'session_progress' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.training_skills s
      WHERE s.id = NEW.skill_id AND s.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a skill from this business.';
    END IF;
  END IF;
  -- All three tables have dog_id since 20261102171500.
  IF NEW.dog_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d
    JOIN public.visits v ON v.property_id = d.property_id
    WHERE d.id = NEW.dog_id AND v.id = NEW.visit_id AND d.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a dog at this lesson.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_progress_row_guard() FROM PUBLIC, anon, authenticated;

-- ── 5. The portal's note read names the dog ─────────────────────────────────

DROP FUNCTION IF EXISTS public.portal_training_lesson_notes(uuid, uuid, uuid[]);

CREATE FUNCTION public.portal_training_lesson_notes(
  _organization_id uuid, _client_id uuid, _visit_ids uuid[]
)
RETURNS TABLE (visit_id uuid, dog_id uuid, note text)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT n.visit_id, n.dog_id, n.note
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
  'The customer portal''s read of lesson notes: visit_id, the dog and the shared note only, for the client''s own visits. The staff-only note is never returned.';

-- ── Checks: what this file establishes ──────────────────────────────────────

DO $post$
DECLARE _cols text[]; _table text;
BEGIN
  FOREACH _table IN ARRAY ARRAY['session_progress', 'training_session_notes', 'homework'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = _table AND column_name = 'dog_id') THEN
      RAISE EXCEPTION '%.dog_id is missing', _table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = _table AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'RLS is off on %', _table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = _table AND permissive = 'RESTRICTIVE') THEN
      RAISE EXCEPTION 'MFA policy is missing on %', _table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_progress_visit_dog_skill_key'
       AND conrelid = 'public.session_progress'::regclass AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'training_session_notes_visit_dog_key'
       AND conrelid = 'public.training_session_notes'::regclass AND contype = 'u')
     OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'homework_visit_dog_key'
       AND conrelid = 'public.homework'::regclass AND contype = 'u') THEN
    RAISE EXCEPTION 'A per-dog unique key is missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_progress_visit_id_skill_id_key') THEN
    RAISE EXCEPTION 'session_progress is still unique per visit and skill, with no dog.';
  END IF;
  IF strpos((SELECT p.prosrc FROM pg_proc p
       WHERE p.oid = 'public.training_progress_row_guard()'::regprocedure), 'Choose a dog at this lesson') = 0 THEN
    RAISE EXCEPTION 'training_progress_row_guard does not check the dog.';
  END IF;
  SELECT array_agg(a ORDER BY o)
    INTO _cols
    FROM pg_proc p,
         unnest(p.proargnames, p.proargmodes::text[]) WITH ORDINALITY AS u(a, m, o)
   WHERE p.oid = 'public.portal_training_lesson_notes(uuid, uuid, uuid[])'::regprocedure
     AND u.m = 't';
  IF _cols IS DISTINCT FROM ARRAY['visit_id', 'dog_id', 'note'] THEN
    RAISE EXCEPTION 'portal_training_lesson_notes returns %, expected {visit_id,dog_id,note}', _cols;
  END IF;
  IF has_function_privilege('anon', 'public.portal_training_lesson_notes(uuid, uuid, uuid[])', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_training_lesson_notes(uuid, uuid, uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_training_lesson_notes is reachable by anon or authenticated';
  END IF;
END $post$;
