-- The #858 ranking migration, proved against a real Postgres. Run by
-- tests/a-ranking-settles-zip-overlaps.test.ts, which passes :migration, the
-- file under proof. Every earlier migration is assumed applied (a local
-- stack built from main).
--
-- One transaction, ROLLED BACK at the end, migration included, so this can be
-- pointed at a shared local stack without leaving anything behind. Each group
-- prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── Two businesses; one with three areas made at different times, one with
--    two, and a typed priority on one of them that the ranking replaces ────
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a8580000-0000-4000-8000-000000000001', 'owner@rank.proof.invalid'),
  ('a8580000-0000-4000-8000-000000000002', 'other@rank.proof.invalid');
INSERT INTO public.organizations (id, name) VALUES
  ('0a858000-0000-4000-8000-000000000001', 'Rank Proof A'),
  ('0a858000-0000-4000-8000-000000000002', 'Rank Proof B');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a8580000-0000-4000-8000-000000000001', '0a858000-0000-4000-8000-000000000001', 'owner'),
  ('a8580000-0000-4000-8000-000000000002', '0a858000-0000-4000-8000-000000000002', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, created_at, priority, zip_codes,
                          geo_match_mode, center_latitude, center_longitude, radius_meters) VALUES
  -- Business A: oldest, middle, newest. The oldest was given priority 9 by
  -- hand in the old drawer; the ranking replaces it.
  ('28580000-0000-4000-8000-00000000000a', '0a858000-0000-4000-8000-000000000001', 'Oldest area',
   now() - interval '30 days', 9, '{48226,48201}', 'radius', 42.33, -83.05, 16093),
  ('28580000-0000-4000-8000-00000000000b', '0a858000-0000-4000-8000-000000000001', 'Middle area',
   now() - interval '10 days', 0, '{48226}', 'radius', 42.34, -83.06, 8000),
  ('28580000-0000-4000-8000-00000000000c', '0a858000-0000-4000-8000-000000000001', 'Newest area',
   now() - interval '1 day', 0, '{48226}', 'radius', 42.35, -83.07, 4000),
  -- Business B: two areas, so its ranking is its own 1..2 and not A's 1..3.
  ('28580000-0000-4000-8000-00000000000d', '0a858000-0000-4000-8000-000000000002', 'B old',
   now() - interval '5 days', 0, '{10001}', 'radius', 40.75, -73.99, 4000),
  ('28580000-0000-4000-8000-00000000000e', '0a858000-0000-4000-8000-000000000002', 'B new',
   now() - interval '2 days', 0, '{10001}', 'radius', 40.76, -73.98, 4000);

-- ── Apply the migration ─────────────────────────────────────────────────────
\i :migration

-- ── 1. Newest first, per business ──────────────────────────────────────────
DO $$
DECLARE _a text; _b text;
BEGIN
  SELECT string_agg(name || '=' || priority, ', ' ORDER BY priority DESC) INTO _a
    FROM public.zones WHERE organization_id = '0a858000-0000-4000-8000-000000000001';
  IF _a <> 'Newest area=3, Middle area=2, Oldest area=1' THEN
    RAISE EXCEPTION 'PROOF FAILED [newest-first]: business A is ranked %', _a;
  END IF;
  SELECT string_agg(name || '=' || priority, ', ' ORDER BY priority DESC) INTO _b
    FROM public.zones WHERE organization_id = '0a858000-0000-4000-8000-000000000002';
  IF _b <> 'B new=2, B old=1' THEN
    RAISE EXCEPTION 'PROOF FAILED [per-business]: business B is ranked %', _b;
  END IF;
  RAISE NOTICE 'ok: each business''s areas are ranked newest first, 1..N of their own';
END $$;

-- ── 2. The typed priority is replaced, so the newest wins the shared ZIP ───
DO $$
DECLARE _winner text;
BEGIN
  -- public_quote's own order (exact ZIP, then priority DESC), on the rows.
  SELECT name INTO _winner FROM public.zones
   WHERE organization_id = '0a858000-0000-4000-8000-000000000001'
     AND '48226' = ANY(zip_codes)
   ORDER BY priority DESC, id LIMIT 1;
  IF _winner <> 'Newest area' THEN
    RAISE EXCEPTION 'PROOF FAILED [winner]: 48226 goes to % rather than the newest area', _winner;
  END IF;
  RAISE NOTICE 'ok: the ZIP all three list goes to the newest area';
END $$;

-- ── 3. A second run changes nothing ────────────────────────────────────────
CREATE TEMP TABLE rank_before AS
  SELECT id, priority FROM public.zones
   WHERE organization_id IN ('0a858000-0000-4000-8000-000000000001',
                             '0a858000-0000-4000-8000-000000000002');
\i :migration
DO $$
DECLARE _changed integer;
BEGIN
  SELECT count(*) INTO _changed
    FROM public.zones z JOIN rank_before b ON b.id = z.id
   WHERE z.priority <> b.priority;
  IF _changed <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [twice]: the second run changed % priorities', _changed;
  END IF;
  RAISE NOTICE 'ok: running the migration twice changes nothing';
END $$;

-- ── 4. The pending column exists and a new area is written without it ──────
DO $$
DECLARE _pending timestamptz;
BEGIN
  INSERT INTO public.zones (id, organization_id, name, priority, zip_codes,
                            geo_match_mode, center_latitude, center_longitude, radius_meters)
  VALUES ('28580000-0000-4000-8000-00000000000f', '0a858000-0000-4000-8000-000000000001',
          'Area after', 0, '{}', 'radius', 42.36, -83.08, 4000);
  SELECT zip_fill_pending_since INTO _pending FROM public.zones
   WHERE id = '28580000-0000-4000-8000-00000000000f';
  IF _pending IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [pending]: a new area starts pending';
  END IF;
  RAISE NOTICE 'ok: zip_fill_pending_since exists and is null for a fresh area';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL RANKING PROOFS PASSED'; END $$;

ROLLBACK;
