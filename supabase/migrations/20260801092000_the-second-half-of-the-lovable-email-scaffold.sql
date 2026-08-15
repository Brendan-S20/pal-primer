-- The second half of the Lovable email scaffold, found only because the drift
-- check was fixed.
--
-- BUG-75 dropped `email_queue_wake` for POSTing a vaulted service_role key to a
-- lovable.app host. `email_queue_dispatch` is the function it existed to
-- schedule, and it does the same thing:
--
--     url := 'https://project--da34c6c7-...-.lovable.app/lovable/email/queue/process'
--     'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM
--                                    vault.decrypted_secrets
--                                     WHERE name = 'email_queue_service_role_key')
--
-- It was invisible to the drift sweep because that sweep counted
-- `REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch()` — in
-- 20260731240000 — as a definition. Fixing `isDeclared` to require a CREATE
-- surfaced it immediately. One bug in a checker concealed one bug in the
-- schema, which is the whole argument for mutation-testing the checkers.
--
-- ── WHY DROPPING IT IS SAFE, CHECKED RATHER THAN ASSUMED ──────────────────
--
--   * The live cron job does NOT call it. `process-email-queue` runs every
--     minute and its command is a direct net.http_post to
--     https://www.app.houndstack.com/email/queue/process authorized with the
--     `cron_service_role_key` secret. Read out of cron.job, not inferred.
--   * Nothing in src/ calls it. The only reference is a generated type in
--     integrations/supabase/types.ts.
--   * `email_queue_wake`, the only thing that ever scheduled it, is already
--     gone (BUG-75).
--   * EXECUTE was already revoked from `authenticated` by 20260731240000; the
--     remaining grants are postgres and service_role.
--   * The vault secret it reads, 'email_queue_service_role_key', does not
--     exist — vault.secrets has zero rows by that name. So even invoked it
--     would send `Authorization: null` to a third party rather than leak a key.
--
-- So this is not an incident either. It is the same loaded gun as its sibling:
-- a SECURITY DEFINER routine wired to exfiltrate a service_role key to a host
-- this product does not run on, waiting for someone to schedule it. The real
-- email path is untouched — `enqueue_email`, `read_email_batch`, `delete_email`
-- and `move_to_dlq` stay, and the cron job that drives them is not altered.
--
-- The body is preserved above in prose so the drop is reversible from this file.

DROP FUNCTION IF EXISTS public.email_queue_dispatch();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'email_queue_dispatch') THEN
    RAISE EXCEPTION 'email_queue_dispatch survived the drop';
  END IF;

  -- The real queue must be untouched. If any of these disappear, outbound email
  -- stops and nothing else in this migration would explain why.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('enqueue_email','read_email_batch','delete_email','move_to_dlq')) <> 4 THEN
    RAISE EXCEPTION 'the real email queue functions are not all present';
  END IF;

  -- ── ASSERTED ONLY WHERE SCHEDULES EXIST ────────────────────────────────
  --
  -- This checks the RUNNING ENVIRONMENT, not the schema. A cron job is created
  -- by operations, not by any migration in this repo, so a database built from
  -- these files has none — and this assertion, which exists to prove the drop
  -- above did not break outbound email, instead made the sequence unreplayable:
  --
  --     ERROR: the process-email-queue cron job is missing or inactive (SQLSTATE P0001)
  --
  -- That is the fifth fault the Sandboxes replay found and the first of a
  -- different kind. The previous four were the repo failing to describe
  -- something production has. This one is a migration asserting a fact a
  -- migration cannot establish.
  --
  -- The guard is kept where it means something. `cron.job` being entirely
  -- empty is the signature of a freshly built database, where there is no
  -- email path running and therefore nothing for this to protect. Anywhere
  -- schedules exist at all — production included — the assertion is exactly as
  -- strict as before.
  --
  -- Deliberately NOT downgraded to a warning: on the real database a missing
  -- process-email-queue means outbound email has silently stopped, and that
  -- should still refuse to proceed.
  IF EXISTS (SELECT 1 FROM cron.job)
     AND NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue' AND active) THEN
    RAISE EXCEPTION 'the process-email-queue cron job is missing or inactive';
  END IF;
END $$;
