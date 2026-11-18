-- Proof for 20261118040000 (#980): staff_end_point ends a day at a dump site only
-- for a business that runs pet waste. One transaction, ROLLED BACK.
\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;
BEGIN;

-- W walking-only, M mixed (pet_waste + dog_walking), P pet waste only. Each has
-- one active dump site and two people: one with no end address, one with an own end.
INSERT INTO public.organizations (id, name, timezone, service_lines) VALUES
  ('0a000000-0000-4000-8000-000000980a0a', 'End Proof W', 'America/Detroit', '{dog_walking}'),
  ('0a000000-0000-4000-8000-000000980a0b', 'End Proof M', 'America/Detroit', '{pet_waste,dog_walking}'),
  ('0a000000-0000-4000-8000-000000980a0c', 'End Proof P', 'America/Detroit', '{pet_waste}');
INSERT INTO public.waste_disposal_facilities (id, organization_id, name, latitude, longitude, active)
SELECT ('0b000000-0000-4000-8000-000000980b0' || n)::uuid,
       ('0a000000-0000-4000-8000-000000980a0' || chr(96 + n))::uuid, 'Dump ' || n, 42.0 + n, -83.0, true
  FROM generate_series(1, 3) n;
INSERT INTO auth.users (id, email, raw_user_meta_data, created_at)
SELECT ('f0000000-0000-4000-8000-000000980f' || o || k)::uuid, 'e' || o || k || '@end.proof.invalid',
       jsonb_build_object('display_name', 'Person ' || o || k), now() - interval '100 days'
  FROM generate_series(1, 3) o, generate_series(1, 2) k;
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active, end_latitude, end_longitude)
SELECT ('0c000000-0000-4000-8000-000000980c' || o || k)::uuid,
       ('0a000000-0000-4000-8000-000000980a0' || chr(96 + o))::uuid,
       ('f0000000-0000-4000-8000-000000980f' || o || k)::uuid, 'tech', 'Person ' || o || k, true,
       CASE WHEN k = 2 THEN 10.5 END, CASE WHEN k = 2 THEN 20.5 END
  FROM generate_series(1, 3) o, generate_series(1, 2) k;

CREATE FUNCTION pg_temp.end_of(_o int, _k int) RETURNS text LANGUAGE sql AS $$
  SELECT coalesce((SELECT e.lat || ',' || e.lon
                     FROM public.staff_end_point(
                       ('0a000000-0000-4000-8000-000000980a0' || chr(96 + _o))::uuid,
                       ('0c000000-0000-4000-8000-000000980c' || _o || _k)::uuid) e), 'open');
$$;

DO $proof$
BEGIN
  -- A walking-only business: an open path, not the dump.
  IF pg_temp.end_of(1, 1) <> 'open' THEN RAISE EXCEPTION 'PROOF FAILED: walking-only business ends at %', pg_temp.end_of(1, 1); END IF;
  RAISE NOTICE 'ok: a business with no pet waste ends the day at the last visit';
  -- ...unless the person's own end address is set.
  IF pg_temp.end_of(1, 2) <> '10.5,20.5' THEN RAISE EXCEPTION 'PROOF FAILED: own end ignored'; END IF;
  RAISE NOTICE 'ok: a person''s own end address still wins';
  -- Mixed and pet-waste-only businesses are unchanged: nearest active dump.
  IF pg_temp.end_of(2, 1) <> '44,-83' OR pg_temp.end_of(3, 1) <> '45,-83' THEN
    RAISE EXCEPTION 'PROOF FAILED: dump routing changed for a pet-waste business (% / %)', pg_temp.end_of(2, 1), pg_temp.end_of(3, 1);
  END IF;
  RAISE NOTICE 'ok: a mixed business and a pet-waste business still end at their dump site';
  -- Turn pet waste on: the same dump site routes again, nothing was deleted.
  UPDATE public.organizations SET service_lines = '{dog_walking,pet_waste}' WHERE id = '0a000000-0000-4000-8000-000000980a0a';
  IF pg_temp.end_of(1, 1) <> '43,-83' THEN RAISE EXCEPTION 'PROOF FAILED: dump routing not restored (%)', pg_temp.end_of(1, 1); END IF;
  RAISE NOTICE 'ok: turning pet waste back on restores dump-site routing';
  -- And off again: the site is still on file.
  UPDATE public.organizations SET service_lines = '{dog_walking}' WHERE id = '0a000000-0000-4000-8000-000000980a0a';
  IF pg_temp.end_of(1, 1) <> 'open'
     OR (SELECT count(*) FROM public.waste_disposal_facilities WHERE organization_id = '0a000000-0000-4000-8000-000000980a0a' AND active) <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED: dropping pet waste again';
  END IF;
  RAISE NOTICE 'ok: dropping pet waste keeps the dump site on file';
END
$proof$;

DO $done$ BEGIN RAISE NOTICE 'ALL END-POINT PROOFS PASSED'; END $done$;
ROLLBACK;
