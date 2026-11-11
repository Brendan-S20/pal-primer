-- A turned-off teammate can leave and start their own business (#765),
-- proved against a real Postgres. Run by
-- tests/a-turned-off-teammate-can-start-their-own-business.test.ts with
-- :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- The whole of what Tester did on 3a028504, in the database: an owner
-- removes a technician (Deactivate, the only removal Settings -> Users has),
-- and the same email then signs up fresh and lands in a NEW workspace of its
-- own, while the old business keeps everything it had.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- A business with an owner, a technician who will be removed, a second
-- technician who stays on, and a client the business owns.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at) VALUES
  ('f0000000-0000-4000-8000-000000765b01', 'owner@leave.proof.invalid', '{}', now() - interval '200 days'),
  ('f0000000-0000-4000-8000-000000765b02', 'removed@leave.proof.invalid', '{"display_name": "Ray Removed"}', now() - interval '100 days'),
  ('f0000000-0000-4000-8000-000000765b03', 'stays@leave.proof.invalid', '{}', now() - interval '100 days');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000765b00', 'Leave Proof Co', 'America/Detroit');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000765b01', '0a000000-0000-4000-8000-000000765b00', 'owner'),
  ('f0000000-0000-4000-8000-000000765b02', '0a000000-0000-4000-8000-000000765b00', 'tech'),
  ('f0000000-0000-4000-8000-000000765b03', '0a000000-0000-4000-8000-000000765b00', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000765b01', '0a000000-0000-4000-8000-000000765b00',
   'f0000000-0000-4000-8000-000000765b01', 'owner', 'Owner', true),
  ('5a000000-0000-4000-8000-000000765b02', '0a000000-0000-4000-8000-000000765b00',
   'f0000000-0000-4000-8000-000000765b02', 'tech', 'Ray Removed', true),
  ('5a000000-0000-4000-8000-000000765b03', '0a000000-0000-4000-8000-000000765b00',
   'f0000000-0000-4000-8000-000000765b03', 'tech', 'Stays On', true);
INSERT INTO public.clients (id, organization_id, display_name, account_type) VALUES
  ('c1000000-0000-4000-8000-000000765b01', '0a000000-0000-4000-8000-000000765b00', 'Leave Proof Client', 'residential');

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── Somebody who is ON cannot use it ───────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765b03');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.leave_business_i_was_turned_off_in();
  RAISE EXCEPTION 'PROOF FAILED [on]: a technician who is on left the business this way';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: somebody who is on is refused, and keeps their membership';
END $$;
RESET ROLE;

-- ── The owner removes the technician (Deactivate) ──────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765b01');
SET LOCAL ROLE authenticated;
SELECT public.set_staff_active('5a000000-0000-4000-8000-000000765b02', false);
RESET ROLE;

-- Before leaving, the removed person's own sign-up is handed back the old
-- business: this is the lockout Tester hit.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765b02');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _got uuid;
BEGIN
  _got := public.bootstrap_organization('Ray''s Pet Waste Removal', 'Ray Removed');
  IF _got IS DISTINCT FROM '0a000000-0000-4000-8000-000000765b00'::uuid THEN
    RAISE EXCEPTION 'PROOF FAILED [premise]: expected the turned-off membership to block a new business, got %', _got;
  END IF;
  RAISE NOTICE 'ok: premise holds: while the membership stands, signing up hands back the old business';
END $$;

-- ── The removed technician leaves, then signs up fresh ─────────────────────
DO $$
DECLARE _left uuid; _new uuid;
BEGIN
  _left := public.leave_business_i_was_turned_off_in();
  IF _left IS DISTINCT FROM '0a000000-0000-4000-8000-000000765b00'::uuid THEN
    RAISE EXCEPTION 'PROOF FAILED [leave]: left % instead of the business that turned them off', _left;
  END IF;

  _new := public.bootstrap_organization('Ray''s Pet Waste Removal', 'Ray Removed');
  IF _new IS NULL OR _new = '0a000000-0000-4000-8000-000000765b00'::uuid THEN
    RAISE EXCEPTION 'PROOF FAILED [new workspace]: sign-up returned %, not a new business', _new;
  END IF;
  PERFORM set_config('proof.new_org', _new::text, true);
  RAISE NOTICE 'ok: the same account leaves and signs up into a brand-new workspace';
END $$;
RESET ROLE;

DO $$
DECLARE
  _new uuid := current_setting('proof.new_org')::uuid;
  _n int;
BEGIN
  -- In the new business, as its owner, and nowhere else.
  SELECT count(*) INTO _n FROM public.user_roles
   WHERE user_id = 'f0000000-0000-4000-8000-000000765b02';
  IF _n <> 1 OR NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = 'f0000000-0000-4000-8000-000000765b02'
       AND organization_id = _new AND role = 'owner') THEN
    RAISE EXCEPTION 'PROOF FAILED [new workspace]: % memberships, not one as owner of the new business', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = _new AND name = 'Ray''s Pet Waste Removal') THEN
    RAISE EXCEPTION 'PROOF FAILED [new workspace]: the new business was not created under the typed name';
  END IF;
  RAISE NOTICE 'ok: they land in the new workspace as its owner, with one membership';

  -- The old business keeps everything: its staff row (off), its other
  -- people, its client, and a line in its own timeline.
  IF NOT EXISTS (SELECT 1 FROM public.staff
                  WHERE id = '5a000000-0000-4000-8000-000000765b02' AND NOT active
                    AND user_id = 'f0000000-0000-4000-8000-000000765b02') THEN
    RAISE EXCEPTION 'PROOF FAILED [old business]: the removed person''s staff row is gone or changed';
  END IF;
  SELECT count(*) INTO _n FROM public.user_roles WHERE organization_id = '0a000000-0000-4000-8000-000000765b00';
  IF _n <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [old business]: % memberships left, expected owner + the technician who stays', _n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE id = 'c1000000-0000-4000-8000-000000765b01'
                    AND organization_id = '0a000000-0000-4000-8000-000000765b00') THEN
    RAISE EXCEPTION 'PROOF FAILED [old business]: its client was touched';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log
                  WHERE organization_id = '0a000000-0000-4000-8000-000000765b00'
                    AND kind = 'staff.left') THEN
    RAISE EXCEPTION 'PROOF FAILED [old business]: nothing in its timeline says the person left';
  END IF;
  RAISE NOTICE 'ok: the old business keeps the staff row, its people, its client, and logs the leaving';
END $$;

-- ── The new owner cannot see the old business ──────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000765b02');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.clients WHERE organization_id = '0a000000-0000-4000-8000-000000765b00')
     OR EXISTS (SELECT 1 FROM public.access_turned_off()) THEN
    RAISE EXCEPTION 'PROOF FAILED [isolation]: the person who left can still see the old business';
  END IF;
  RAISE NOTICE 'ok: the old business is not visible from the new workspace';
END $$;
RESET ROLE;

ROLLBACK;
\echo ALL TURNED-OFF-TEAMMATE PROOFS PASSED
