-- #1001: a signed-in user of any business can no longer read the platform's
-- own tables, proved against a real Postgres. Run by
-- tests/a-signed-in-business-cannot-read-the-platforms-own-tables.test.ts,
-- which passes :migration (20261123200000_...). The migration is applied only
-- where the database does not have it yet (the shared stack follows main).
-- Everything runs in one transaction that is ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

SELECT NOT EXISTS (
  SELECT 1 FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'platform_feature_flags'
     AND policyname = 'platform admins read flag catalog'
) AS need_mig \gset
\if :need_mig
\i :migration
\endif

-- ── Fixture ───────────────────────────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{}', true) \gset
INSERT INTO auth.users (id, email) VALUES
  ('f1001000-0000-4000-8000-000000000a01', 'owner@platform-tables.proof.invalid'),
  ('f1001000-0000-4000-8000-000000000f01', 'admin@platform-tables.proof.invalid');
INSERT INTO public.platform_admins (user_id) VALUES ('f1001000-0000-4000-8000-000000000f01');
INSERT INTO public.platform_addons (id, slug, name, price_cents, is_active, status) VALUES
  ('a1001000-0000-4000-8000-000000000001', 'proof-live', 'Proof live add-on', 1000, true, 'active'),
  ('a1001000-0000-4000-8000-000000000002', 'proof-off', 'Proof retired add-on', 1000, false, 'disabled');
INSERT INTO public.platform_feature_flags (key, label) VALUES ('proof_flag_1001', 'Proof flag');
UPDATE public.platform_referral_settings SET reward_percent = reward_percent;

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
$$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(text) TO authenticated;

-- ── 1. A signed-in non-admin ──────────────────────────────────────────────
SET LOCAL ROLE authenticated;
SELECT pg_temp.as_user('f1001000-0000-4000-8000-000000000a01');
DO $$
DECLARE _live int; _off int; _all int; _n int;
BEGIN
  SELECT count(*) INTO _live FROM public.platform_addons WHERE slug = 'proof-live';
  SELECT count(*) INTO _off  FROM public.platform_addons WHERE slug = 'proof-off';
  SELECT count(*) INTO _all  FROM public.platform_addons WHERE NOT is_active;
  IF _live <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [addons]: a non-admin cannot read an active add-on (%)', _live; END IF;
  IF _off <> 0 OR _all <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [addons]: a non-admin reads % inactive add-on(s)', _all; END IF;
  RAISE NOTICE 'ok: a signed-in non-admin reads active add-ons and no inactive one';

  SELECT count(*) INTO _n FROM public.platform_referral_settings;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [referral]: a non-admin reads % referral settings row(s)', _n; END IF;
  RAISE NOTICE 'ok: a signed-in non-admin reads no referral settings';

  SELECT count(*) INTO _n FROM public.platform_feature_flags;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [flags]: a non-admin reads % feature flag(s)', _n; END IF;
  RAISE NOTICE 'ok: a signed-in non-admin reads no feature flags';
END $$;

-- ── 2. A platform admin still reads everything ────────────────────────────
SELECT pg_temp.as_user('f1001000-0000-4000-8000-000000000f01');
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.platform_addons WHERE slug IN ('proof-live', 'proof-off');
  IF _n <> 2 THEN RAISE EXCEPTION 'PROOF FAILED [admin]: an admin reads % of 2 proof add-ons', _n; END IF;
  SELECT count(*) INTO _n FROM public.platform_referral_settings;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [admin]: an admin reads % referral settings row(s)', _n; END IF;
  SELECT count(*) INTO _n FROM public.platform_feature_flags WHERE key = 'proof_flag_1001';
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [admin]: an admin cannot read the flag catalog'; END IF;
  RAISE NOTICE 'ok: a platform admin reads every add-on, the referral settings and the flag catalog';
END $$;
RESET ROLE;

-- ── 3. The server (service role) reads everything: every page that uses them
SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true) \gset
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.platform_addons WHERE slug IN ('proof-live', 'proof-off');
  IF _n <> 2 THEN RAISE EXCEPTION 'PROOF FAILED [server]: the service role reads % of 2 proof add-ons', _n; END IF;
  SELECT count(*) INTO _n FROM public.platform_referral_settings;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [server]: the service role reads % referral settings row(s)', _n; END IF;
  SELECT count(*) INTO _n FROM public.platform_feature_flags WHERE key = 'proof_flag_1001';
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [server]: the service role cannot read the flag catalog'; END IF;
  RAISE NOTICE 'ok: the service role (every server function) still reads all three tables whole';
END $$;
RESET ROLE;

-- ── 4. Nothing else reads them as the caller ──────────────────────────────
-- A database function that reads these tables and is not SECURITY DEFINER
-- would silently see nothing for a tenant. Today there is none.
DO $$
DECLARE _bad text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO _bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND NOT p.prosecdef
     AND p.prosrc ~* 'platform_addons|platform_referral_settings|platform_feature_flags';
  IF _bad IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [functions]: invoker function(s) read the platform tables: %', _bad; END IF;
  RAISE NOTICE 'ok: every database function that reads the three tables runs as its owner';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL PLATFORM TABLE PROOFS PASSED'; END $$;
ROLLBACK;
