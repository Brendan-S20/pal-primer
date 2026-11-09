-- Google-derived data is refreshed or dropped after 30 days (#529 / #745).
--
-- Decision (Brendan, 2026-11-09). Once a day pg_cron calls
-- /api/public/hooks/google-cache-expiry, which (src/lib/google-cache-expiry.server.ts):
--
--   * deletes road_legs rows with source 'google' (Routes API drive times)
--     fetched more than 30 days ago. Every other source keeps its existing
--     rule: prune_road_legs, 90 days, weekly (20260826200000). Unchanged here.
--   * re-geocodes properties whose geocode_source is 'google' or
--     'google_places' and whose geocoded_at is more than 30 days old, and
--     clears the point if that fails. Any other source, and an unknown
--     (NULL) one, is never touched. The columns are 20261109200000.
--
-- The work is in the app, not in SQL, because refreshing a pin means calling
-- a geocoder. The road_legs purge sits beside it so the one rule lives in one
-- place (src/lib/geocode-source.ts) with one set of tests.
--
-- 07:23 UTC: after the nightly automation, before a US working day starts, and
-- off the hour. Same credential as late-check and texting-status: Bearer
-- service-role from Vault.

DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('google-cache-expiry')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-cache-expiry');
    PERFORM cron.schedule('google-cache-expiry', '23 7 * * *', $job$
  SELECT net.http_post(
      url := 'https://app.houndstack.com/api/public/hooks/google-cache-expiry',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || s.decrypted_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
  ) AS request_id
    FROM vault.decrypted_secrets s
   WHERE s.name = 'cron_service_role_key';
  $job$);
  ELSE
    RAISE WARNING 'pg_cron is not installed, so google-cache-expiry was NOT scheduled; Google-derived pins and drive times will not expire after 30 days';
  END IF;
END
$sched$;

-- WARNING, not EXCEPTION: a fresh build may have no pg_cron, and a replay must
-- not fail for operations state (CLAUDE.md, "Every migration replays").
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'google-cache-expiry' AND active) THEN
    RAISE WARNING 'google-cache-expiry is not scheduled or not active; Google-derived data will not expire after 30 days';
  END IF;
END
$cron$;
