-- A trial with four or more people could not add a client (#569): the chain
-- clients -> active_client_count -> assign_billing_tier_for_org -> plan_id ->
-- tg_orgs_protect_platform_columns, proved against a real Postgres. Run by
-- tests/a-trial-with-four-people-could-not-add-a-client.proof.test.ts, which
-- passes :migration, the file under proof. Every earlier migration is assumed
-- applied (a local stack built from main).
--
-- One transaction, ROLLED BACK at the end, migration included. Each group
-- prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── The catalog this depends on ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.platform_plans WHERE slug = 'launch' AND is_active AND max_team_size = 3)
     OR NOT EXISTS (SELECT 1 FROM public.platform_plans WHERE slug = 'growth' AND is_active AND max_team_size = 15) THEN
    RAISE EXCEPTION 'PROOF FAILED [catalog]: launch (up to 3) and growth (up to 15) are not both active';
  END IF;
END $$;

-- ── A trial on Launch with four enabled people: the state the audit found ──
-- Fixtures are written with the hatch open, as the platform would.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5690000-0000-4000-8000-000000000001', 'owner@trial4.proof.invalid'),
  ('a5690000-0000-4000-8000-000000000002', 'tech1@trial4.proof.invalid'),
  ('a5690000-0000-4000-8000-000000000003', 'tech2@trial4.proof.invalid'),
  ('a5690000-0000-4000-8000-000000000004', 'tech3@trial4.proof.invalid');
INSERT INTO public.organizations (id, name, plan_status, billing_status, trial_ends_at, plan_id, billing_tier)
SELECT '05690000-0000-4000-8000-0000000000aa', 'Trial Four Proof', 'trialing', 'trialing',
       now() + interval '14 days', p.id, p.slug
  FROM public.platform_plans p WHERE p.slug = 'launch';
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5690000-0000-4000-8000-000000000001', '05690000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5690000-0000-4000-8000-000000000002', '05690000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5690000-0000-4000-8000-000000000003', '05690000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5690000-0000-4000-8000-000000000004', '05690000-0000-4000-8000-0000000000aa', 'tech');
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active)
SELECT ('55690000-0000-4000-8000-00000000000' || n)::uuid, '05690000-0000-4000-8000-0000000000aa',
       ('a5690000-0000-4000-8000-00000000000' || n)::uuid,
       (CASE WHEN n = 1 THEN 'owner' ELSE 'tech' END)::public.staff_role, 'Person ' || n, true
  FROM generate_series(1, 4) n
ON CONFLICT (id) DO NOTHING;
SELECT public.refresh_active_seat_count('05690000-0000-4000-8000-0000000000aa');
-- Whatever the stack's triggers did with the seats, put the org back on
-- Launch with four people, as production had it.
UPDATE public.organizations
   SET plan_id = (SELECT id FROM public.platform_plans WHERE slug = 'launch'), billing_tier = 'launch'
 WHERE id = '05690000-0000-4000-8000-0000000000aa';
SET LOCAL app.allow_protected_org_write = '';

CREATE FUNCTION pg_temp.as_owner() RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           '{"sub":"a5690000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}', true);
$$;
CREATE FUNCTION pg_temp.slug() RETURNS text LANGUAGE sql AS $$
  SELECT p.slug FROM public.organizations o JOIN public.platform_plans p ON p.id = o.plan_id
   WHERE o.id = '05690000-0000-4000-8000-0000000000aa';
$$;
-- Put the org back on Launch as the platform would, between groups.
CREATE FUNCTION pg_temp.back_to_launch() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', '{}', true);
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations
     SET plan_id = (SELECT id FROM public.platform_plans WHERE slug = 'launch'), billing_tier = 'launch'
   WHERE id = '05690000-0000-4000-8000-0000000000aa';
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_owner() TO authenticated;
GRANT EXECUTE ON FUNCTION pg_temp.slug() TO authenticated;

DO $$
BEGIN
  IF (SELECT active_seat_count FROM public.organizations WHERE id = '05690000-0000-4000-8000-0000000000aa') <> 4
     OR pg_temp.slug() <> 'launch' THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the trial is not on Launch with four people';
  END IF;
END $$;

-- ── 0. Before the fix, the owner's client insert is refused ────────────────
-- Only on a stack that does not carry the fix yet. Once main has it, there is
-- no "before" to show, and that is said rather than passed.
SELECT (SELECT p.prosrc FROM pg_proc p
         WHERE p.oid = 'public.assign_billing_tier_for_org(uuid)'::regprocedure)
       NOT LIKE '%allow_protected_org_write%' AS before_fix \gset
\if :before_fix
SELECT pg_temp.as_owner();
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.clients (organization_id, account_type, display_name)
    VALUES ('05690000-0000-4000-8000-0000000000aa', 'residential', 'Before The Fix');
    RAISE EXCEPTION 'PROOF FAILED [before]: the bug did not reproduce, so the proof below proves nothing';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%can only be changed by the platform%' THEN
      RAISE EXCEPTION 'PROOF FAILED [before]: refused for another reason: %', SQLERRM;
    END IF;
  END;
  RAISE NOTICE 'ok: before the fix, a trial with four people could not add a client';
