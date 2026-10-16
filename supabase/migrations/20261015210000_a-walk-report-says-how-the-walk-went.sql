-- A walk report says how the walk went (#410, part 2).
--
-- 1. How the walker gets in. A dog walker goes inside, so the office records
--    the way in (key, lock box, door code, garage code, someone home) and
--    whether the business holds a physical key, with the office's tag on it.
--    gate_code and access_notes stay ordinary columns. Who may read
--    lock_box_code, key_location and key_tag is tightened by the next
--    migration: plain SELECT is revoked, and property_access_codes returns them.
--
-- 2. What the client is told. pee and poo are yes/no, NULL until the walker
--    records them. report_note is written FOR THE CLIENT and goes in the walk
--    report email; tech_note stays the office's note.
--
-- 3. record_walk_report writes those three fields. It does not complete the
--    visit: the app calls it before complete_visit, and complete_visit and
--    start_visit are not touched here.
--
-- Replays into an empty database: six columns, their checks, one function and
-- its grants. The final block asserts only what this file establishes.

ALTER TABLE public.properties
  ADD COLUMN IF NOT EXISTS access_method text,
  ADD COLUMN IF NOT EXISTS key_held boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS key_tag text;

ALTER TABLE public.properties DROP CONSTRAINT IF EXISTS properties_access_method_check;
ALTER TABLE public.properties ADD CONSTRAINT properties_access_method_check
  CHECK (access_method IS NULL
    OR access_method IN ('key', 'lockbox', 'code', 'garage', 'person_home'));
ALTER TABLE public.properties DROP CONSTRAINT IF EXISTS properties_key_tag_length;
ALTER TABLE public.properties ADD CONSTRAINT properties_key_tag_length
  CHECK (key_tag IS NULL OR char_length(key_tag) <= 40);

COMMENT ON COLUMN public.properties.access_method IS
  'How the walker gets in: key, lockbox, code (door code), garage (garage code) or person_home. NULL when not recorded.';
COMMENT ON COLUMN public.properties.key_held IS
  'The business holds a physical key to this property.';
COMMENT ON COLUMN public.properties.key_tag IS
  'The office''s tag on the key it holds, up to 40 characters. Same readers as lock_box_code: property_access_codes, not a plain SELECT.';

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS pee boolean,
  ADD COLUMN IF NOT EXISTS poo boolean,
  ADD COLUMN IF NOT EXISTS report_note text;

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_report_note_length;
ALTER TABLE public.visits ADD CONSTRAINT visits_report_note_length
  CHECK (report_note IS NULL OR char_length(report_note) <= 500);

COMMENT ON COLUMN public.visits.pee IS
  'Walk report: the dog peed. NULL when the walker did not say.';
COMMENT ON COLUMN public.visits.poo IS
  'Walk report: the dog pooped. NULL when the walker did not say.';
COMMENT ON COLUMN public.visits.report_note IS
  'Walk report note for the client, up to 500 characters. tech_note is the note for the office.';

CREATE OR REPLACE FUNCTION public.record_walk_report(
  _visit_id uuid,
  _pee boolean,
  _poo boolean,
  _report_note text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _note text;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  IF NOT (public.is_visit_tech(auth.uid(), _visit_id)
          OR public.can_write_org(auth.uid(), _org)) THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _status NOT IN ('scheduled', 'in_progress', 'completed') THEN
    RAISE EXCEPTION 'This walk was not done, so it has no report.' USING ERRCODE = 'check_violation';
  END IF;

  _note := NULLIF(btrim(COALESCE(_report_note, '')), '');
  IF _note IS NOT NULL AND char_length(_note) > 500 THEN
    RAISE EXCEPTION 'The note for the client can be up to 500 characters.' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.visits
     SET pee = _pee, poo = _poo, report_note = _note, updated_at = now()
   WHERE id = _visit_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_walk_report(uuid, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_walk_report(uuid, boolean, boolean, text)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.record_walk_report(uuid, boolean, boolean, text) IS
  'Records pee, poo and the note for the client on a walk. The assigned walker or the office; scheduled, in-progress or completed visits only.';

-- What this file establishes.
DO $check$
DECLARE
  _missing text;
BEGIN
  SELECT string_agg(expected.tbl || '.' || expected.col, ', ') INTO _missing
    FROM (VALUES
      ('properties', 'access_method'), ('properties', 'key_held'), ('properties', 'key_tag'),
      ('visits', 'pee'), ('visits', 'poo'), ('visits', 'report_note')
    ) AS expected(tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = expected.tbl
        AND c.column_name = expected.col);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'Walk report columns are missing: %', _missing;
  END IF;

  SELECT string_agg(expected.name, ', ') INTO _missing
    FROM (VALUES
      ('public.properties', 'properties_access_method_check'),
      ('public.properties', 'properties_key_tag_length'),
      ('public.visits', 'visits_report_note_length')
    ) AS expected(rel, name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conrelid = expected.rel::regclass AND conname = expected.name);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'Walk report constraints are missing: %', _missing;
  END IF;

  IF to_regprocedure('public.record_walk_report(uuid, boolean, boolean, text)') IS NULL THEN
    RAISE EXCEPTION 'record_walk_report is missing';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc
           WHERE oid = 'public.record_walk_report(uuid, boolean, boolean, text)'::regprocedure) THEN
    RAISE EXCEPTION 'record_walk_report must be SECURITY DEFINER';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.record_walk_report(uuid, boolean, boolean, text)'::regprocedure)
     !~ 'is_visit_tech' THEN
    RAISE EXCEPTION 'record_walk_report does not check the assigned walker';
  END IF;
  IF has_function_privilege('anon', 'public.record_walk_report(uuid, boolean, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute record_walk_report';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_walk_report(uuid, boolean, boolean, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute record_walk_report';
  END IF;
END
$check$;
