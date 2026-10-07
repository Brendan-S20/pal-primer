-- A truck that never moved.
--
-- The office hears a stop will be late on two triggers (20261004150000): a GPS
-- ping while the tech shares their location, and the tech finishing the stop
-- before it. A tech stuck at one long stop with sharing off produces neither,
-- so the next customer's window passes and nobody is told until the customer
-- calls. This schedules the third trigger, a clock: every five minutes pg_cron
-- POSTs to /api/public/hooks/late-check, which asks the same question of each
-- tech's next stop and tells the office under the same event key
-- (`late:<visitId>:<step>`), so a slip is heard once whichever trigger sees it
-- first. The rules are checkStuckTrucks in src/lib/field-notify.server.ts.
--
-- ── WHEN IT RUNS ──────────────────────────────────────────────────────────
--
-- `*/5 * * * *`, all day. Working hours are NOT in the cron expression: every
-- organization has its own timezone and its own workday_start and
-- workday_end, so the hook decides per organization on its own clock. What
-- keeps the other nineteen hours free is the gate: the job's command asks
-- public.late_check_due() before it makes the request, and that is one
-- indexed EXISTS over open, assigned stops whose window closes between two
-- hours ago and three hours from now. Overnight, and on a day with nothing
-- routed, it is false and no HTTP request is made at all, the same shape as
-- deliver-webhooks (20260929080000). The two bounds are LATE_GIVE_UP_MIN and
-- LATE_LOOKAHEAD_MIN in src/lib/field-notify.ts, and the hook reads the same
-- band; tests/a-truck-that-never-moved.test.ts pins the two copies together.
--
-- ── AUTH ──────────────────────────────────────────────────────────────────
--
-- Bearer service-role from Vault (`cron_service_role_key`), the credential
-- every migration-scheduled job uses, checked by authorizeCronRequest. The
-- canonical host, because Authorization does not survive the redirect from
-- www (20260804160000). A database with no such secret (every local stack,
-- every fresh build) selects no row from vault.decrypted_secrets, so the job
-- runs and makes no request rather than sending an empty Bearer token.
--
-- ── REPLAY ────────────────────────────────────────────────────────────────
--
-- One partial index, one function, one cron job. The job is scheduled HERE,
-- so a replay establishes it; the check at the bottom still only WARNS about
-- it, because the-wiring-is-connected collects schedules after checking each
-- file (a file cannot vouch for a job it schedules itself) and pg_cron may be
-- absent. Everything the $check$ block asserts, this file creates. No table,
-- so no RLS and no require_mfa_policy.

-- ── 1. The band the gate and the hook both read ─────────────────────────────
--
-- Partial: a scheduled, assigned stop with a window is a small slice of
-- visits (completed history is most of the table), and it is exactly the
-- slice both queries filter to. eta_end >= x implies eta_end IS NOT NULL, so
-- the planner can use it for the hook's PostgREST query as well.

CREATE INDEX IF NOT EXISTS idx_visits_open_window_end
  ON public.visits (eta_end)
  WHERE status = 'scheduled' AND assigned_staff_id IS NOT NULL AND eta_end IS NOT NULL;

-- ── 2. Is any window near? ─────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.late_check_due(_at timestamptz DEFAULT now())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
  SELECT EXISTS (
    SELECT 1
      FROM public.visits v
     WHERE v.status = 'scheduled'
       AND v.assigned_staff_id IS NOT NULL
       AND v.eta_end IS NOT NULL
       AND v.eta_end >= _at - interval '120 minutes'
       AND v.eta_end <= _at + interval '180 minutes'
  );
$fn$;

COMMENT ON FUNCTION public.late_check_due(timestamptz) IS
  'True when some open, assigned stop has an arrival window closing between 120 minutes before and 180 minutes after _at: the only times the late-check cron job makes a request. The band is LATE_GIVE_UP_MIN and LATE_LOOKAHEAD_MIN in src/lib/field-notify.ts.';

REVOKE ALL ON FUNCTION public.late_check_due(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.late_check_due(timestamptz) TO service_role;

-- ── 3. Schedule it ─────────────────────────────────────────────────────────
--
-- 30 seconds for pg_net rather than its default 5: a run that tells several
-- offices does several pushes, and on Cloudflare a caller that hangs up can
-- take the request down with it. A run takes well under five minutes, and
-- two overlapping is harmless: the event key makes the notification
-- idempotent.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    PERFORM cron.unschedule('late-check')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'late-check');
    PERFORM cron.schedule('late-check', '*/5 * * * *', $job$
  SELECT net.http_post(
      url := 'https://app.houndstack.com/api/public/hooks/late-check',
      headers := jsonb_build_object(
        'Content-type', 'application/json',
        'Authorization', 'Bearer ' || s.decrypted_secret
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
  ) AS request_id
    FROM vault.decrypted_secrets s
   WHERE s.name = 'cron_service_role_key'
     AND public.late_check_due();
  $job$);
  ELSE
    RAISE WARNING 'pg_cron is not installed, so late-check was NOT scheduled; a truck stuck at a long stop with location sharing off will not be reported late';
  END IF;
END
$sched$;

-- ── 4. Check what this file established ─────────────────────────────────────

DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                  AND indexname = 'idx_visits_open_window_end') THEN
    RAISE EXCEPTION 'idx_visits_open_window_end is missing; the late check would scan visits every five minutes';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p, unnest(p.proconfig) cfg
                  WHERE p.oid = 'public.late_check_due(timestamptz)'::regprocedure
                    AND cfg LIKE 'search_path=%') THEN
    RAISE EXCEPTION 'late_check_due has no fixed search_path';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE oid = 'public.late_check_due(timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'late_check_due must run as its caller, not as its owner';
  END IF;
  IF has_function_privilege('anon', 'public.late_check_due(timestamptz)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.late_check_due(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'late_check_due is executable by anon or authenticated';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.late_check_due(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'late_check_due is not executable by service_role';
  END IF;
END
$check$;

-- WARNING, not EXCEPTION: see the header. The job is scheduled above when
-- pg_cron exists; saying so if it is not is the operator's cue.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron')
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'late-check' AND active) THEN
    RAISE WARNING 'late-check is not scheduled or not active; a stuck truck will not be reported late';
  END IF;
END
$cron$;
