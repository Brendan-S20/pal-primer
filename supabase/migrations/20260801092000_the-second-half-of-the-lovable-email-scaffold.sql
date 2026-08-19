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

  -- ── A FACT NO MIGRATION CAN ESTABLISH, SO NOT AN ASSERTION ─────────────
  --
  -- This checks the RUNNING ENVIRONMENT, not the schema. `process-email-queue`
  -- is scheduled by operations; no migration in this repo creates it. So a
  -- database built from these files does not have it, and this check — which
  -- exists to prove the drop above did not break outbound email — instead made
  -- the sequence unreplayable:
  --
  --     ERROR: the process-email-queue cron job is missing or inactive (SQLSTATE P0001)
  --
  -- That was the fifth fault the Sandboxes replay found and the first of a
  -- different kind. The previous four were the repo failing to describe
  -- something production has. This one is the mirror image: a migration
  -- demanding operations state it cannot create.
  --
  -- ── THE FIRST FIX WAS WRONG, AND WRONG IN A CHECKABLE WAY ──────────────
  --
  -- It read `IF EXISTS (SELECT 1 FROM cron.job) AND NOT EXISTS (...)`, on the
  -- stated reasoning that "an entirely empty cron.job is the signature of a
  -- freshly built database". That is false, and one grep would have said so.
  -- Two migrations in this repo schedule jobs before this file runs:
  --
  --     20260701180832  CREATE EXTENSION pg_cron
  --     20260716220000  cron.schedule('run-billing-cycles', ...)
  --     20260731130000  cron.schedule('weekly-digest', ...)
  --
  -- so `cron.job` holds two rows by the time the sequence reaches this line.
  -- The precondition passed, the assertion fired, and replay 6 failed in
  -- exactly the same place as replay 5 — with the new code in the log.
  --
  -- ── WHY A WARNING IS THE HONEST ANSWER ─────────────────────────────────
  --
  -- The argument I rejected the first time is the correct one. This migration
  -- is already recorded in production's ledger
  -- (20260801152555, "the_second_half_of_the_lovable_email_scaffold"), and a
  -- migration runs once. The only databases that will ever execute this block
  -- again are fresh ones — where, by construction, no operations-scheduled job
  -- exists. There is no future execution in which raising here is right.
  --
  -- Monitoring a live cron job is a job for monitoring. A migration is the
  -- wrong instrument for it, and pretending otherwise cost two replay rounds.
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'process-email-queue' AND active) THEN
    RAISE WARNING 'no active process-email-queue cron job: outbound email will not be delivered until one is scheduled';
  END IF;
END $$;
