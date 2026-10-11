-- First-cleanup pricing, proved against a real Postgres rather than read off
-- the migration's text. Run by the vitest files that name it, which pass the
-- migration's path as :migration.
--
-- One transaction, ROLLED BACK at the end with the migration inside it, so a
-- shared local stack is left exactly as it was found. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]"; ON_ERROR_STOP makes the first
-- failure a non-zero exit.
--
-- The fixture is written BEFORE the migration runs, on purpose: the claim
-- "nothing changes for an existing business" is about rows that were there
-- when the file arrived, and only a row that predates it can test that.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- Several test files run this proof and vitest runs files in parallel; they
-- would recreate the same function and insert the same ids. Queue them.
SELECT pg_advisory_xact_lock(hashtext('the-first-cleanup-had-no-price.proof'));

-- ── Three businesses that existed before the migration ─────────────────────
--   live   signup page on, a zone with a $75 first cleanup  -> must keep $75
--   quiet  signup page off, same zone price                  -> nothing to keep
--   free   signup page on, every zone's first cleanup $0      -> nothing to keep
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, slug, public_signup_enabled, currency) VALUES
  ('f1000000-0000-4000-8000-0000000000a1', 'First Cleanup Live',  'fc-proof-live',  true,  'usd'),
  ('f1000000-0000-4000-8000-0000000000a2', 'First Cleanup Quiet', 'fc-proof-quiet', false, 'usd'),
  ('f1000000-0000-4000-8000-0000000000a3', 'First Cleanup Free',  'fc-proof-free',  true,  'usd');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents,
                          per_dog_addl_cents, initial_cleanup_cents) VALUES
  ('f2000000-0000-4000-8000-0000000000a1', 'f1000000-0000-4000-8000-0000000000a1',
   'Live Zone', ARRAY['60601'], 2000, 500, 7500),
  ('f2000000-0000-4000-8000-0000000000a2', 'f1000000-0000-4000-8000-0000000000a2',
   'Quiet Zone', ARRAY['60602'], 2000, 500, 7500),
  ('f2000000-0000-4000-8000-0000000000a3', 'f1000000-0000-4000-8000-0000000000a3',
   'Free Zone', ARRAY['60603'], 2000, 500, 0);

-- What the live business's signup charged for a first cleanup BEFORE. On a
-- database that already has this migration the answer comes from the new
-- function with the org as it stands; on one without, from the old one.
CREATE TEMP TABLE fc_before AS
  SELECT initial_cleanup_cents AS cents
    FROM public.public_quote('fc-proof-live', '60601', 1, 'weekly');

-- Undo what an earlier apply of this file did to these three rows, so the
-- backfill below is exercised on a local stack that already has the column.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'organizations'
                AND column_name = 'first_cleanup_pricing') THEN
    UPDATE public.organizations SET first_cleanup_pricing = '{"mode":"off"}'
     WHERE id::text LIKE 'f1000000-%';
    -- ...and the live one's page therefore charged $75 before this file
    -- existed, which is the fact being preserved.
    UPDATE fc_before SET cents = 7500;
  END IF;
END $$;

-- Phase 5 (20261011100000_a-walk-is-priced-as-a-walk) replaced this file's
-- five-argument public_quote with a six-argument one, dropping the old
-- signature on the way, for the PostgREST reason it gives. On a stack that
-- has it, re-applying this file creates the five-argument function BESIDE the
-- six-argument one, and the file's own check ("public_quote must have exactly
-- one signature") stops the proof before a single first-cleanup claim is
-- tested. So on such a stack the newer function is set aside first, inside
-- this transaction, and the file under proof establishes its own exactly as
-- it did the day it shipped. Nothing else depends on the function (no view,
-- no trigger), the proof lock keeps other proofs out, and the ROLLBACK at the
-- end puts the six-argument one back untouched. The fixture's "before" row
-- above was captured from whichever function the stack had, which is the
-- point: phase 5 keeps the pet-waste quote byte for byte.
SELECT to_regprocedure('public.public_quote(text, text, integer, text, text, uuid)') IS NOT NULL AS has_six \gset
\if :has_six
DROP FUNCTION public.public_quote(text, text, integer, text, text, uuid);
\endif

\i :migration

