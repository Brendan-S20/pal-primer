-- Run by scripts/backup/restore.sh as the LAST file of the restore, inside the
-- same transaction as the data. Every pg_cron job a backup brings back is
-- switched off before anything commits, so not one of them ever fires from
-- the restored database. restore.sh says why at length; the short version is
-- that each of these jobs talks to production or to customers.
--
-- Guarded rather than assumed: a backup of a project that never scheduled a
-- job has no cron schema to update.
DO $$
DECLARE
  n integer;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  UPDATE cron.job SET active = false WHERE active;
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'switched off % restored cron job(s); re-enable deliberately at cutover', n;
END
$$;
