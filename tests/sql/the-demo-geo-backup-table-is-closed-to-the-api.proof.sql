-- Proof for 20261118020000: the demo-geo backup table is closed to the API (#977).
-- Applies the migration itself (\ir) so CI's database job and the vitest
-- wrapper run the same file. One transaction, ROLLED BACK. Prints
-- "ok: ..." or raises "PROOF FAILED".
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;

-- 1. A database WITHOUT the table: the migration does nothing and does not fail.
DO $p$
BEGIN
  IF to_regclass('backup.demo_geo_20260830') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the table exists on a database that should not have it';
  END IF;
END $p$;
\ir ../../supabase/migrations/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.sql
DO $p$
BEGIN
  IF to_regclass('backup.demo_geo_20260830') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [empty]: the migration created the table';
  END IF;
  RAISE NOTICE 'ok: on a database without the table the migration is a no-op';
END $p$;

-- 2. The table as production has it: RLS off, readable by the API roles.
CREATE SCHEMA IF NOT EXISTS backup;
GRANT USAGE ON SCHEMA backup TO anon, authenticated;
CREATE TABLE backup.demo_geo_20260830 (id int PRIMARY KEY, lat double precision, lng double precision);
GRANT SELECT ON backup.demo_geo_20260830 TO anon, authenticated;
INSERT INTO backup.demo_geo_20260830 VALUES (1, 42.33, -83.04);
DO $p$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'backup.demo_geo_20260830'::regclass)
     OR NOT has_table_privilege('anon', 'backup.demo_geo_20260830', 'SELECT') THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the fixture is not the open table production has';
  END IF;
  RAISE NOTICE 'ok: before: RLS off and anon can read it';
END $p$;

-- 3. Run it, then run it again (idempotent).
\ir ../../supabase/migrations/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.sql
\ir ../../supabase/migrations/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.sql
DO $p$
DECLARE _n int;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'backup.demo_geo_20260830'::regclass) THEN
    RAISE EXCEPTION 'PROOF FAILED [rls]: row level security is still off';
  END IF;
  IF has_table_privilege('anon', 'backup.demo_geo_20260830', 'SELECT')
     OR has_table_privilege('authenticated', 'backup.demo_geo_20260830', 'SELECT')
     OR has_schema_privilege('anon', 'backup', 'USAGE')
     OR has_schema_privilege('authenticated', 'backup', 'USAGE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: a client role still reaches the table or schema';
  END IF;
  RAISE NOTICE 'ok: RLS on, no grant to anon or authenticated, schema closed, twice over';
END $p$;

-- 4. Nothing was dropped or changed: the row is still there for the owner.
DO $p$
BEGIN
  IF (SELECT count(*) FROM backup.demo_geo_20260830) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [data]: the table lost its row';
  END IF;
  RAISE NOTICE 'ok: the table and its row are untouched';
END $p$;

-- 5. A client role is refused (permission denied), not served an empty list.
SET LOCAL ROLE anon;
DO $p$
DECLARE _state text;
BEGIN
  BEGIN PERFORM 1 FROM backup.demo_geo_20260830;
  EXCEPTION WHEN OTHERS THEN _state := SQLSTATE; END;
  IF _state IS DISTINCT FROM '42501' THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon got % (want 42501)', _state;
  END IF;
  RAISE NOTICE 'ok: anon is refused with permission denied';
END $p$;
RESET ROLE;

-- 6. Mutation: with RLS off (the rollback), the first check would fail.
SAVEPOINT before_mutation;
\ir ../../supabase/rollback/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.down.sql
DO $p$
BEGIN
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'backup.demo_geo_20260830'::regclass) THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [mutation]: the rollback did not turn RLS off';
  END IF;
  RAISE NOTICE 'ok: mutation reproduces: the rollback reopens the table';
END $p$;
ROLLBACK TO SAVEPOINT before_mutation;

ROLLBACK;
