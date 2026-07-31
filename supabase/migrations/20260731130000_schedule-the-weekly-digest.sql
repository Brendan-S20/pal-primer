-- BUILD-8 / IMP-2: actually schedule the weekly digest.
--
-- The Analytics page has promised this in plain words since it shipped —
-- "Every Monday morning, we email a plain-language summary of the past week" —
-- and it has never once run. Two independent reasons, both invisible:
--
--   1. NOTHING SCHEDULED IT. pg_cron had jobs for the nightly automation and
--      the email queue; the digest endpoint existed, was reachable, was
--      correct, and no caller ever existed. This migration is that caller.
--
--   2. NO ORGANIZATION HAS A RECIPIENT. `digest_recipient_email` is null for
--      every org, and the endpoint filters those out — correctly, since it has
--      nowhere to send. `notify_email_weekly_digest` defaults to TRUE, so the
--      seven orgs that look opted-in are simply orgs that have never touched
--      the setting.
--
-- Fixing only the first would produce a job that runs every Monday forever and
-- delivers nothing — the same shape of failure, now with a cron entry to make
-- it look handled. So the settings panel is changed alongside this to say
-- plainly when a digest cannot send, rather than showing "Enabled" beside a
-- promise it cannot keep.
--
-- WHAT IS DELIBERATELY NOT DONE HERE: no fallback recipient. Defaulting to the
-- owner's login address would start emailing seven real people a weekly AI
-- summary they never asked for, on the strength of a checkbox that was on by
-- default. The recipient is the org's decision to make; this migration makes
-- the machinery exist so that decision has an effect.
--
-- Consequently this is safe to apply right now: with no recipients set, the
-- first run sends nothing at all. It becomes live per-organization the moment
-- someone fills the field in — which is exactly the semantics that were
-- intended.
--
-- ── SCHEDULE ───────────────────────────────────────────────────────────────
--
-- Monday 13:00 UTC — 8am CDT / 7am CST. Every organization in the database is
-- America/Chicago, and the copy says "Monday morning", so the schedule matches
-- the promise rather than the server's convenience.
--
-- WEEKLY rather than daily-with-a-guard. The endpoint skips an org whose digest
-- went out within the past 6 days, which makes a more frequent cadence *safe*
-- but not *correct*: at a 6-day guard and a daily run, each org's digest would
-- creep a day earlier every week until it wandered off Monday entirely. A fixed
-- weekly slot keeps the promise; the guard stays as the double-send safety net
-- it was written to be.
--
-- ── AUTH ───────────────────────────────────────────────────────────────────
--
-- Bearer service-role from Vault, the same private credential the nightly job
-- uses. Deliberately NO `apikey` header: the anon key is no longer accepted
-- (BUG-28) and including it would imply it still counts for something.
--
-- Idempotent: unschedules an existing job of the same name first, so replaying
-- this never leaves two jobs racing to send the same week's digest twice.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'weekly-digest') THEN
    PERFORM cron.unschedule('weekly-digest');
  END IF;
END $$;

SELECT cron.schedule(
  'weekly-digest',
  '0 13 * * 1',
  $job$
  select net.http_post(
      url := 'https://www.app.houndstack.com/api/public/hooks/weekly-digest',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_service_role_key')
      ),
      body := '{}'::jsonb
  ) as request_id;
  $job$
);
