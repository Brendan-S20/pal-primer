-- An account the app never locks is never deleted (owner, 2026-10-10).
-- Run by tests/a-grandfathered-account-is-never-deleted.test.ts, which passes
-- the migration's path as :migration and a matrix of organizations as
-- :fixtures (JSON), and compares what this prints with the app's own
-- accountLockFor for the same rows.
--
-- One transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]"; every candidate is printed
-- as "cand|<name>|<reason or none>".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture: one organization per row of the matrix ─────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
CREATE TEMP TABLE fx ON COMMIT DROP AS
SELECT gen_random_uuid() AS id, f.*
  FROM jsonb_to_recordset(:'fixtures'::jsonb) AS f(
         name text, created_at timestamptz, plan_status text, billing_status text,
         trial_ends_at timestamptz, stripe_subscription_id text, current_period_end timestamptz,
         is_comped boolean, suspended_at timestamptz);

INSERT INTO public.organizations
       (id, name, created_at, plan_status, billing_status, trial_ends_at, stripe_subscription_id,
        current_period_end, is_comped, suspended_at)
SELECT id, 'Grandfather Proof ' || name, created_at, plan_status::public.org_plan_status,
       billing_status::public.org_billing_status, trial_ends_at, stripe_subscription_id,
       current_period_end, is_comped, suspended_at
  FROM fx;

-- What was stored is what was asked for (a trigger may not rewrite created_at
-- or a status, or the comparison below would be about other rows).
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n
    FROM fx JOIN public.organizations o ON o.id = fx.id
   WHERE o.created_at IS DISTINCT FROM fx.created_at
      OR o.plan_status::text IS DISTINCT FROM fx.plan_status
      OR o.billing_status::text IS DISTINCT FROM fx.billing_status
      OR o.is_comped IS DISTINCT FROM fx.is_comped;
  IF _n > 0 THEN RAISE EXCEPTION 'PROOF FAILED [fixture]: % organizations were stored differently', _n; END IF;
  RAISE NOTICE 'ok: fixture stored as written (% organizations)', (SELECT count(*) FROM fx);
END $$;

-- ── Every candidate, for the wrapper to compare with accountLockFor ─────────
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT fx.name, c.reason
      FROM fx
      LEFT JOIN public.account_deletion_candidates('2026-10-09', '2026-10-20T12:00:00Z') c
        ON c.organization_id = fx.id
     ORDER BY fx.name
  LOOP
    RAISE NOTICE 'cand|%|%', r.name, COALESCE(r.reason, 'none');
  END LOOP;
END $$;

-- ── Before the cutoff, plan ended: not a candidate, not purgeable ───────────
DO $$
DECLARE _id uuid := (SELECT id FROM fx WHERE name = 'pre-cutoff plan ended');
        _refused int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM public.account_deletion_candidates('2026-10-09', '2027-06-01') c
              WHERE c.organization_id = _id) THEN
    RAISE EXCEPTION 'PROOF FAILED [pre-cutoff]: a plan-ended account created before the cutoff is a candidate';
  END IF;
  BEGIN
    PERFORM public.purge_locked_account(_id, true, '2026-10-09', '2027-06-01');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'created before' THEN RAISE; END IF;
    _refused := _refused + 1;
  END;
  BEGIN
    PERFORM public.purge_locked_account(_id, false, '2026-09-01', '2027-06-01');
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'created before' THEN RAISE; END IF;
    _refused := _refused + 1;
  END;
  IF _refused <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [pre-cutoff]: purge_locked_account accepted it % time(s)', 2 - _refused;
  END IF;
  IF (SELECT name FROM public.organizations WHERE id = _id) <> 'Grandfather Proof pre-cutoff plan ended'
     OR (SELECT deleted_at FROM public.organizations WHERE id = _id) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [pre-cutoff]: the organization row was touched';
  END IF;
  RAISE NOTICE 'ok: pre-cutoff plan ended is not a candidate, and the purge refuses it (dry and real)';
