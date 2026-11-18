-- ROLLBACK for 20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.sql (#977).
--
-- WHAT THIS UNDOES: turns row level security back OFF on
-- backup.demo_geo_20260830 (if it exists). That reopens the table to
-- whichever client roles still hold a grant on it.
--
-- WHAT THIS DOES **NOT** UNDO: the REVOKEs. The grants the table and schema
-- had to anon and authenticated were not recorded by the migration and are
-- NOT restored; nothing in this repo says they were ever meant. Restore them
-- by hand only if something proves it relied on them.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261118020000_the-demo-geo-backup-table-is-closed-to-the-api.down.sql

DO $undo$
BEGIN
  IF to_regclass('backup.demo_geo_20260830') IS NOT NULL THEN
    ALTER TABLE backup.demo_geo_20260830 DISABLE ROW LEVEL SECURITY;
  END IF;
END
$undo$;
