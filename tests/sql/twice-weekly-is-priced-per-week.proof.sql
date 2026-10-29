-- Twice weekly is priced per week (#572, F-07), proved against a real
-- Postgres rather than read off the migration's text. Run by
-- tests/twice-weekly-is-priced-per-week.proof.test.ts, which passes the
-- migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end with the migration inside it, so a
-- shared local stack is left exactly as it was found. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]"; ON_ERROR_STOP makes the first
-- failure a non-zero exit.
--
-- The fixture is the issue's own example: four dogs in a zone where that is
-- $35.00 a visit weekly ($20 base, $5 for each extra dog).

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

SET LOCAL app.allow_protected_org_write = '1';
-- The column default, and two that an owner could have saved.
INSERT INTO public.organizations (id, name, slug, public_signup_enabled, currency) VALUES
  ('f7000000-0000-4000-8000-0000000000a1', 'Twice Weekly Default', 'tw-proof-default', true, 'usd');
INSERT INTO public.organizations (id, name, slug, public_signup_enabled, currency, frequency_multipliers) VALUES
  ('f7000000-0000-4000-8000-0000000000a2', 'Twice Weekly Custom', 'tw-proof-custom', true, 'usd',
   '{"weekly":1,"biweekly":1.6,"twice_weekly":1.9,"monthly":3}'),
  ('f7000000-0000-4000-8000-0000000000a3', 'Twice Weekly Unset', 'tw-proof-unset', true, 'usd',
   '{"weekly":1}');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents) VALUES
  ('f8000000-0000-4000-8000-0000000000a1', 'f7000000-0000-4000-8000-0000000000a1', 'TW Default', ARRAY['60691'], 2000, 500),
  ('f8000000-0000-4000-8000-0000000000a2', 'f7000000-0000-4000-8000-0000000000a2', 'TW Custom',  ARRAY['60692'], 2000, 500),
  ('f8000000-0000-4000-8000-0000000000a3', 'f7000000-0000-4000-8000-0000000000a3', 'TW Unset',   ARRAY['60693'], 2000, 500);

-- What the signup page charged for every cadence before this file. On a
-- stack that already has it, the new function answered and the "before"
-- check says so rather than claiming a fault it did not see.
CREATE TEMP TABLE tw_before AS
  SELECT f AS frequency,
         (SELECT recurring_price_cents FROM public.public_quote('tw-proof-default', '60691', 4, f)) AS cents
    FROM unnest(ARRAY['weekly', 'biweekly', 'twice_weekly', 'monthly']) AS f;
-- Read below as anon, which is who the signup page asks as.
GRANT SELECT ON tw_before TO anon;

\i :migration

-- ── The default table: twice weekly is 1.8x the weekly plan, per week ──────
SET ROLE anon;
DO $$
DECLARE _w int; _b int; _t int; _m int; _was int;
BEGIN
  SELECT recurring_price_cents INTO _w FROM public.public_quote('tw-proof-default', '60691', 4, 'weekly');
  SELECT recurring_price_cents INTO _b FROM public.public_quote('tw-proof-default', '60691', 4, 'biweekly');
  SELECT recurring_price_cents INTO _t FROM public.public_quote('tw-proof-default', '60691', 4, 'twice_weekly');
  SELECT recurring_price_cents INTO _m FROM public.public_quote('tw-proof-default', '60691', 4, 'monthly');
  IF _w <> 3500 THEN
    RAISE EXCEPTION 'PROOF FAILED [weekly]: four dogs weekly is % a visit, not 3500', _w;
  END IF;
  IF _t <> 3150 OR 2 * _t <> 6300 THEN
    RAISE EXCEPTION 'PROOF FAILED [twice_weekly]: % a visit, % a week; 1.8x weekly is 6300 a week', _t, 2 * _t;
  END IF;
  IF 2 * _t > 2 * _w THEN
    RAISE EXCEPTION 'PROOF FAILED [ceiling]: twice weekly is % a week, more than two weekly visits (%)', 2 * _t, 2 * _w;
  END IF;
  IF _b <> 5950 OR _m <> 11200 THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: biweekly % (want 5950), monthly % (want 11200)', _b, _m;
  END IF;
  SELECT cents INTO _was FROM tw_before WHERE frequency = 'twice_weekly';
  IF _was = 6300 THEN
    RAISE NOTICE 'ok: twice weekly was 6300 a visit (12600 a week) before this file and is 3150 (6300 a week) after';
  ELSE
    RAISE NOTICE 'ok: twice weekly is 3150 a visit, 6300 a week (the stack already had this file; before was %)', _was;
  END IF;
  IF (SELECT cents FROM tw_before WHERE frequency = 'biweekly') <> _b
     OR (SELECT cents FROM tw_before WHERE frequency = 'monthly') <> _m
     OR (SELECT cents FROM tw_before WHERE frequency = 'weekly') <> _w THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: weekly, biweekly or monthly moved';
  END IF;
  RAISE NOTICE 'ok: weekly, biweekly and monthly price exactly as before (3500, 5950, 11200)';
END $$;

-- ── An owner's own numbers, and a number the owner never set ──────────────
DO $$
DECLARE _t int; _u int;
BEGIN
  SELECT recurring_price_cents INTO _t FROM public.public_quote('tw-proof-custom', '60692', 4, 'twice_weekly');
  IF _t <> 3325 THEN
    RAISE EXCEPTION 'PROOF FAILED [custom]: an owner''s 1.9 a week priced % a visit, not 3325', _t;
  END IF;
  SELECT recurring_price_cents INTO _u FROM public.public_quote('tw-proof-unset', '60693', 4, 'twice_weekly');
  IF _u <> 3500 THEN
    RAISE EXCEPTION 'PROOF FAILED [unset]: no twice-weekly number priced % a visit, not the weekly 3500', _u;
  END IF;
  RAISE NOTICE 'ok: an owner''s 1.9 is 3325 a visit, and no number at all is the weekly price per visit';
END $$;
RESET ROLE;

-- ── A replay changes nothing ──────────────────────────────────────────────
\i :migration
DO $$
DECLARE _t int;
BEGIN
  SELECT recurring_price_cents INTO _t FROM public.public_quote('tw-proof-default', '60691', 4, 'twice_weekly');
  IF _t <> 3150 THEN
    RAISE EXCEPTION 'PROOF FAILED [replay]: applying the file twice priced % a visit', _t;
  END IF;
  RAISE NOTICE 'ok: applying the file again halves nothing twice';
END $$;

ROLLBACK;
