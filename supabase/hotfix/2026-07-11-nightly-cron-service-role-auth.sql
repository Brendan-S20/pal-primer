-- Applied live 2026-07-11. Autopay never armed: the nightly hook only
-- authorizes charging under a private credential, but the pg_cron job sent
-- only the public anon key. Re-schedule the job (same name = in-place update)
-- to also send the service role key as a Bearer token from Vault — the same
-- pattern the process-email-queue job already uses. The hook accepts it as a
-- charge-authorized credential as of the matching app change.
select cron.schedule(
  'nightly-automation',
  '0 9 * * *',
  $CMD$
  select net.http_post(
      url := 'https://www.app.houndstack.com/api/public/hooks/nightly',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'apikey', '<project anon key>',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_service_role_key')
      ),
      body := '{}'::jsonb
  ) as request_id;
  $CMD$
);
