-- Every scheduled job POSTed to `https://www.app.houndstack.com`, which
-- 307-redirects to the bare host. The Authorization header does not survive
-- that redirect, so all three arrived unauthenticated and were refused.
--
-- ── HOW IT WAS FOUND, AND WHY IT SURVIVED THE LAST FIX ────────────────────
--
-- 20260804 shipped the email fix: the queue processor read the Supabase URL
-- from `import.meta.env`, which Vite inlines at build, so the deployed bundle
-- held `undefined` and the config guard returned 500 every minute. That guard
-- sits BEFORE the auth check. Fixing it did not make email work — it moved the
-- failure one line down and revealed a second, independent break:
--
--   net._http_response, 3h window, taken minutes after the deploy
--     500 "Server configuration error"  x174   11:59:00 → 14:52:00   (the old bug)
--     401 "Unauthorized"                x  6   14:53:00 → 14:58:00   (this one)
--
-- Proven by three requests rather than inferred:
--
--   POST www.app.houndstack.com/email/queue/process        → 307 to bare host
--   POST app.houndstack.com/... with an Authorization hdr  → 403  (header seen, token wrong)
--   POST www.app.houndstack.com/... following the redirect → 401  (header GONE)
--
-- 403 vs 401 is the whole proof: the route answers 403 when the header is
-- present and wrong, 401 when it is absent. Following the redirect turns the
-- first into the second, so the header is being dropped in transit. Dropping
-- Authorization across a host change is correct behaviour in every HTTP client
-- that does it — the bug is aiming at a host that redirects.
--
-- ── WHY NO CHECK CAUGHT IT ────────────────────────────────────────────────
--
-- `src/lib/app-origin.ts` was written for exactly this class of defect, after
-- twenty-four places wrote an app host by hand and disagreed. It declares
-- `https://app.houndstack.com` canonical and `scripts/check-app-origin.mjs`
-- probes it every run.
--
-- These three call sites are rows in `cron.job`. A TypeScript constant cannot
-- reach them, no test imports them, and the app-origin script checks whether
-- the HOST is reachable — never who is dialling it. The sweep found every hand
-- written host in the repo and none of the ones in the database.
--
-- ── BLAST RADIUS WHILE IT WAS BROKEN ──────────────────────────────────────
--
--   process-email-queue  every minute — every invoice, OTP, portal login code,
--                        reminder, receipt and welcome email undelivered
--   nightly-automation   daily 09:00 — visit generation, missed-visit rollover
--   weekly-digest        Mondays 13:00
--
-- `run-billing-cycles` calls a SQL function directly, makes no HTTP request,
-- and was never affected.

DO $$
DECLARE
  _canonical text := 'https://app.houndstack.com';
  _key_sql   text := '(select decrypted_secret from vault.decrypted_secrets where name = ''cron_service_role_key'')';
  _anon_key  text;
  _jobid     bigint;
BEGIN
  -- The nightly hook also sends an apikey header. Read it back off the existing
  -- job rather than restating the JWT here, so this migration cannot be the
  -- place a stale key gets pinned.
  SELECT substring(command from '''apikey'', ''([^'']+)''')
    INTO _anon_key
    FROM cron.job WHERE jobname = 'nightly-automation';

  SELECT jobid INTO _jobid FROM cron.job WHERE jobname = 'process-email-queue';
  IF _jobid IS NOT NULL THEN
    PERFORM cron.alter_job(_jobid, command := format($f$
  select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || %s
      ),
      body := '{}'::jsonb
  ) as request_id;
  $f$, _canonical || '/email/queue/process', _key_sql));
  END IF;

  SELECT jobid INTO _jobid FROM cron.job WHERE jobname = 'nightly-automation';
  IF _jobid IS NOT NULL AND _anon_key IS NOT NULL THEN
    PERFORM cron.alter_job(_jobid, command := format($f$
  select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'apikey', %L,
        'Authorization', 'Bearer ' || %s
      ),
      body := '{}'::jsonb
  ) as request_id;
  $f$, _canonical || '/api/public/hooks/nightly', _anon_key, _key_sql));
  END IF;

  SELECT jobid INTO _jobid FROM cron.job WHERE jobname = 'weekly-digest';
  IF _jobid IS NOT NULL THEN
    PERFORM cron.alter_job(_jobid, command := format($f$
  select net.http_post(
      url := %L,
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || %s
      ),
      body := '{}'::jsonb
  ) as request_id;
  $f$, _canonical || '/api/public/hooks/weekly-digest', _key_sql));
  END IF;
END $$;

-- Assert rather than hope. A job left on a redirecting host fails silently —
-- the endpoint answers, so nothing looks down — which is how this ran for
-- hours. If any job still names a non-canonical app host, roll the whole file
-- back and say so.
DO $$
DECLARE _bad text;
BEGIN
  SELECT string_agg(jobname, ', ')
    INTO _bad
    FROM cron.job
   WHERE command LIKE '%houndstack.com%'
     AND command NOT LIKE '%//app.houndstack.com%';
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION
      'cron jobs still POST to a non-canonical app host: %. Authorization does not survive a cross-host redirect, so these arrive unauthenticated.', _bad;
  END IF;
END $$;
