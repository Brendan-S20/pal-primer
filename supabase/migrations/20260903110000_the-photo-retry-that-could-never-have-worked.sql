-- The retry path for a half-uploaded photo was refused by the database, five
-- times, and then deleted the tech's only copy.
--
-- ── THE DESIGN, WHICH IS RIGHT ────────────────────────────────────────────
--
-- src/lib/offline/sync.ts uploads a queued photo to a path keyed on the
-- ACTION, not the clock, and says why at length:
--
--   "`Date.now()` made every attempt at the same photo a different object. The
--    upload is not the last step -- `recordVisitPhoto` follows it -- so any
--    failure after the bytes land (a refused insert, a dropped connection, a
--    deadline) leaves that object in storage and retries to a FRESH path.
--    Nothing references the first, nothing ever collects it, and the org is
--    billed for it. ... Keyed on the action, the retry rewrites the SAME object
--    -- which is also why upsert has to be true. With `upsert: false` a retry
--    after a successful upload fails on 'already exists', turning a
--    recoverable record-step failure into a permanent one."
--
-- Correct in every particular. The database never agreed to it.
--
-- ── WHAT THE DATABASE ACTUALLY GRANTED ────────────────────────────────────
--
-- `storage.objects` had exactly three policies for `visit-photos`: SELECT,
-- INSERT and DELETE. No UPDATE. Supabase implements `upsert: true` as an
-- INSERT that falls back to an UPDATE on conflict, so overwriting an existing
-- object needs SELECT *and* UPDATE. Without the latter the overwrite is refused
-- by RLS, and here is what that costs:
--
--   1. Photo uploads to {org}/{visit}/{uploadKey}.jpg. The object exists.
--   2. recordVisitPhoto fails, or the 45s deadline fires after the bytes
--      landed. That is a transport failure, so the action is queued.
--   3. Replay: upload with upsert onto an object that now exists -> RLS
--      refuses -> a 403, which is NOT a transport failure and NOT offline, so
--      the attempt counts.
--   4. Attempts 2 through 5 fail identically.
--   5. At MAX_ATTEMPTS the action is dead-lettered and sync.ts deletes the
--      local blob -- the only copy of a photograph a technician took, of a
--      customer's yard, which nobody can retake.
--
-- The plain offline case works, because that first upload is a genuine INSERT.
-- It is the half-landed ONLINE upload -- precisely the case `uploadKey` was
-- invented for -- that the missing grant breaks.
--
-- The predicate is the INSERT policy's, unchanged in meaning, so a technician
-- can overwrite exactly the objects they could have created and no others. A
-- looser UPDATE policy here would be a worse bug than the one it fixes.
--
-- Written with `(select auth.uid())` rather than the bare call its sibling
-- uses. 20260809200000 established that form across `public` so Postgres
-- evaluates the auth call once as an InitPlan instead of once per row, and
-- exempted the storage policies only because rewriting them was out of that
-- migration's scope. A NEW policy has no such excuse, and
-- tests/every-row-was-asked-again-who-was-asking.test.ts counts the
-- exemptions, so adding one would have quietly widened a list somebody
-- deliberately made finite.
CREATE POLICY "assigned tech overwrites visit photo files"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'visit-photos'
    AND public.is_org_member((select auth.uid()), ((storage.foldername(name))[1])::uuid)
    AND public.is_visit_tech((select auth.uid()), ((storage.foldername(name))[2])::uuid)
  )
  WITH CHECK (
    bucket_id = 'visit-photos'
    AND public.is_org_member((select auth.uid()), ((storage.foldername(name))[1])::uuid)
    AND public.is_visit_tech((select auth.uid()), ((storage.foldername(name))[2])::uuid)
  );

-- ── And the second half: make the record step idempotent too ──────────────
--
-- `recordVisitPhoto` is a bare INSERT into `visit_photos`, and the table has
-- no uniqueness beyond its primary key. So the OTHER half-failure -- both steps
-- completed but the response was lost -- replays into a duplicate row, and the
-- customer's visit shows the same photograph twice.
--
-- One unique index closes it, and closes the residual of the case above with
-- it: with the overwrite permitted AND the insert idempotent, replaying a
-- photo action is safe however far it got the first time, which is what
-- "recoverable" was supposed to mean.
--
-- Duplicates are collapsed first, oldest kept, because the index cannot be
-- created over them. On a fresh replay there are no rows and this deletes
-- nothing.
DELETE FROM public.visit_photos vp
 WHERE EXISTS (
   SELECT 1 FROM public.visit_photos keep
    WHERE keep.visit_id = vp.visit_id
      AND keep.storage_path = vp.storage_path
      AND (keep.created_at < vp.created_at
           OR (keep.created_at = vp.created_at AND keep.id < vp.id))
 );

CREATE UNIQUE INDEX IF NOT EXISTS visit_photos_visit_path_uniq
  ON public.visit_photos (visit_id, storage_path);

DO $est$
DECLARE _n int;
BEGIN
  -- The overwrite the client has been attempting since the day uploadKey was
  -- written is now permitted.
  SELECT count(*) INTO _n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd = 'UPDATE'
     AND with_check LIKE '%visit-photos%';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one UPDATE policy on visit-photos, found %', _n;
  END IF;

  -- And a replayed record step cannot duplicate a row.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'visit_photos'
       AND indexname = 'visit_photos_visit_path_uniq'
  ) THEN
    RAISE EXCEPTION 'visit_photos is still not unique on (visit_id, storage_path)';
  END IF;
END $est$;

DO $observed$
DECLARE _rows int; _dangling int;
BEGIN
  SELECT count(*) INTO _rows FROM public.visit_photos;
  IF _rows = 0 THEN
    RAISE WARNING 'no visit photos on this build, so nothing was measured about them';
    RETURN;
  END IF;
  -- A measurement of a database, not of this change: how many photo rows point
  -- at an object that is not there. It prints because somebody should read it
  -- -- see the note in the pull request about the seeded demo/*.jpg rows.
  SELECT count(*) INTO _dangling
    FROM public.visit_photos vp
   WHERE NOT EXISTS (
     SELECT 1 FROM storage.objects o
      WHERE o.bucket_id = 'visit-photos' AND o.name = vp.storage_path
   );
  RAISE WARNING 'visit_photos rows pointing at no stored object: % of %', _dangling, _rows;
END $observed$;
