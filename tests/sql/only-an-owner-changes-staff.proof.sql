-- Only an owner changes staff (#659, D7), proved against a real Postgres. Run
-- by tests/only-an-owner-changes-staff.test.ts with :migration. One
-- transaction, ROLLED BACK at the end, the migration included. Each check
-- prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- One business: two owners (so turning one off is not refused by the
-- last-owner trigger, and the refusal seen is the new rule's), an office
-- manager, a technician. Each is tried as
-- the API sees them: role authenticated, the JWT's sub set the way Supabase
-- sets it. A direct UPDATE as `authenticated` is what PATCH /rest/v1/staff is.

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
  ('f0000000-0000-4000-8000-000000d70a01', 'owner@d7.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70a02', 'office@d7.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70a03', 'tech@d7.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70a04', 'nobody-yet@d7.proof.invalid'),
  ('f0000000-0000-4000-8000-000000d70a05', 'owner2@d7.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000d70a00', 'D7 Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000d70a01', '0a000000-0000-4000-8000-000000d70a00', 'owner'),
  ('f0000000-0000-4000-8000-000000d70a02', '0a000000-0000-4000-8000-000000d70a00', 'office_manager'),
  ('f0000000-0000-4000-8000-000000d70a03', '0a000000-0000-4000-8000-000000d70a00', 'tech'),
  ('f0000000-0000-4000-8000-000000d70a05', '0a000000-0000-4000-8000-000000d70a00', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000d70a01', '0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a01', 'owner', 'Owner D7', true),
  ('5a000000-0000-4000-8000-000000d70a02', '0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a02', 'office_manager', 'Office D7', true),
  ('5a000000-0000-4000-8000-000000d70a03', '0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a03', 'tech', 'Tech D7', true),
  ('5a000000-0000-4000-8000-000000d70a05', '0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a05', 'owner', 'Owner Two D7', true);

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The office manager, through the RPC and through the table ──────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70a02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000d70a03', false);
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: set_staff_active turned the technician off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000d70a03';
    GET DIAGNOSTICS _n = ROW_COUNT;
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE turned the technician off (% row)', _n;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000d70a01';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: a direct UPDATE turned the owner off';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET role = 'owner' WHERE id = '5a000000-0000-4000-8000-000000d70a02';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager wrote their own role = owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    UPDATE public.staff SET role = 'dispatcher' WHERE id = '5a000000-0000-4000-8000-000000d70a03';
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager changed the technician''s role';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.staff (organization_id, user_id, role, display_name, active)
    VALUES ('0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a04', 'owner', 'Made An Owner', false);
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager inserted an owner';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000d70a00', 'f0000000-0000-4000-8000-000000d70a02', 'owner');
    RAISE EXCEPTION 'PROOF FAILED [om rpc]: change_user_role made the office manager an owner';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  END;

  DELETE FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70a03';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [om rest]: the office manager deleted the technician';
  END IF;

  -- What an office manager still does: a teammate's route start.
  UPDATE public.staff SET start_address = '1 Depot Rd' WHERE id = '5a000000-0000-4000-8000-000000d70a03';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [om address]: the office manager can no longer edit a teammate''s address';
  END IF;
  RAISE NOTICE 'ok: an office manager cannot turn anyone off, change a role, add an owner or remove anyone, by RPC or REST; addresses still edit';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.staff WHERE organization_id = '0a000000-0000-4000-8000-000000d70a00' AND NOT active)
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70a02') <> 'office_manager'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000d70a02') <> 'office_manager' THEN
    RAISE EXCEPTION 'PROOF FAILED [after om]: a refused write changed something';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activity_log WHERE organization_id = '0a000000-0000-4000-8000-000000d70a00') THEN
    RAISE EXCEPTION 'PROOF FAILED [after om]: a refused write was logged as if it happened';
  END IF;
  RAISE NOTICE 'ok: nothing the office manager tried changed a row or wrote a log line';
END $$;

-- ── The owner ───────────────────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000d70a01');
SET LOCAL ROLE authenticated;
SELECT public.set_staff_active('5a000000-0000-4000-8000-000000d70a03', false);
UPDATE public.staff SET active = true WHERE id = '5a000000-0000-4000-8000-000000d70a03';
UPDATE public.staff SET role = 'dispatcher' WHERE id = '5a000000-0000-4000-8000-000000d70a03';
RESET ROLE;

DO $$
DECLARE _n bigint;
BEGIN
  IF NOT (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70a03')
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000d70a03') <> 'dispatcher' THEN
    RAISE EXCEPTION 'PROOF FAILED [owner]: the owner''s changes did not land';
  END IF;
  SELECT count(*) INTO _n FROM public.activity_log
   WHERE organization_id = '0a000000-0000-4000-8000-000000d70a00'
     AND actor_user_id = 'f0000000-0000-4000-8000-000000d70a01'
     AND actor_label = 'Owner D7'
     AND meta->>'staff_id' = '5a000000-0000-4000-8000-000000d70a03'
     AND kind IN ('staff.active_changed', 'staff.role_changed');
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: expected 3 log rows naming the owner, found %', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log
                  WHERE kind = 'staff.role_changed'
                    AND meta->>'from' = 'tech' AND meta->>'to' = 'dispatcher'
                    AND organization_id = '0a000000-0000-4000-8000-000000d70a00') THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: the role change does not say from and to';
  END IF;
  RAISE NOTICE 'ok: the owner turns people off and on and changes roles, and each change names the owner';
END $$;

ROLLBACK;
\echo ALL ONLY-AN-OWNER-CHANGES-STAFF PROOFS PASSED
