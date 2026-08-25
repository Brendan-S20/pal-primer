-- Proof for 20260825060000 — the technician column-write guard.
--
-- Six assertions. The last one is the important one: it DROPS the trigger and
-- shows the exploit succeeding, then puts it back. A test that only shows the
-- fix working cannot tell you the fix is what did it.
--
-- Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f prove-s1.sql

\set ON_ERROR_STOP on
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
-- The blocks below read this while acting as `authenticated`, which does not
-- own it.
GRANT SELECT ON _ids TO authenticated;

DO $$
DECLARE
  _org uuid; _owner uuid; _tech uuid; _staff uuid;
  _cliA uuid; _cliB uuid; _propA uuid; _propB uuid; _subA uuid; _visit uuid;
BEGIN
  -- Creating an organization fires trg_reassign_billing_tier, which UPDATEs
  -- organizations, which tg_orgs_protect_platform_columns refuses outside the
  -- platform path. That guard has its own sanctioned escape hatch, so use it
  -- rather than disabling triggers wholesale — suppressing triggers would also
  -- have disabled the one this file exists to test, and every assertion below
  -- would have passed for the wrong reason.
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'owner@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _owner;

  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', 'tech@proof.invalid', '', now(), now(), now())
  RETURNING id INTO _tech;

  INSERT INTO public.organizations (name) VALUES ('Proof Pet Waste') RETURNING id INTO _org;

  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_tech,  _org, 'tech');

  INSERT INTO public.staff (organization_id, user_id, role, display_name)
  VALUES (_org, _tech, 'tech', 'Proof Tech') RETURNING id INTO _staff;

  -- The technician's own customer, and the victim.
  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES (_org, 'residential', 'Client A (the tech''s own)') RETURNING id INTO _cliA;
  INSERT INTO public.clients (organization_id, account_type, display_name)
  VALUES (_org, 'residential', 'Client B (the victim)') RETURNING id INTO _cliB;

  INSERT INTO public.properties (client_id, organization_id, street, city, postal_code)
  VALUES (_cliA, _org, '1 A Street', 'Detroit', '48201') RETURNING id INTO _propA;
  INSERT INTO public.properties (client_id, organization_id, street, city, postal_code)
  VALUES (_cliB, _org, '2 B Street', 'Detroit', '48202') RETURNING id INTO _propB;

  -- subscriptions_account_shape_chk: residential needs dog_count and no
  -- unit_count; commercial is the mirror image.
  INSERT INTO public.subscriptions (organization_id, client_id, property_id, account_type,
                                    frequency, price_cents, dog_count)
  VALUES (_org, _cliA, _propA, 'residential', 'weekly', 2500, 2) RETURNING id INTO _subA;

  INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id,
                             assigned_staff_id, scheduled_on, status)
  VALUES (_org, _subA, _cliA, _propA, _staff, CURRENT_DATE, 'scheduled')
  RETURNING id INTO _visit;

  INSERT INTO _ids VALUES ('org',_org),('owner',_owner),('tech',_tech),('staff',_staff),
                          ('cliA',_cliA),('cliB',_cliB),('propA',_propA),('propB',_propB),
                          ('visit',_visit);

  -- Hatch closed. Everything below runs against the real thing.
  PERFORM set_config('app.allow_protected_org_write', '', true);
END $$;

-- The guard on the guard. If the fixture left that hatch open, or left triggers
-- suppressed some other way, every assertion below would pass and mean nothing.
DO $$
BEGIN
  IF COALESCE(current_setting('app.allow_protected_org_write', true), '') = '1' THEN
    RAISE EXCEPTION 'the platform-write hatch is still open — this run would prove nothing';
  END IF;
  IF current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'triggers are suppressed — this run would prove nothing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass
       AND tgname = 'visits_guard_privileged_columns'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'the trigger under test is absent or disabled — this run would prove nothing';
  END IF;
END $$;

