-- The demo seeded 42 photo rows and 0 photos.
--
-- `seed_demo_org` inserts a before/after pair for every fifth completed visit:
--
--     SELECT _org_id, t.id, 'demo/' || k.kind || '-' || (t.rn % 3 + 1) || '.jpg', ...
--     CROSS JOIN (VALUES ('before'), ('after')) AS k(kind)
--
-- Nothing in this repository ever writes those files. Measured before this
-- change: 42 rows across the three demo organizations, and all 42 point at a
-- storage object that does not exist. The only visit_photos row in the whole
-- database that resolves is the one real photo somebody uploaded through the
-- app.
--
-- The path could not have worked even if the files were there. The bucket's
-- policies read `(storage.foldername(name))[1]` as an organization id and
-- `[2]` as a visit id, which is why a real upload lands at
-- `<org_uuid>/<visit_uuid>/<epoch>.jpg`. `demo/before-1.jpg` puts the literal
-- 'demo' where the org uuid goes, so the ::uuid cast in every policy on that
-- bucket fails on it. These rows were never readable by anyone.
--
-- What a person sees, then, is a broken image in the office visit drawer and
-- another in the customer portal. A demo with no photos is a demo missing a
-- feature; a demo with broken photos is a demo of a broken product.
--
-- SQL cannot create a storage object, so the seeder cannot be fixed to write
-- real ones -- putting placeholder files in the bucket under the real path
-- shape needs a script or an upload, and is deliberately not attempted here.
-- The seeder stops inventing rows instead.
--
-- No DELETE. `seed_demo_org` already wipes `visit_photos` for the org before
-- it reseeds, so with the INSERT gone the existing rows clear themselves the
-- next time anyone presses the button, and nothing here has to destroy rows
-- on a live database to get there.
--
-- ── AND THE KIND WAS A FOURTH WORD ─────────────────────────────────────────
--
-- The seeder writes 'after'. The app writes `z.enum(["completion", "before",
-- "issue"])`, and `portal-ui.tsx` captions exactly those three -- an unknown
-- kind gets `null`, deliberately, rather than a guessed caption. So 21 of the
-- 43 rows carry a word the product cannot produce and cannot label, and
-- `visit_photos.kind` is plain `text` with no constraint, which is what let a
-- fourth vocabulary exist for two months without anything noticing.
--
-- 'after' means 'completion' here: the portal already prints "After" for
-- `completion`, because "After" is what a customer calls the photo taken when
-- the work is done. So this normalizes rather than deletes, and then
-- constrains the column so the next fourth word fails at the INSERT.

-- ── one vocabulary ──────────────────────────────────────────────────────────
UPDATE public.visit_photos SET kind = 'completion' WHERE kind = 'after';

ALTER TABLE public.visit_photos
  DROP CONSTRAINT IF EXISTS visit_photos_kind_is_one_the_app_writes;
ALTER TABLE public.visit_photos
  ADD CONSTRAINT visit_photos_kind_is_one_the_app_writes
  CHECK (kind IN ('completion', 'before', 'issue')) NOT VALID;
-- NOT VALID then VALIDATE: ADD CONSTRAINT holds ACCESS EXCLUSIVE for the whole
-- scan, VALIDATE takes a weaker lock. The scan is over 43 rows here and 0 on a
-- fresh build, so both are instant either way -- but the validation is what
-- makes the constraint mean anything afterwards, so it is not skipped.
ALTER TABLE public.visit_photos VALIDATE CONSTRAINT visit_photos_kind_is_one_the_app_writes;

-- ── stop the seeder inventing rows ──────────────────────────────────────────
-- Spliced, because seed_demo_org is several hundred lines and the change is to
-- remove one statement from the middle of it. pg_get_functiondef is given a
-- named ::regprocedure, never a set.
DO $splice$
DECLARE
  _def text;
  _out text;
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);

  IF strpos(_def, 'INSERT INTO public.visit_photos') = 0 THEN
    RAISE NOTICE 'seed_demo_org already seeds no photo rows; leaving it alone.';
    RETURN;
  END IF;

  -- From the PHOTOS banner through the end of the INSERT. Non-greedy, so it
  -- stops at the first terminator rather than eating the invoice loop that
  -- follows.
  _out := regexp_replace(
    _def,
    '\s*--[^\n]*PHOTOS[^\n]*\n.*?INSERT INTO public\.visit_photos.*?WHERE t\.rn % 5 = 1;',
    E'\n\n  -- PHOTOS: deliberately none. A row here needs a file in the\n'
    '  -- visit-photos bucket and SQL cannot put one there, so every row this\n'
    '  -- used to insert was a broken image in the office drawer and in the\n'
    '  -- customer portal. See 20260903170000.',
    '');

  IF strpos(_out, 'INSERT INTO public.visit_photos') > 0 THEN
    RAISE EXCEPTION
      'the photo INSERT is still in seed_demo_org after the substitution; the block moved and this migration needs re-cutting against the current body';
  END IF;

  -- The WIPE has to survive. It is the line that makes the removal
  -- self-healing: with no INSERT, the next reseed clears the org's dangling
  -- rows and puts nothing back. Deleting it by accident would strand them.
  IF strpos(_out, 'DELETE FROM public.visit_photos') = 0 THEN
    RAISE EXCEPTION 'the splice removed the visit_photos wipe as well as the insert';
  END IF;

  EXECUTE _out;
END
$splice$;

-- ── what this migration establishes ─────────────────────────────────────────
DO $verify$
DECLARE _src text; _bad integer; _dangling integer; _rows integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.visit_photos'::regclass
       AND conname = 'visit_photos_kind_is_one_the_app_writes'
       AND convalidated
  ) THEN
    RAISE EXCEPTION 'the kind constraint is missing or was left NOT VALID';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'seed_demo_org';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'seed_demo_org is missing';
  END IF;
  IF _src LIKE '%INSERT INTO public.visit_photos%' THEN
    RAISE EXCEPTION 'seed_demo_org still seeds photo rows';
  END IF;
  IF _src NOT LIKE '%DELETE FROM public.visit_photos%' THEN
    RAISE EXCEPTION 'seed_demo_org no longer wipes photos, so the dangling rows would never clear';
  END IF;

  -- Both MEASUREMENTS, not assertions: they count rows this file did not
  -- create. A fresh build has none and must not fail for it.
  SELECT count(*) INTO _bad FROM public.visit_photos WHERE kind = 'after';
  IF _bad > 0 THEN
    RAISE WARNING '% row(s) still carry kind=after, which should be impossible now', _bad;
  END IF;

  SELECT count(*), count(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM storage.objects o
              WHERE o.bucket_id = 'visit-photos' AND o.name = vp.storage_path))
    INTO _rows, _dangling
    FROM public.visit_photos vp;

  IF _rows = 0 THEN
    RAISE NOTICE 'no visit_photos rows to check (fresh build).';
  ELSIF _dangling = 0 THEN
    RAISE NOTICE 'all % visit_photos row(s) point at a stored object.', _rows;
  ELSE
    RAISE WARNING
      '% of % visit_photos row(s) still point at no stored object. The seeder no longer creates these; they clear on the next reseed of their organization.',
      _dangling, _rows;
  END IF;
END
$verify$;