-- ── Off by default changes nothing ─────────────────────────────────────────
DO $$
DECLARE _live jsonb; _quiet jsonb; _free jsonb; _before int; _after int;
BEGIN
  SELECT first_cleanup_pricing INTO _live  FROM public.organizations WHERE id = 'f1000000-0000-4000-8000-0000000000a1';
  SELECT first_cleanup_pricing INTO _quiet FROM public.organizations WHERE id = 'f1000000-0000-4000-8000-0000000000a2';
  SELECT first_cleanup_pricing INTO _free  FROM public.organizations WHERE id = 'f1000000-0000-4000-8000-0000000000a3';
  IF _live ->> 'mode' <> 'flat' THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a live signup page charging $75 was set to %, and would stop charging it', _live;
  END IF;
  IF _quiet ->> 'mode' <> 'off' OR _free ->> 'mode' <> 'off' THEN
    RAISE EXCEPTION 'PROOF FAILED [default]: a business that charged nothing now has % / %', _quiet, _free;
  END IF;

  SELECT cents INTO _before FROM fc_before;
  SELECT initial_cleanup_cents INTO _after FROM public.public_quote('fc-proof-live', '60601', 1, 'weekly');
  IF _after IS DISTINCT FROM _before OR _after <> 7500 THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the live signup charged % for a first cleanup and now charges %', _before, _after;
  END IF;
  RAISE NOTICE 'ok: an existing live signup page charges the same first cleanup after the migration (%)', _after;

  SELECT initial_cleanup_cents INTO _after FROM public.public_quote('fc-proof-free', '60603', 3, 'weekly');
  IF _after <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [free]: a business with no first cleanup now charges %', _after;
  END IF;
  RAISE NOTICE 'ok: a business with no first-cleanup charge still has none';
END $$;

-- A new business: the column default, nothing else.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, slug, public_signup_enabled, currency) VALUES
  ('f1000000-0000-4000-8000-0000000000a4', 'First Cleanup New', 'fc-proof-new', true, 'usd');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents,
                          per_dog_addl_cents) VALUES
  ('f2000000-0000-4000-8000-0000000000a4', 'f1000000-0000-4000-8000-0000000000a4',
   'New Zone', ARRAY['60604'], 2000, 500);
DO $$
DECLARE _cfg jsonb; _ic int;
BEGIN
  SELECT first_cleanup_pricing INTO _cfg FROM public.organizations WHERE id = 'f1000000-0000-4000-8000-0000000000a4';
  IF _cfg <> '{"mode":"off"}'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [new]: a new business starts with %', _cfg;
  END IF;
  -- The zone column still defaults to 7500. Off means that number is not a price.
  SELECT initial_cleanup_cents INTO _ic FROM public.public_quote('fc-proof-new', '60604', 1, 'weekly');
  IF _ic <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [new]: off charged the zone default of %', _ic;
  END IF;
  RAISE NOTICE 'ok: a new business starts off, and the zone''s default fee is not charged';
END $$;

-- ── Tiered: priced from the id, by the database, for anon ──────────────────
UPDATE public.organizations
   SET first_cleanup_pricing = '{"mode":"by_last_cleaned","per_extra_dog_cents":1000,"tiers":[
         {"id":"within_a_week","label":"Within a week","price_cents":4500},
         {"id":"one_to_four_weeks","label":"1-4 weeks","price_cents":7500},
         {"id":"three_months_or_never","label":"3+ months or never","price_cents":15000}]}'
 WHERE id = 'f1000000-0000-4000-8000-0000000000a4';

SET ROLE anon;
DO $$
DECLARE r record;
BEGIN
  -- The four-argument call every existing caller makes still resolves.
  SELECT * INTO r FROM public.public_quote('fc-proof-new', '60604', 1, 'weekly');
  IF r.recurring_price_cents <> 2000 THEN
    RAISE EXCEPTION 'PROOF FAILED [signature]: the four-argument call priced the visit at %', r.recurring_price_cents;
  END IF;
  IF r.initial_cleanup_cents IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [no tier]: tiered pricing with no answer charged %', r.initial_cleanup_cents;
  END IF;
  IF r.first_cleanup_mode <> 'by_last_cleaned' OR jsonb_array_length(r.first_cleanup_options) <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [options]: % / %', r.first_cleanup_mode, r.first_cleanup_options;
  END IF;
  RAISE NOTICE 'ok: with no answer there is no price, and the answers are listed';

  SELECT * INTO r FROM public.public_quote('fc-proof-new', '60604', 3, 'weekly', 'three_months_or_never');
  IF r.initial_cleanup_cents <> 17000 OR r.first_cleanup_label <> '3+ months or never' THEN
    RAISE EXCEPTION 'PROOF FAILED [tier]: 3 dogs, 3+ months priced % (%), expected 17000', r.initial_cleanup_cents, r.first_cleanup_label;
  END IF;
  IF (r.first_cleanup_options -> 0 ->> 'price_cents')::int <> 6500 THEN
    RAISE EXCEPTION 'PROOF FAILED [options priced]: the week tier for 3 dogs listed at %', r.first_cleanup_options -> 0;
  END IF;
  RAISE NOTICE 'ok: the tier is priced as tier + extra dogs, and the listed options agree';

  SELECT * INTO r FROM public.public_quote('fc-proof-new', '60604', 1, 'weekly', 'free-please');
  IF r.initial_cleanup_cents IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [made-up tier]: an id the owner does not have was priced at %', r.initial_cleanup_cents;
  END IF;
  RAISE NOTICE 'ok: a tier id the owner does not have prices nothing, so nothing can be charged';
