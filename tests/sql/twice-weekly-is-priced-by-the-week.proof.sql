-- Twice-weekly was billed at 3.6x the weekly plan (#572, F-07), proved
-- against a real Postgres. Run by
-- tests/twice-weekly-is-priced-by-the-week-in-a-real-database.test.ts, which
-- passes
--   :migration  20261029120000_twice-weekly-is-priced-by-the-week.sql
--
-- The fixture is written BEFORE the migration, with the shipped map spelled
-- out, so the "before" quotes are the fault as production has it whatever the
-- stack's column default is. The migration is idempotent and is applied here
-- inside the transaction, which is ROLLED BACK at the end. Each group prints
-- "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]", and ON_ERROR_STOP turns that into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── Fixture ───────────────────────────────────────────────────────────────
-- T is on the shipped map, as every organization in production is. U had its
-- twice-weekly set by hand to 0.75; the migration leaves it alone. Both sell
-- pet waste from a public signup page, $25 a weekly visit for one dog.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5720000-0000-4000-8000-0000000000a1', 'owner-t@twice-weekly.proof.invalid'),
  ('a5720000-0000-4000-8000-0000000000a2', 'tech-t@twice-weekly.proof.invalid');
INSERT INTO public.organizations (id, name, slug, timezone, public_signup_enabled, currency, frequency_multipliers) VALUES
  ('05720000-0000-4000-8000-0000000000aa', 'Twice Weekly Proof T', 'twice-weekly-proof-t', 'America/Detroit', true, 'usd',
   '{"weekly":1.0,"biweekly":1.7,"twice_weekly":1.8,"monthly":3.2}'),
  ('05720000-0000-4000-8000-0000000000bb', 'Twice Weekly Proof U', 'twice-weekly-proof-u', 'America/Detroit', true, 'usd',
   '{"weekly":1.0,"biweekly":1.7,"twice_weekly":0.75,"monthly":3.2}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5720000-0000-4000-8000-0000000000a1', '05720000-0000-4000-8000-0000000000aa', 'owner'),
  ('a5720000-0000-4000-8000-0000000000a2', '05720000-0000-4000-8000-0000000000aa', 'tech');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents) VALUES
  ('25720000-0000-4000-8000-0000000000a1', '05720000-0000-4000-8000-0000000000aa', 'T Zone', ARRAY['48009'], 2500, 500, 0),
  ('25720000-0000-4000-8000-0000000000b1', '05720000-0000-4000-8000-0000000000bb', 'U Zone', ARRAY['48009'], 2500, 500, 0);

-- ── Before: the fault, measured ───────────────────────────────────────────
DO $$
DECLARE _w integer; _t integer;
BEGIN
  SELECT recurring_price_cents INTO _w FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'weekly');
  SELECT recurring_price_cents INTO _t FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'twice_weekly');
  IF _w IS DISTINCT FROM 2500 OR _t IS DISTINCT FROM 4500 THEN
    RAISE EXCEPTION 'PROOF FAILED [before]: weekly % / twice-weekly % a visit, expected 2500 / 4500', _w, _t;
  END IF;
  RAISE NOTICE 'ok: before the fix, twice-weekly quotes $45.00 a visit, $90.00 a week, 3.6x the $25.00 weekly plan';
END $$;

\i :migration

-- ── 1. public_quote: twice-weekly is 1.8x the weekly plan for the week ────
DO $$
DECLARE _w integer; _t integer; _w4 integer; _t4 integer; _b integer; _m integer;
BEGIN
  SELECT recurring_price_cents INTO _w FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'weekly');
  SELECT recurring_price_cents INTO _t FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'twice_weekly');
  IF _w <> 2500 OR _t <> 2250 OR 2 * _t <> round(1.8 * _w) THEN
    RAISE EXCEPTION 'PROOF FAILED [public_quote]: weekly % / twice-weekly % a visit', _w, _t;
  END IF;
  -- Four dogs: $25 + 3 x $5 = $40 a weekly visit, $36 a twice-weekly one.
  SELECT recurring_price_cents INTO _w4 FROM public.public_quote('twice-weekly-proof-t', '48009', 4, 'weekly');
  SELECT recurring_price_cents INTO _t4 FROM public.public_quote('twice-weekly-proof-t', '48009', 4, 'twice_weekly');
  IF _w4 <> 4000 OR _t4 <> 3600 OR 2 * _t4 > 2 * _w4 THEN
    RAISE EXCEPTION 'PROOF FAILED [public_quote]: four dogs weekly % / twice-weekly %', _w4, _t4;
  END IF;
  -- Biweekly and monthly are what they were.
  SELECT recurring_price_cents INTO _b FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'biweekly');
  SELECT recurring_price_cents INTO _m FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'monthly');
  IF _b <> 4250 OR _m <> 8000 THEN
    RAISE EXCEPTION 'PROOF FAILED [public_quote]: biweekly % / monthly % moved', _b, _m;
  END IF;
  RAISE NOTICE 'ok: public_quote prices twice-weekly at $22.50 a visit, $45.00 a week (1.8x weekly), and biweekly and monthly as before';
