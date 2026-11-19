-- The demo-geo backup table is closed to the API (#977).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it. Brendan signs off before it reaches production.
--
-- WHY. Production has a table backup.demo_geo_20260830 (demo geo data from
-- 2026-08-30) with row level security OFF. No migration in this repo creates
-- it: it was made by hand. If the `backup` schema is ever added to the API's
-- exposed schemas, anyone holding the anon key could read it.
--
-- WHAT THIS DOES, to that one table and only if it exists:
--   * ENABLE ROW LEVEL SECURITY, with no policy: a client role reads and
--     writes nothing. The owner and service_role (BYPASSRLS) are unaffected.
--   * REVOKE ALL on the table FROM anon and authenticated.
--   * REVOKE USAGE on schema backup FROM anon and authenticated, if the schema
--     exists, so the schema is closed as well as the table.
--
-- WHAT IT DOES NOT DO. It does not drop the table or touch a row: dropping
-- production data is Brendan's decision. On a database without the table
-- (every fresh replay, CI, a local stack) it does nothing at all, and it can
-- be run any number of times.
--
-- ROLLBACK: supabase/rollback/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.down.sql

DO $closed$
BEGIN
  IF to_regclass('backup.demo_geo_20260830') IS NOT NULL THEN
    ALTER TABLE backup.demo_geo_20260830 ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE backup.demo_geo_20260830 FROM anon, authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'backup') THEN
    REVOKE USAGE ON SCHEMA backup FROM anon, authenticated;
  END IF;

  -- Assertions: whatever the database held, it is closed now.
  IF to_regclass('backup.demo_geo_20260830') IS NOT NULL THEN
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'backup.demo_geo_20260830'::regclass) THEN
      RAISE EXCEPTION 'backup.demo_geo_20260830 still has row level security off';
    END IF;
    IF has_table_privilege('anon', 'backup.demo_geo_20260830', 'SELECT')
       OR has_table_privilege('authenticated', 'backup.demo_geo_20260830', 'SELECT') THEN
      RAISE EXCEPTION 'a client role can still read backup.demo_geo_20260830';
    END IF;
  END IF;
END
$closed$;
