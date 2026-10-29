-- Import rows and batches belong to whoever can run an import (#571, F-08).
-- Run by tests/a-tech-could-read-every-imported-gate-code.proof.test.ts,
-- which passes the migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end with the migration inside it. Each
-- group prints "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Business A: owner, office manager, dispatcher, tech. Business B: owner.
-- One import in A whose row carries a gate code.
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
INSERT INTO auth.users (id, email) VALUES
  ('a5710000-0000-4000-8000-0000000000a1', 'owner-a@imports.proof.invalid'),
  ('a5710000-0000-4000-8000-0000000000a2', 'office-a@imports.proof.invalid'),
  ('a5710000-0000-4000-8000-0000000000a3', 'dispatch-a@imports.proof.invalid'),
  ('a5710000-0000-4000-8000-0000000000a4', 'tech-a@imports.proof.invalid'),
  ('a5710000-0000-4000-8000-0000000000b1', 'owner-b@imports.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name) VALUES
  ('05710000-0000-4000-8000-0000000000aa', 'Imports Proof A'),
  ('05710000-0000-4000-8000-0000000000bb', 'Imports Proof B');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5710000-0000-4000-8000-0000000000a1', '05710000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5710000-0000-4000-8000-0000000000a2', '05710000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('a5710000-0000-4000-8000-0000000000a3', '05710000-0000-4000-8000-0000000000aa', 'dispatcher'),
  ('a5710000-0000-4000-8000-0000000000a4', '05710000-0000-4000-8000-0000000000aa', 'tech'),
  ('a5710000-0000-4000-8000-0000000000b1', '05710000-0000-4000-8000-0000000000bb', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.import_batches (id, organization_id, created_by, source, status) VALUES
  ('15710000-0000-4000-8000-0000000000a1', '05710000-0000-4000-8000-0000000000aa',
   'a5710000-0000-4000-8000-0000000000a1', 'jobber', 'previewing');
INSERT INTO public.import_rows (id, batch_id, organization_id, row_num, raw) VALUES
  ('25710000-0000-4000-8000-0000000000a1', '15710000-0000-4000-8000-0000000000a1',
   '05710000-0000-4000-8000-0000000000aa', 1,
   '{"name":"Gate Proof Client","phone":"+13125550199","address":"1 Proof Ln","gate_code":"4321"}');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- What one person can do to A's import: rows seen, updated, deleted, and
-- whether an insert went in. Each write is undone with a savepoint so the
-- next person meets the same fixture.
CREATE FUNCTION pg_temp.reach(OUT seen_batches int, OUT seen_rows int,
                              OUT upd_batches int, OUT upd_rows int,
                              OUT del_batches int, OUT del_rows int,
                              OUT ins_ok boolean)
LANGUAGE plpgsql AS $$
BEGIN
  SELECT count(*) INTO seen_batches FROM public.import_batches
   WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';
  SELECT count(*) INTO seen_rows FROM public.import_rows
   WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';

  BEGIN
    UPDATE public.import_rows SET error = 'touched'
     WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';
    GET DIAGNOSTICS upd_rows = ROW_COUNT;
    UPDATE public.import_batches SET error = 'touched'
     WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';
    GET DIAGNOSTICS upd_batches = ROW_COUNT;
    DELETE FROM public.import_rows
     WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';
    GET DIAGNOSTICS del_rows = ROW_COUNT;
    DELETE FROM public.import_batches
     WHERE organization_id = '05710000-0000-4000-8000-0000000000aa';
    GET DIAGNOSTICS del_batches = ROW_COUNT;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;

  BEGIN
    INSERT INTO public.import_batches (organization_id, created_by, source, status)
    VALUES ('05710000-0000-4000-8000-0000000000aa', auth.uid(), 'jobber', 'previewing');
    ins_ok := true;
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION
    WHEN SQLSTATE 'P0099' THEN NULL;
    WHEN insufficient_privilege THEN ins_ok := false;
  END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.reach() TO authenticated;

-- ── 1. A tech, a dispatcher and another business reach nothing ────────────
DO $$
DECLARE _uid text; _who text; _r record;
BEGIN
  FOR _uid, _who IN VALUES
    ('a5710000-0000-4000-8000-0000000000a4', 'tech'),
    ('a5710000-0000-4000-8000-0000000000a3', 'dispatcher'),
    ('a5710000-0000-4000-8000-0000000000b1', 'owner of B')
  LOOP
    PERFORM pg_temp.as_user(_uid);
    SET LOCAL ROLE authenticated;
    SELECT * INTO _r FROM pg_temp.reach();
    RESET ROLE;
    IF _r.seen_batches <> 0 OR _r.seen_rows <> 0 THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: read % batch(es) and % row(s)', _who, _r.seen_batches, _r.seen_rows;
    END IF;
    IF _r.upd_batches <> 0 OR _r.upd_rows <> 0 OR _r.del_batches <> 0 OR _r.del_rows <> 0 THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: changed % / % and deleted % / % (batches / rows)', _who,
        _r.upd_batches, _r.upd_rows, _r.del_batches, _r.del_rows;
    END IF;
    IF _r.ins_ok THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: started an import', _who;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: a tech, a dispatcher and another business read, change and delete no import rows or batches';
END $$;

-- ── 2. The owner and the office manager still run imports ────────────────
DO $$
DECLARE _uid text; _who text; _r record;
BEGIN
  FOR _uid, _who IN VALUES
    ('a5710000-0000-4000-8000-0000000000a1', 'owner'),
    ('a5710000-0000-4000-8000-0000000000a2', 'office manager')
  LOOP
    PERFORM pg_temp.as_user(_uid);
    SET LOCAL ROLE authenticated;
    SELECT * INTO _r FROM pg_temp.reach();
    RESET ROLE;
    IF _r.seen_batches <> 1 OR _r.seen_rows <> 1 THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: read % batch(es) and % row(s), expected 1 and 1', _who, _r.seen_batches, _r.seen_rows;
    END IF;
    IF _r.upd_batches <> 1 OR _r.upd_rows <> 1 OR _r.del_batches <> 1 OR _r.del_rows <> 1 THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: changed % / % and deleted % / %, expected 1 each', _who,
        _r.upd_batches, _r.upd_rows, _r.del_batches, _r.del_rows;
    END IF;
    IF NOT _r.ins_ok THEN
      RAISE EXCEPTION 'PROOF FAILED [%]: could not start an import', _who;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: the owner and the office manager read, start, change and delete their imports';
END $$;

-- ── 3. A turned-off office manager is turned off here too ────────────────
INSERT INTO public.staff (organization_id, user_id, role, display_name, active) VALUES
  ('05710000-0000-4000-8000-0000000000aa', 'a5710000-0000-4000-8000-0000000000a2',
   'office_manager', 'Proof Office', false);
DO $$
DECLARE _r record;
BEGIN
  PERFORM pg_temp.as_user('a5710000-0000-4000-8000-0000000000a2');
  SET LOCAL ROLE authenticated;
  SELECT * INTO _r FROM pg_temp.reach();
  RESET ROLE;
  IF _r.seen_rows <> 0 OR _r.seen_batches <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [inactive]: a turned-off office manager read the import';
  END IF;
  RAISE NOTICE 'ok: a turned-off office manager reads no import rows';
END $$;

ROLLBACK;