END $$;

-- The purge's own guard does not lean on the candidate list: even if a
-- candidate function were broken to list everyone, it still refuses.
DO $$
DECLARE _id uuid := (SELECT id FROM fx WHERE name = 'pre-cutoff plan ended');
BEGIN
  CREATE OR REPLACE FUNCTION public.account_deletion_candidates(_deployed_on date, _now timestamptz DEFAULT now())
  RETURNS TABLE (organization_id uuid, reason text, locked_since timestamptz, delete_after timestamptz)
  LANGUAGE sql STABLE AS $f$
    SELECT o.id, 'plan_ended'::text, timestamptz '2026-01-01', timestamptz '2026-01-02' FROM public.organizations o
  $f$;
  BEGIN
    PERFORM public.purge_locked_account(_id, false, '2026-09-01', '2027-06-01');
    RAISE EXCEPTION 'PROOF FAILED [guard]: purged a pre-cutoff account when the candidate list said so';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'created before' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: the purge refuses a pre-cutoff account on its own row, whatever the candidate list says';
END $$;

-- Put the real candidate function back for the rest of the proof.
\i :migration

-- ── After the cutoff, plan ended: still a candidate, still purged ───────────
DO $$
DECLARE _id uuid := (SELECT id FROM fx WHERE name = 'post-cutoff plan ended');
        _c record;
        _r jsonb;
BEGIN
  SELECT * INTO _c FROM public.account_deletion_candidates('2026-10-09', '2026-10-20T12:00:00Z') c
   WHERE c.organization_id = _id;
  IF NOT FOUND OR _c.reason <> 'plan_ended' OR _c.delete_after <> timestamptz '2026-11-09 00:00:00+00' THEN
    RAISE EXCEPTION 'PROOF FAILED [post-cutoff]: expected plan_ended due 2026-11-09, got % %', _c.reason, _c.delete_after;
  END IF;
  _r := public.purge_locked_account(_id, true, '2026-10-09', '2026-10-20T12:00:00Z');
  IF (_r->>'dry_run')::boolean IS NOT TRUE OR _r->>'reason' <> 'plan_ended' THEN
    RAISE EXCEPTION 'PROOF FAILED [post-cutoff]: dry run returned %', _r;
  END IF;
  BEGIN
    PERFORM public.purge_locked_account(_id, false, '2026-10-09', '2026-10-20T12:00:00Z');
    RAISE EXCEPTION 'PROOF FAILED [post-cutoff]: purged before it was due';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM !~ 'not due' THEN RAISE; END IF;
  END;
  _r := public.purge_locked_account(_id, false, '2026-10-09', '2026-11-10T00:00:00Z');
  IF (_r->>'dry_run')::boolean IS NOT FALSE
     OR (SELECT name FROM public.organizations WHERE id = _id) <> 'Deleted account'
     OR (SELECT deleted_at FROM public.organizations WHERE id = _id) IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [post-cutoff]: the due purge did not run: %', _r;
  END IF;
  RAISE NOTICE 'ok: post-cutoff plan ended is a candidate, refused before it is due, purged once it is';
END $$;

-- ── After the cutoff, trial ended: still a candidate ────────────────────────
DO $$
DECLARE _id uuid := (SELECT id FROM fx WHERE name = 'post-cutoff trial ended');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.account_deletion_candidates('2026-10-09', '2026-10-20T12:00:00Z') c
                  WHERE c.organization_id = _id AND c.reason = 'trial_ended') THEN
    RAISE EXCEPTION 'PROOF FAILED [post-cutoff trial]: an expired post-cutoff trial is not a candidate';
  END IF;
  PERFORM public.purge_locked_account(_id, true, '2026-10-09', '2026-10-20T12:00:00Z');
  RAISE NOTICE 'ok: post-cutoff trial ended is a candidate and its dry run is allowed';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL GRANDFATHER PROOFS PASSED'; END $$;

ROLLBACK;