END $$;

-- ── 2. The data and the default ───────────────────────────────────────────
DO $$
DECLARE _t jsonb; _u jsonb; _def jsonb;
BEGIN
  SELECT frequency_multipliers INTO _t FROM public.organizations WHERE id = '05720000-0000-4000-8000-0000000000aa';
  SELECT frequency_multipliers INTO _u FROM public.organizations WHERE id = '05720000-0000-4000-8000-0000000000bb';
  IF (_t ->> 'twice_weekly')::numeric <> 0.9 OR (_t ->> 'biweekly')::numeric <> 1.7
     OR (_t ->> 'monthly')::numeric <> 3.2 OR (_t ->> 'weekly')::numeric <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [data]: T is %', _t;
  END IF;
  IF (_u ->> 'twice_weekly')::numeric <> 0.75 THEN
    RAISE EXCEPTION 'PROOF FAILED [data]: a hand-set value was changed: %', _u;
  END IF;
  INSERT INTO public.organizations (id, name, slug, timezone)
    VALUES ('05720000-0000-4000-8000-0000000000cc', 'Twice Weekly Proof V', 'twice-weekly-proof-v', 'America/Detroit')
    RETURNING frequency_multipliers INTO _def;
  IF _def <> '{"weekly":1.0,"biweekly":1.7,"twice_weekly":0.9,"monthly":3.2}'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [data]: a new organization starts with %', _def;
  END IF;
  RAISE NOTICE 'ok: the shipped 1.8 is now 0.9, a hand-set value is left alone, and a new business starts at 0.9';
END $$;

-- ── 3. The owner's write ──────────────────────────────────────────────────
DO $$
DECLARE _err text; _t jsonb;
BEGIN
  -- The owner.
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a5720000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
  PERFORM public.update_org_frequency_multipliers('05720000-0000-4000-8000-0000000000aa', 1.5, 0.95, 3);
  SELECT frequency_multipliers INTO _t FROM public.organizations WHERE id = '05720000-0000-4000-8000-0000000000aa';
  IF (_t ->> 'weekly')::numeric <> 1 OR (_t ->> 'biweekly')::numeric <> 1.5
     OR (_t ->> 'twice_weekly')::numeric <> 0.95 OR (_t ->> 'monthly')::numeric <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the owner saved %', _t;
  END IF;
  IF (SELECT recurring_price_cents FROM public.public_quote('twice-weekly-proof-t', '48009', 1, 'twice_weekly')) <> 2375 THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: the public quote did not follow the owner''s value';
  END IF;

  -- More than the weekly price a visit is refused.
  BEGIN
    PERFORM public.update_org_frequency_multipliers('05720000-0000-4000-8000-0000000000aa', 1.7, 1.8, 3.2);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%twice-weekly%' THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: twice-weekly 1.8 a visit was %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    PERFORM public.update_org_frequency_multipliers('05720000-0000-4000-8000-0000000000aa', 0, 0.9, 3.2);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [write]: a zero biweekly was accepted'; END IF;

  -- A technician, and an owner of another business, cannot.
  _err := NULL;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a5720000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
  BEGIN
    PERFORM public.update_org_frequency_multipliers('05720000-0000-4000-8000-0000000000aa', 1.7, 0.5, 3.2);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [write]: a technician changed the prices'; END IF;
  _err := NULL;
  PERFORM set_config('request.jwt.claims',
    '{"sub":"a5720000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
  BEGIN
    PERFORM public.update_org_frequency_multipliers('05720000-0000-4000-8000-0000000000bb', 1.7, 0.5, 3.2);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [write]: T''s owner changed U''s prices'; END IF;
  PERFORM set_config('request.jwt.claims', '{}', true);

  IF has_function_privilege('anon', 'public.update_org_frequency_multipliers(uuid, numeric, numeric, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [write]: anon can call update_org_frequency_multipliers';
  END IF;
  RAISE NOTICE 'ok: the owner sets each cadence, the public quote follows it, twice-weekly above 1 a visit is refused, and only that business''s owner or office manager can write';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL TWICE-WEEKLY PROOFS PASSED'; END $$;
ROLLBACK;