END $$;

-- The pricing helpers are not the publishable key's to call, and there is no
-- way to hand public_quote a price: its only first-cleanup input is an id.
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.first_cleanup_price_cents('{"mode":"flat"}', 1, 1, NULL);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call first_cleanup_price_cents'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'public_quote'
                AND pg_get_function_arguments(p.oid) ~* 'cents') THEN
    RAISE EXCEPTION 'PROOF FAILED [price in]: public_quote takes a price argument';
  END IF;
  RAISE NOTICE 'ok: anon can price only through public_quote, which takes no price';
END $$;
RESET ROLE;

-- ── The CHECK holds ────────────────────────────────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    UPDATE public.organizations SET first_cleanup_pricing = '{"mode":"by_last_cleaned","tiers":[]}'
     WHERE id = 'f1000000-0000-4000-8000-0000000000a4';
  EXCEPTION WHEN check_violation THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [check]: tiered pricing with no tiers was stored'; END IF;
  RAISE NOTICE 'ok: the column refuses a tiered config with no answers';
END $$;

-- ── The same cases the TypeScript mirror is tested on ──────────────────────
-- tests/a-first-cleanup-is-priced-by-how-long-the-yard-has-waited.test.ts
-- reads these lines and runs the same inputs through firstCleanupPriceCents.
-- Format: CASE|<config>|<zone flat>|<dogs>|<tier or empty>|<expected or null>
\pset tuples_only on
\pset format unaligned
SELECT 'CASE|' || c.cfg || '|' || c.zone || '|' || c.dogs || '|' || COALESCE(c.tier, '') || '|' ||
       COALESCE(public.first_cleanup_price_cents(c.cfg::jsonb, c.zone, c.dogs, c.tier)::text, 'null')
  FROM (VALUES
    ('{"mode":"off"}', 7500, 1, NULL),
    ('{"mode":"off","per_extra_dog_cents":1000}', 7500, 4, NULL),
    ('{"mode":"flat"}', 7500, 1, NULL),
    ('{"mode":"flat"}', 0, 3, NULL),
    ('{"mode":"flat","per_extra_dog_cents":1000}', 7500, 3, NULL),
    ('{"mode":"flat","per_extra_dog_cents":1000}', 0, 3, NULL),
    ('{"mode":"by_last_cleaned","tiers":[{"id":"a","label":"A","price_cents":4500},{"id":"b","label":"B","price_cents":0}]}', 7500, 1, 'a'),
    ('{"mode":"by_last_cleaned","per_extra_dog_cents":1500,"tiers":[{"id":"a","label":"A","price_cents":4500},{"id":"b","label":"B","price_cents":0}]}', 99999, 3, 'a'),
    ('{"mode":"by_last_cleaned","per_extra_dog_cents":1500,"tiers":[{"id":"a","label":"A","price_cents":4500},{"id":"b","label":"B","price_cents":0}]}', 7500, 3, 'b'),
    ('{"mode":"by_last_cleaned","tiers":[{"id":"a","label":"A","price_cents":4500}]}', 7500, 1, NULL),
    ('{"mode":"by_last_cleaned","tiers":[{"id":"a","label":"A","price_cents":4500}]}', 7500, 1, 'z')
  ) AS c(cfg, zone, dogs, tier);
\pset tuples_only off
\pset format aligned

\echo ALL FIRST-CLEANUP PROOFS PASSED
ROLLBACK;
