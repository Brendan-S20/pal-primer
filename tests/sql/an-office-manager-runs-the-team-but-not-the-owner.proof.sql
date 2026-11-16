-- An office manager runs the team but not the owner (#659, D7 as changed
-- 2026-11-10), proved against a real Postgres. Run by
-- tests/an-office-manager-runs-the-team-but-not-the-owner.test.ts with
-- :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- One business: two owners (so turning one off is not refused by the
-- last-owner trigger, and the refusal seen is this rule's), an office
-- manager, a dispatcher, a technician, and a person with an account who is
-- not on the team. Each is tried as the API
-- sees them: role authenticated, the JWT's sub set the way Supabase sets it.
-- A direct UPDATE as `authenticated` is what PATCH /rest/v1/staff is.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000d70b01', 'owner@d7b.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70b02', 'office@d7b.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70b03', 'tech@d7b.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70b04', 'dispatch@d7b.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70b05', 'stranger@d7b.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70b06', 'owner2@d7b.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000d70b00', 'D7 Office Manager Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000d70b01', '0a000000-0000-4000-8000-000000d70b00', 'owner'),
  ('f0000000-0000-4000-8000-000000d70b02', '0a000000-0000-4000-8000-000000d70b00', 'office_manager'),
  ('f0000000-0000-4000-8000-000000d70b03', '0a000000-0000-4000-8000-000000d70b00', 'tech'),
  ('f0000000-0000-4000-8000-000000d70b04', '0a000000-0000-4000-8000-000000d70b00', 'dispatcher'),
  ('f0000000-0000-4000-8000-000000d70b06', '0a000000-0000-4000-8000-000000d70b00', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000d70b01', '0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b01', 'owner', 'Owner D7B', true),
  ('5a000000-0000-4000-8000-000000d70b02', '0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b02', 'office_manager', 'Office D7B', true),
  ('5a000000-0000-4000-8000-000000d70b03', '0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'tech', 'Tech D7B', true),
  ('5a000000-0000-4000-8000-000000d70b04', '0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b04', 'dispatcher', 'Dispatch D7B', true),
  ('5a000000-0000-4000-8000-000000d70b06', '0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b06', 'owner', 'Owner Two D7B', true);

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The office manager: what they may now do ───────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70b02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  -- By RPC: turn the technician off and back on, change their role.
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b03', false);
  IF (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b03') THEN
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: set_staff_active did not turn the technician off';
  END IF;
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b03', true);
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'dispatcher');
  IF (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b03') <> 'dispatcher'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70b03') <> 'dispatcher' THEN
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role did not make the technician a dispatcher';
  END IF;
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'tech');

  -- By REST: the same, straight at the table.
  UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000d70b03';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE could not turn the technician off';
  END IF;
  UPDATE public.staff SET active = true, role = 'office_manager' WHERE id = '5a000000-0000-4000-8000-000000d70b03';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE could not change the technician''s role to office manager';
  END IF;
  UPDATE public.staff SET role = 'tech' WHERE id = '5a000000-0000-4000-8000-000000d70b03';

  -- Still: the owner's address, which changes neither active nor role.
  UPDATE public.staff SET start_address = '1 Depot Rd' WHERE id = '5a000000-0000-4000-8000-000000d70b01';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [om address]: the office manager can no longer edit the owner''s address';
  END IF;
  RAISE NOTICE 'ok: an office manager turns a technician off and on and changes their role, by RPC and REST';
END $$;

-- ── The office manager: what they still may not do ─────────────────────────
DO $$
DECLARE _n bigint;
BEGIN
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b01', false);
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: set_staff_active turned the owner off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b01', 'tech');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role demoted the owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b02', 'owner');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role made the office manager an owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'owner');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role made the technician an owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'platform_admin');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role granted platform_admin';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b05', 'tech');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role added somebody who is not on the team';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000d70b01';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE turned the owner off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET role = 'tech' WHERE id = '5a000000-0000-4000-8000-000000d70b01';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE demoted the owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET role = 'owner' WHERE id = '5a000000-0000-4000-8000-000000d70b02';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager wrote their own role = owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET role = 'owner' WHERE id = '5a000000-0000-4000-8000-000000d70b03';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager made the technician an owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.staff (organization_id, user_id, role, display_name, active)
    VALUES ('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b05', 'owner', 'Made An Owner', false);
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager inserted an owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  DELETE FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b01';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager deleted the owner';
  END IF;
  RAISE NOTICE 'ok: an office manager cannot touch the owner or grant owner or platform_admin, by RPC or REST';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF NOT (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b01')
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b01') <> 'owner'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70b01') <> 'owner'
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b02') <> 'office_manager'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70b02') <> 'office_manager'
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b03') <> 'tech'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70b03') <> 'tech'
     OR EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70b05') THEN
    RAISE EXCEPTION 'PROOF FAILED [after om]: a refused write changed something';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log
                  WHERE organization_id = '0a000000-0000-4000-8000-000000d70b00'
                    AND actor_user_id = 'f0000000-0000-4000-8000-000000d70b02'
                    AND kind = 'staff.active_changed'
                    AND meta->>'staff_id' = '5a000000-0000-4000-8000-000000d70b03') THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: the office manager''s change was not logged with them as the actor';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activity_log
              WHERE organization_id = '0a000000-0000-4000-8000-000000d70b00'
                AND meta->>'staff_id' = '5a000000-0000-4000-8000-000000d70b01') THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: a refused write on the owner was logged as if it happened';
  END IF;
  RAISE NOTICE 'ok: the owner is untouched, and what the office manager did is logged with them as the actor';
END $$;

-- ── A dispatcher and a technician are still refused ────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70b04');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b03', false);
    RAISE EXCEPTION 'PROOF FAILED [dispatcher rpc]: set_staff_active turned the technician off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'dispatcher');
    RAISE EXCEPTION 'PROOF FAILED [dispatcher rpc]: change_user_role changed the technician''s role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a dispatcher turns nobody off and changes no role';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70b03');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b04', false);
    RAISE EXCEPTION 'PROOF FAILED [tech rpc]: set_staff_active turned the dispatcher off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b03', 'office_manager');
    RAISE EXCEPTION 'PROOF FAILED [tech rpc]: the technician promoted themselves';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a technician turns nobody off and changes no role';
END $$;
RESET ROLE;

-- ── The owner keeps everything ─────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70b01');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b02', false);
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b02', true);
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b02', 'owner');
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70b00', 'f0000000-0000-4000-8000-000000d70b02', 'office_manager');
  UPDATE public.staff SET role = 'dispatcher' WHERE id = '5a000000-0000-4000-8000-000000d70b03';
  IF (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70b03') <> 'dispatcher' THEN
    RAISE EXCEPTION 'PROOF FAILED [owner rest]: the owner''s direct role change did not land';
  END IF;
  -- And turns another owner off and on, which an office manager may not.
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b06', false);
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70b06', true);
  RAISE NOTICE 'ok: the owner turns people off and on, owners included, grants owner, and changes roles by REST';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL AN-OFFICE-MANAGER-RUNS-THE-TEAM PROOFS PASSED
