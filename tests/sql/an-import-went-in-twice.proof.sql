-- Claiming one preview twice and claiming two previews of the same file.
-- The transaction, including the migration and invented fixtures, rolls back.
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;
\i :migration
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('e4340000-0000-4000-8000-000000000001', 'owner@import.proof.invalid');
INSERT INTO public.organizations (id, name) VALUES
  ('e4340000-0000-4000-8000-000000000002', 'Import Proof A'),
  ('e4340000-0000-4000-8000-000000000003', 'Import Proof B');
INSERT INTO public.import_batches (id, organization_id, created_by, source, status, content_hash) VALUES
  ('e4340000-0000-4000-8000-000000000011', 'e4340000-0000-4000-8000-000000000002', 'e4340000-0000-4000-8000-000000000001', 'jobber', 'previewing', 'sample-hash'),
  ('e4340000-0000-4000-8000-000000000012', 'e4340000-0000-4000-8000-000000000002', 'e4340000-0000-4000-8000-000000000001', 'jobber', 'previewing', 'sample-hash'),
  ('e4340000-0000-4000-8000-000000000013', 'e4340000-0000-4000-8000-000000000003', 'e4340000-0000-4000-8000-000000000001', 'jobber', 'previewing', 'sample-hash');
DO $proof$
DECLARE n integer;
BEGIN
  UPDATE public.import_batches SET commit_started_at = now()
    WHERE id = 'e4340000-0000-4000-8000-000000000011'
      AND status = 'previewing' AND commit_started_at IS NULL AND superseded_by IS NULL
      AND created_at >= now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED: first claim'; END IF;
  UPDATE public.import_batches SET commit_started_at = now()
    WHERE id = 'e4340000-0000-4000-8000-000000000011'
      AND status = 'previewing' AND commit_started_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED: second claim'; END IF;
  RAISE NOTICE 'ok: one preview can be claimed once';
  BEGIN
    UPDATE public.import_batches SET commit_started_at = now()
      WHERE id = 'e4340000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'PROOF FAILED: sibling claim accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  UPDATE public.import_batches SET status = 'failed'
    WHERE id = 'e4340000-0000-4000-8000-000000000011';
  BEGIN
    UPDATE public.import_batches SET commit_started_at = now()
      WHERE id = 'e4340000-0000-4000-8000-000000000012';
    RAISE EXCEPTION 'PROOF FAILED: failed partial commit lost reservation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: same file cannot be claimed twice, including after partial failure';
  UPDATE public.import_batches SET commit_started_at = now()
    WHERE id = 'e4340000-0000-4000-8000-000000000013';
  RAISE NOTICE 'ok: file reservations are scoped to the organization';
  UPDATE public.import_batches SET created_at = now() - interval '25 hours'
    WHERE id = 'e4340000-0000-4000-8000-000000000012';
  UPDATE public.import_batches SET commit_started_at = now()
    WHERE id = 'e4340000-0000-4000-8000-000000000012'
      AND status = 'previewing' AND commit_started_at IS NULL AND superseded_by IS NULL
      AND created_at >= now() - interval '24 hours';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED: stale claim'; END IF;
  UPDATE public.import_batches SET created_at = now(), status = 'cancelled',
    superseded_by = 'e4340000-0000-4000-8000-000000000011'
    WHERE id = 'e4340000-0000-4000-8000-000000000012';
  UPDATE public.import_batches SET commit_started_at = now()
    WHERE id = 'e4340000-0000-4000-8000-000000000012'
      AND status = 'previewing' AND commit_started_at IS NULL AND superseded_by IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED: superseded claim'; END IF;
  RAISE NOTICE 'ok: stale and superseded previews cannot be claimed';
END
$proof$;
ROLLBACK;