END $$;
RESET ROLE;
\else
DO $$ BEGIN
  RAISE WARNING 'SKIPPED [before]: this stack already carries the fix, so the bug was not reproduced first';
END $$;
\endif

-- ── The migration ───────────────────────────────────────────────────────────
-- Its reconcile re-decides this org (four people, Launch holds three).
\i :migration

DO $$
BEGIN
  IF pg_temp.slug() <> 'growth' THEN
    RAISE EXCEPTION 'PROOF FAILED [reconcile]: the stuck trial is still on %', pg_temp.slug();
  END IF;
  IF COALESCE(current_setting('app.allow_protected_org_write', true), '') <> '' THEN
    RAISE EXCEPTION 'PROOF FAILED [reconcile]: the migration left the protected-write hatch open';
  END IF;
  RAISE NOTICE 'ok: the migration moves a trial with four people off Launch';
END $$;

-- ── 1. The owner adds a client, and the tier follows the team ──────────────
SELECT pg_temp.back_to_launch();
SELECT pg_temp.as_owner();
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.clients (id, organization_id, account_type, display_name)
  VALUES ('c5690000-0000-4000-8000-000000000001', '05690000-0000-4000-8000-0000000000aa', 'residential', 'Four People Customer');
  IF pg_temp.slug() <> 'growth' THEN
    RAISE EXCEPTION 'PROOF FAILED [create]: the trial is on % after the insert, not growth', pg_temp.slug();
  END IF;
  IF COALESCE(current_setting('app.allow_protected_org_write', true), '') <> '' THEN
    RAISE EXCEPTION 'PROOF FAILED [create]: the hatch stayed open after the insert';
  END IF;
  RAISE NOTICE 'ok: a trial with four people adds a client and moves to Growth';
END $$;
RESET ROLE;

-- ── 2. The hatch is closed: the owner still cannot write plan_id ───────────
SELECT pg_temp.as_owner();
DO $$
BEGIN
  BEGIN
    UPDATE public.organizations
       SET plan_id = (SELECT id FROM public.platform_plans WHERE slug = 'launch')
     WHERE id = '05690000-0000-4000-8000-0000000000aa';
    RAISE EXCEPTION 'PROOF FAILED [hatch]: a tenant wrote plan_id after a client insert';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%can only be changed by the platform%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'ok: the protected columns are still protected after the tier moved';
END $$;

-- ── 3. Archive and unarchive ───────────────────────────────────────────────
SELECT pg_temp.back_to_launch();
SELECT pg_temp.as_owner();
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  UPDATE public.clients SET active = false WHERE id = 'c5690000-0000-4000-8000-000000000001';
  IF (SELECT active FROM public.clients WHERE id = 'c5690000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [archive]: the client is still active';
  END IF;
END $$;
RESET ROLE;
SELECT pg_temp.back_to_launch();
SELECT pg_temp.as_owner();
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  UPDATE public.clients SET active = true WHERE id = 'c5690000-0000-4000-8000-000000000001';
  IF NOT (SELECT active FROM public.clients WHERE id = 'c5690000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'PROOF FAILED [unarchive]: the client is not active';
  END IF;
  RAISE NOTICE 'ok: a trial with four people archives and unarchives a client';
END $$;
RESET ROLE;

-- ── 4. Fifteen people, and the tier follows a seat change ─────────────────
-- The seat writes run with the owner's claims, so the protect trigger sees a
-- tenant; RLS on staff is not what is under test here.
SELECT pg_temp.as_owner();
INSERT INTO auth.users (id, email)
SELECT ('a5690000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'extra' || n || '@trial4.proof.invalid'
  FROM generate_series(5, 15) n;
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active)
SELECT ('55690000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       '05690000-0000-4000-8000-0000000000aa',
       ('a5690000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'tech'::public.staff_role, 'Person ' || n, true
  FROM generate_series(5, 15) n;
DO $$
BEGIN
  IF (SELECT active_seat_count FROM public.organizations WHERE id = '05690000-0000-4000-8000-0000000000aa') <> 15 THEN
    RAISE EXCEPTION 'PROOF FAILED [seats]: expected 15 enabled people';
  END IF;
  IF pg_temp.slug() <> 'growth' THEN
    RAISE EXCEPTION 'PROOF FAILED [seats]: fifteen people on %, not growth', pg_temp.slug();
  END IF;
END $$;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES ('05690000-0000-4000-8000-0000000000aa', 'residential', 'Fifteen People Customer');
END $$;
RESET ROLE;
SELECT pg_temp.as_owner();
UPDATE public.staff SET active = false
 WHERE organization_id = '05690000-0000-4000-8000-0000000000aa' AND display_name <> 'Person 1'
   AND display_name NOT IN ('Person 2', 'Person 3');
DO $$
BEGIN
  IF pg_temp.slug() <> 'launch' THEN
    RAISE EXCEPTION 'PROOF FAILED [seats]: back to three people, the trial is on %, not launch', pg_temp.slug();
  END IF;
  RAISE NOTICE 'ok: fifteen people add a client, and the tier follows the team down to Launch';
END $$;

ROLLBACK;
\echo ALL TRIAL-SEAT PROOFS PASSED
