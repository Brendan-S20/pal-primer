-- Proof for 20261124130000: the owner sets the directory contact (#1002).
-- Run by tests/an-owner-publishes-a-contact-from-settings.test.ts with :migration.
-- One transaction, ROLLED BACK. Each check prints "ok: ..." or "PROOF FAILED".
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone, service_lines, contact_email, contact_phone)
SELECT ('10020000-0000-4000-8000-0000000000' || k)::uuid, 'Owner Contact Proof ' || k || ' (TEST)', 'UTC', '{dog_walking}',
       'account-' || k || '@ownercontact.proof.invalid', '+13135551002'
  FROM unnest(ARRAY['aa', 'bb']) k;
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.directory_profiles (organization_id, slug, published, display_name, coverage_zips, service_lines, published_at)
VALUES ('10020000-0000-4000-8000-0000000000aa', 'owner-contact-proof-aa', true, 'Owner Contact Proof aa (TEST)', ARRAY['48201'], ARRAY['dog_walking'], now()),
       ('10020000-0000-4000-8000-0000000000bb', 'owner-contact-proof-bb', true, 'Owner Contact Proof bb (TEST)', ARRAY['48201'], ARRAY['dog_walking'], now());
INSERT INTO auth.users (id, email) VALUES
  ('10020000-0000-4000-8000-0000000000a1', 'owner-a@ownercontact.proof.invalid'),
  ('10020000-0000-4000-8000-0000000000a2', 'staff-a@ownercontact.proof.invalid');
INSERT INTO public.user_roles (user_id, organization_id, role)
VALUES ('10020000-0000-4000-8000-0000000000a1', '10020000-0000-4000-8000-0000000000aa', 'owner'),
       ('10020000-0000-4000-8000-0000000000a2', '10020000-0000-4000-8000-0000000000aa', 'office_manager');

-- The #990 columns this builds on; re-applying that (idempotent) migration is a
-- no-op where they already exist, and supplies them in a scratch DB that lacks them.
\if :{?prereq}
\i :prereq
\endif

\if :{?migration}
\i :migration
\endif

CREATE FUNCTION pg_temp.as_user(_u text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', json_build_object('sub', _u, 'role', 'authenticated')::text, true);
$$;
CREATE FUNCTION pg_temp.refused(_label text, _sql text, _want text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _got text;
BEGIN
  BEGIN EXECUTE _sql; EXCEPTION WHEN OTHERS THEN _got := SQLSTATE; END;
  IF _got IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [%]: it was allowed', _label;
  ELSIF _got <> _want THEN RAISE EXCEPTION 'PROOF FAILED [%]: refused with % (want %)', _label, _got, _want; END IF;
END $$;

SELECT pg_temp.as_user('10020000-0000-4000-8000-0000000000a1');
SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', ' Hi@Pro.example.com ', '+13135550100');
DO $p$
DECLARE _e text; _ph text;
BEGIN
  SELECT public_email, public_phone INTO _e, _ph FROM public.directory_profiles WHERE slug = 'owner-contact-proof-aa';
  IF _e <> 'Hi@Pro.example.com' OR _ph <> '+13135550100' THEN RAISE EXCEPTION 'PROOF FAILED [set]: % %', _e, _ph; END IF;
  RAISE NOTICE 'ok: the owner sets both';
END $p$;

SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', NULL, 'x', true, false);
DO $p$
DECLARE _e text; _ph text;
BEGIN
  SELECT public_email, public_phone INTO _e, _ph FROM public.directory_profiles WHERE slug = 'owner-contact-proof-aa';
  IF _e IS NOT NULL OR _ph <> '+13135550100' THEN RAISE EXCEPTION 'PROOF FAILED [clear one]: % %', _e, _ph; END IF;
  RAISE NOTICE 'ok: clearing one field leaves the other, and a field not asked for is untouched';
END $p$;

SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', '', '   ');
DO $p$
BEGIN
  IF EXISTS (SELECT 1 FROM public.directory_profiles WHERE slug = 'owner-contact-proof-aa' AND (public_email IS NOT NULL OR public_phone IS NOT NULL)) THEN
    RAISE EXCEPTION 'PROOF FAILED [clear]: blank did not clear';
  END IF;
  RAISE NOTICE 'ok: blank clears to NULL';
END $p$;

SELECT pg_temp.refused('bad email', $q$SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', 'nobody', NULL)$q$, '23514');
SELECT pg_temp.refused('bad phone', $q$SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', NULL, '313-CALL')$q$, '23514');
SELECT pg_temp.refused('another business', $q$SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000bb', 'a@b.example', NULL)$q$, '42501');
SELECT pg_temp.as_user('10020000-0000-4000-8000-0000000000a2');
SELECT pg_temp.refused('staff', $q$SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', 'a@b.example', NULL)$q$, '42501');
SELECT set_config('request.jwt.claims', '{}', true);
SELECT pg_temp.refused('signed out', $q$SELECT public.set_directory_public_contact('10020000-0000-4000-8000-0000000000aa', 'a@b.example', NULL)$q$, '42501');
DO $p$ BEGIN RAISE NOTICE 'ok: bad shapes, another business, staff and signed-out callers are refused'; END $p$;

ROLLBACK;