-- Become the technician: the `authenticated` ROLE, so grants and RLS apply the
-- way they do for a real session, plus auth.uid() = that user.
CREATE OR REPLACE FUNCTION pg_temp.be(_who text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _u uuid;
BEGIN
  IF _who = 'service' THEN
    PERFORM set_config('role', 'postgres', true);
    PERFORM set_config('request.jwt.claims', NULL, true);
    RETURN;
  END IF;
  SELECT v INTO _u FROM _ids WHERE k = _who;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', _u, 'role','authenticated')::text, true);
  PERFORM set_config('role', 'authenticated', true);
END $$;

-- ── 1. THE EXPLOIT: tech repoints their own visit at the victim ───────────
DO $$
DECLARE _v uuid; _b uuid; _ok boolean := false;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  SELECT v INTO _b FROM _ids WHERE k='cliB';
  PERFORM pg_temp.be('tech');
  BEGIN
    UPDATE public.visits SET client_id = _b WHERE id = _v;
  EXCEPTION WHEN insufficient_privilege THEN
    _ok := true;
    RAISE NOTICE '1 PASS  exploit blocked: %', SQLERRM;
  END;
  IF NOT _ok THEN RAISE EXCEPTION '1 FAIL  the tech repointed the visit at another customer'; END IF;
END $$;

-- ── 2. NORMAL WORK: the tech completes their visit ────────────────────────
DO $$
DECLARE _v uuid; _st text;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  PERFORM pg_temp.be('tech');
  UPDATE public.visits
     SET status = 'completed', completed_at = now(), started_at = now(),
         travel_km = 4.2, station_count_serviced = 1
   WHERE id = _v;
  SELECT status::text INTO _st FROM public.visits WHERE id = _v;
  IF _st <> 'completed' THEN RAISE EXCEPTION '2 FAIL  completion did not stick (status=%)', _st; END IF;
  RAISE NOTICE '2 PASS  ordinary completion still works (status=%)', _st;
  UPDATE public.visits SET status='scheduled', completed_at=NULL WHERE id=_v;
END $$;

-- ── 3. THE MONEY COLUMNS ─────────────────────────────────────────────────
DO $$
DECLARE _v uuid; _ok boolean := false;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  PERFORM pg_temp.be('tech');
  BEGIN
    UPDATE public.visits SET skip_billable = true, skip_charge_cents = 99999 WHERE id = _v;
  EXCEPTION WHEN insufficient_privilege THEN
    _ok := true; RAISE NOTICE '3 PASS  money columns blocked: %', SQLERRM;
  END;
  IF NOT _ok THEN RAISE EXCEPTION '3 FAIL  the tech set their own skip charge'; END IF;
END $$;

-- ── 4. THE OFFICE IS UNAFFECTED ──────────────────────────────────────────
DO $$
DECLARE _v uuid; _b uuid; _pb uuid; _got uuid;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  SELECT v INTO _b FROM _ids WHERE k='cliB';
  SELECT v INTO _pb FROM _ids WHERE k='propB';
  PERFORM pg_temp.be('owner');
  UPDATE public.visits SET client_id = _b, property_id = _pb WHERE id = _v;
  SELECT client_id INTO _got FROM public.visits WHERE id = _v;
  IF _got <> _b THEN RAISE EXCEPTION '4 FAIL  the owner could not reassign the visit'; END IF;
  RAISE NOTICE '4 PASS  owner may still move a visit between customers';
END $$;

-- ── 5. SERVICE ROLE / CRON IS UNAFFECTED ─────────────────────────────────
DO $$
DECLARE _v uuid; _a uuid; _pa uuid; _got uuid;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  SELECT v INTO _a FROM _ids WHERE k='cliA';
  SELECT v INTO _pa FROM _ids WHERE k='propA';
  PERFORM pg_temp.be('service');
  UPDATE public.visits SET client_id = _a, property_id = _pa, deepclean_charge_cents = 4900
   WHERE id = _v;
  SELECT client_id INTO _got FROM public.visits WHERE id = _v;
  IF _got <> _a THEN RAISE EXCEPTION '5 FAIL  a no-JWT caller was blocked'; END IF;
  RAISE NOTICE '5 PASS  service-role / cron writes are unaffected';
END $$;

-- ── 6. MUTATION: without the trigger, the exploit works ──────────────────
DO $$
DECLARE _v uuid; _b uuid; _got uuid;
BEGIN
  SELECT v INTO _v FROM _ids WHERE k='visit';
  SELECT v INTO _b FROM _ids WHERE k='cliB';
  ALTER TABLE public.visits DISABLE TRIGGER visits_guard_privileged_columns;
  PERFORM pg_temp.be('tech');
  UPDATE public.visits SET client_id = _b WHERE id = _v;
  SELECT client_id INTO _got FROM public.visits WHERE id = _v;
  PERFORM pg_temp.be('service');
  ALTER TABLE public.visits ENABLE TRIGGER visits_guard_privileged_columns;
  IF _got <> _b THEN
    RAISE EXCEPTION '6 INCONCLUSIVE  the exploit did not reproduce with the guard off — this test proves nothing';
  END IF;
  RAISE NOTICE '6 PASS  with the guard disabled the tech DID repoint the visit — the trigger is what stops it';
END $$;

ROLLBACK;
