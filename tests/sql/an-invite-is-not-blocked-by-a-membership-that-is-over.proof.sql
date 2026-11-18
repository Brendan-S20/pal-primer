-- Proof for 20261118030000: an invited technician is not blocked by a membership that is
-- over (#982). Reproduces the bug on 20261109180000's function first, then
-- applies the fix. One transaction, ROLLED BACK. "ok: ..." or "PROOF FAILED".
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- A  the inviting business, with its owner.
-- B  a live business that turned person 2 off (staff inactive, role row left).
-- C  a business that was deleted; person 3 still has a role row in it.
-- D  a live business where person 4 is ON (user_roles_one_org_per_user_idx
--    means an account has at most one membership row).
-- Every account is older than its invitation (they are being invited, not new).
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at)
SELECT ('f0000000-0000-4000-8000-000000982a0' || n)::uuid, 'p' || n || '@dead.proof.invalid',
       jsonb_build_object('display_name', 'Person ' || n), now() - interval '100 days'
  FROM generate_series(1, 4) n;
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000982a0a', 'Dead Proof A', 'America/Detroit'),
  ('0a000000-0000-4000-8000-000000982a0b', 'Dead Proof B', 'America/Detroit'),
  ('0a000000-0000-4000-8000-000000982a0c', 'Dead Proof C', 'America/Detroit'),
  ('0a000000-0000-4000-8000-000000982a0d', 'Dead Proof D', 'America/Detroit');
UPDATE public.organizations SET deleted_at = now() WHERE id = '0a000000-0000-4000-8000-000000982a0c';
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000982a01', '0a000000-0000-4000-8000-000000982a0a', 'owner'),
  ('f0000000-0000-4000-8000-000000982a02', '0a000000-0000-4000-8000-000000982a0b', 'tech'),
  ('f0000000-0000-4000-8000-000000982a03', '0a000000-0000-4000-8000-000000982a0c', 'tech'),
  ('f0000000-0000-4000-8000-000000982a04', '0a000000-0000-4000-8000-000000982a0d', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (organization_id, user_id, role, display_name, active) VALUES
  ('0a000000-0000-4000-8000-000000982a0a', 'f0000000-0000-4000-8000-000000982a01', 'owner', 'Owner', true),
  ('0a000000-0000-4000-8000-000000982a0b', 'f0000000-0000-4000-8000-000000982a02', 'tech', 'Person 2', false),
  ('0a000000-0000-4000-8000-000000982a0c', 'f0000000-0000-4000-8000-000000982a03', 'tech', 'Person 3', true),
  ('0a000000-0000-4000-8000-000000982a0d', 'f0000000-0000-4000-8000-000000982a04', 'tech', 'Person 4', true);
INSERT INTO public.org_invites (organization_id, email, role, token, created_at)
SELECT '0a000000-0000-4000-8000-000000982a0a', 'p' || n || '@dead.proof.invalid', 'tech', 'dead-proof-' || n, now()
  FROM generate_series(2, 4) n;

CREATE FUNCTION pg_temp.as_user(_n int) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', 'f0000000-0000-4000-8000-000000982a0' || _n, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;
-- accept as person _n by link: returns 'joined' or the refusal text.
CREATE FUNCTION pg_temp.accept(_n int) RETURNS text LANGUAGE plpgsql AS $$
DECLARE _org uuid;
BEGIN
  PERFORM pg_temp.as_user(_n);
  SET LOCAL ROLE authenticated;
  BEGIN
    _org := public.accept_org_invite_for_current_user('dead-proof-' || _n);
  EXCEPTION WHEN raise_exception THEN
    RESET ROLE;
    RETURN SQLERRM;
  END;
  RESET ROLE;
  RETURN CASE WHEN _org = '0a000000-0000-4000-8000-000000982a0a' THEN 'joined' ELSE 'other: ' || coalesce(_org::text, 'null') END;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(int), pg_temp.accept(int) TO authenticated;

SAVEPOINT fixture;

-- ── 1. The bug, reproduced on 20261109180000's function ────────────────────
\ir ../../supabase/migrations/20261109180000_a-removed-teammate-can-be-invited-back.sql
DO $$
DECLARE _r2 text := pg_temp.accept(2); _r3 text := pg_temp.accept(3);
BEGIN
  IF _r2 NOT LIKE 'This account already belongs to another organization%'
     OR _r3 NOT LIKE 'This account already belongs to another organization%' THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [reproduce]: the old function gave "%" / "%"', _r2, _r3;
  END IF;
  RAISE NOTICE 'ok: reproduced: a turned-off member and a member of a deleted business are both refused';
END $$;
ROLLBACK TO SAVEPOINT fixture;

-- ── 2. The fix ──────────────────────────────────────────────────────────────
\ir ../../supabase/migrations/20261118030000_an-invite-is-not-blocked-by-a-membership-that-is-over.sql
DO $$
DECLARE _r text;
BEGIN
  _r := pg_temp.accept(2);
  IF _r <> 'joined' THEN RAISE EXCEPTION 'PROOF FAILED [turned off]: %', _r; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000982a02'
                AND organization_id = '0a000000-0000-4000-8000-000000982a0b') THEN
    RAISE EXCEPTION 'PROOF FAILED [turned off]: the dead membership is still there';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff WHERE user_id = 'f0000000-0000-4000-8000-000000982a02'
                    AND organization_id = '0a000000-0000-4000-8000-000000982a0b' AND NOT active) THEN
    RAISE EXCEPTION 'PROOF FAILED [turned off]: the old staff row did not stay';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE organization_id = '0a000000-0000-4000-8000-000000982a0b'
                    AND kind = 'staff.left') THEN
    RAISE EXCEPTION 'PROOF FAILED [turned off]: the business that turned them off was not told';
  END IF;
  IF (SELECT count(*) FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000982a02') <> 1
     OR NOT EXISTS (SELECT 1 FROM public.staff WHERE user_id = 'f0000000-0000-4000-8000-000000982a02'
                       AND organization_id = '0a000000-0000-4000-8000-000000982a0a' AND active) THEN
    RAISE EXCEPTION 'PROOF FAILED [turned off]: not exactly one membership and an active staff row in the new business';
  END IF;
  RAISE NOTICE 'ok: a member who was turned off elsewhere joins; the old membership goes, its staff row stays, the old business is told';

  _r := pg_temp.accept(3);
  IF _r <> 'joined' THEN RAISE EXCEPTION 'PROOF FAILED [deleted business]: %', _r; END IF;
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000982a03'
                AND organization_id = '0a000000-0000-4000-8000-000000982a0c') THEN
    RAISE EXCEPTION 'PROOF FAILED [deleted business]: the membership in the deleted business is still there';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activity_log WHERE organization_id = '0a000000-0000-4000-8000-000000982a0c') THEN
    RAISE EXCEPTION 'PROOF FAILED [deleted business]: a deleted business was written to';
  END IF;
  RAISE NOTICE 'ok: a member of a DELETED business joins, and the deleted business is not written to';

  _r := pg_temp.accept(4);
  IF _r NOT LIKE 'This account already belongs to another organization%' THEN
    RAISE EXCEPTION 'PROOF FAILED [really belongs]: got "%"', _r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000982a04'
                    AND organization_id = '0a000000-0000-4000-8000-000000982a0d') THEN
    RAISE EXCEPTION 'PROOF FAILED [really belongs]: a refused person lost their membership';
  END IF;
  RAISE NOTICE 'ok: somebody who is really on another live business is still refused, same message, nothing deleted';
END $$;

ROLLBACK;
\echo ALL DEAD-MEMBERSHIP INVITE PROOFS PASSED
