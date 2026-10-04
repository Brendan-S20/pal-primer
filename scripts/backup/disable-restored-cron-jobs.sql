-- Run by scripts/backup/restore.sh as the LAST file of the restore, inside the
-- same transaction as the data. Every pg_cron job a backup brings back is
-- switched off before anything commits, so not one of them ever fires from
-- the restored database. restore.sh says why at length; the short version is
-- that each of these jobs talks to production or to customers.
--
-- Guarded rather than assumed: a backup of a project that never scheduled a
-- job has no cron schema to update.
--
-- Through cron.alter_job, not UPDATE cron.job: on Supabase the `postgres`
-- role may read cron.job and alter its own jobs through pg_cron's functions,
-- but has no UPDATE on the table. Found by restoring into a local Supabase
-- stack, where the UPDATE was refused with "permission denied for table job".
DO $$
DECLARE
  j record;
  n integer := 0;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  FOR j IN SELECT jobid FROM cron.job WHERE active LOOP
    PERFORM cron.alter_job(j.jobid, active := false);
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'switched off % restored cron job(s); re-enable deliberately at cutover', n;
END
$$;
