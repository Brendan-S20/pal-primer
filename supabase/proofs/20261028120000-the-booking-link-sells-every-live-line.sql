-- Proof for 20261028120000: the booking link sells every live line (#560).
--
-- A business that scoops, walks, sits, grooms and trains, with its public
-- signup on, every line bookable, and the switch's second column as main has
-- it: training NOT customer requestable. A priced service on each line, and a
-- second walk with no price yet (Riverbend's case).
--
--   1. As anon, public_services lists all six: pet waste, both walks, the
--      drop-in, the groom and the lesson. The unpriced walk has no price.
--   2. As anon, public_quote prices the walk, the drop-in, the groom, the
--      lesson and the yard; the unpriced walk answers with NULL prices, which
--      nothing may charge.
--   3. The switch is untouched: training is still not customer requestable,
--      office_booked_service_lines() is still {mobile_grooming}, and the
--      portal one-off still reads customer_requestable.
--   4. Mutation: take grooming off the BOOKABLE switch and show the groom is
--      gone from both doors, and that every other row from sections 1 and 2
--      is byte for byte what it was. If the groom stays, INCONCLUSIVE: the
--      bookable gate is not what decides.
--
-- Replaces 20261027200000's proof, which held the rule this migration
-- reverses (no groom on the link). Everything is inside one transaction that
-- ends in ROLLBACK, the mutation included. Run against a freshly reset local
-- database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261028120000-the-booking-link-sells-every-live-line.sql

\set ON_ERROR_STOP on
-- The set_config() calls below return a row each; only the NOTICEs matter.
\o /dev/null
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
CREATE TEMP TABLE _seen (k text PRIMARY KEY, v text);
GRANT SELECT ON _ids TO authenticated, anon, service_role;
GRANT SELECT, INSERT ON _seen TO authenticated, anon, service_role;

-- The switch as main has it since #548 and #549, pinned here so this proof
-- does not depend on which flips a database has had. Rolled back.
UPDATE public.platform_service_lines
   SET bookable = true, customer_requestable = true
 WHERE service_line IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming')
   AND (bookable IS DISTINCT FROM true OR customer_requestable IS DISTINCT FROM true);
UPDATE public.platform_service_lines
   SET bookable = true, customer_requestable = false
 WHERE service_line = 'training'
   AND (bookable IS DISTINCT FROM true OR customer_requestable IS DISTINCT FROM false);

DO $$
DECLARE
  _org uuid; _zone uuid; _walk uuid; _walk_np uuid; _sit uuid; _groom uuid; _lesson uuid; _pw uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO public.organizations (name, slug, portal_slug, public_signup_enabled, service_lines,
                                    timezone, work_days, currency)
  VALUES ('Every Line Proof', 'every-line-proof', 'every-line-proof-portal', true,
          ARRAY['pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming', 'training'],
          'UTC', ARRAY[0,1,2,3,4,5,6], 'usd')
  RETURNING id INTO _org;
  PERFORM set_config('app.allow_protected_org_write', '', true);

  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents)
  VALUES (_org, 'Every Line Zone', ARRAY['60601'], 2000, 500, 7500)
  RETURNING id INTO _zone;

  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof walk', 'dog_walking', 'visit', 30, 2500, 500, true)
  RETURNING id INTO _walk;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof walk, no price yet', 'dog_walking', 'visit', 45, NULL, 0, true)
  RETURNING id INTO _walk_np;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof drop-in', 'pet_sitting', 'visit', 20, 2200, 0, true)
  RETURNING id INTO _sit;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof full groom', 'mobile_grooming', 'visit', 90, 8000, 1000, true)
  RETURNING id INTO _groom;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof private lesson', 'training', 'visit', 60, 9000, 0, true)
  RETURNING id INTO _lesson;

  SELECT s.id INTO _pw FROM public.services s
   WHERE s.organization_id = _org AND s.service_line = 'pet_waste'
   LIMIT 1;
  IF _pw IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the business has no seeded pet-waste service';
  END IF;
  -- Turning a line on seeds that line's own services. Retire every one but
  -- the six above, so the list is exactly what this proof made.
  UPDATE public.services s SET active = false
   WHERE s.organization_id = _org AND s.id NOT IN (_pw, _walk, _walk_np, _sit, _groom, _lesson);

  INSERT INTO _ids VALUES ('org', _org), ('zone', _zone), ('walk', _walk), ('walk_np', _walk_np),
                          ('sit', _sit), ('groom', _groom), ('lesson', _lesson), ('pw', _pw);
END $$;

-- ── 1. What anon is shown ─────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE
  _names text[];
BEGIN
  SELECT array_agg(s.name ORDER BY ord) INTO _names
    FROM public.public_services('every-line-proof')
         WITH ORDINALITY AS s(id, name, service_line, price_unit, base_price_cents,
                              extra_pet_cents, default_duration_min, ord)
   WHERE s.service_line <> 'pet_waste';
  IF _names IS DISTINCT FROM ARRAY['Proof walk', 'Proof walk, no price yet', 'Proof drop-in',
                                   'Proof full groom', 'Proof private lesson'] THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: public_services listed % (want both walks, the drop-in, the groom and the lesson)', _names;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.public_services('every-line-proof') s
                  WHERE s.id = (SELECT v FROM _ids WHERE k = 'pw')) THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the pet-waste service is not listed';
  END IF;
  IF (SELECT s.base_price_cents FROM public.public_services('every-line-proof') s
       WHERE s.id = (SELECT v FROM _ids WHERE k = 'walk_np')) IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the unpriced walk was listed with a price';
  END IF;
  -- The portal slug is the same business, and the same answer.
  IF (SELECT count(*) FROM public.public_services('every-line-proof-portal')) <> 6 THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the portal slug listed a different set';
  END IF;

  INSERT INTO _seen
  SELECT 'list', json_agg(row_to_json(s) ORDER BY s.id)::text
    FROM public.public_services('every-line-proof') s WHERE s.service_line <> 'mobile_grooming';
  RAISE NOTICE 'ok: anon is listed every live line, the groom, the lesson and an unpriced walk included';
END $$;

-- ── 2. What anon is quoted ────────────────────────────────────────────────
DO $$
DECLARE
  _r record;
BEGIN
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'groom'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 9000 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the groom quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'lesson'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 9000 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the lesson quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk_np'));
  IF FOUND AND _r.recurring_price_cents IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the unpriced walk was given a price: %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 3000 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the walk quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 2200 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the drop-in quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('every-line-proof', '60601', 2, 'weekly');
  IF NOT FOUND OR _r.base_price_cents IS DISTINCT FROM 2500 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the yard quoted %', row_to_json(_r);
  END IF;

  INSERT INTO _seen
  SELECT 'quotes', json_agg(q ORDER BY k)::text FROM (
    SELECT 'walk' AS k, row_to_json(x)::text AS q
      FROM public.public_quote('every-line-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk')) x
    UNION ALL
    SELECT 'sit', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit')) x
    UNION ALL
    SELECT 'lesson', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'lesson')) x
    UNION ALL
    SELECT 'yard', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 2, 'weekly') x
  ) t;
  RAISE NOTICE 'ok: anon is quoted the groom, the lesson, the walk, the drop-in and the yard; the unpriced walk has no price';
END $$;
RESET ROLE;

-- ── 3. The switch and the other doors are untouched ──────────────────────
DO $$
BEGIN
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: training became customer requestable';
  END IF;
  IF public.office_booked_service_lines() IS DISTINCT FROM ARRAY['mobile_grooming']::text[] THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: office_booked_service_lines() changed to %', public.office_booked_service_lines();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p
                  WHERE p.pronamespace = 'public'::regnamespace
                    AND p.proname = 'portal_request_one_off'
                    AND p.prosrc LIKE '%customer_requestable_service_lines()%') THEN
    RAISE EXCEPTION 'PROOF FAILED [portal]: portal_request_one_off lost its customer_requestable gate';
  END IF;
  RAISE NOTICE 'ok: the switch, the office-booked list and the portal one-off are as they were';
END $$;

-- ── 4. Mutation: grooming Coming soon, the groom is off the link ─────────
UPDATE public.platform_service_lines SET bookable = false WHERE service_line = 'mobile_grooming';

SET LOCAL ROLE anon;
DO $$
DECLARE
  _listed int;
  _quoted int;
  _rest text;
  _quotes text;
BEGIN
  SELECT count(*) INTO _listed
    FROM public.public_services('every-line-proof') s WHERE s.service_line = 'mobile_grooming';
  SELECT count(*) INTO _quoted
    FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'groom'));
  IF _listed <> 0 OR _quoted <> 0 THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: with grooming Coming soon the groom was listed % time(s) and quoted % time(s); the bookable switch is not deciding',
      _listed, _quoted;
  END IF;

  SELECT json_agg(row_to_json(s) ORDER BY s.id)::text INTO _rest
    FROM public.public_services('every-line-proof') s;
  IF _rest IS DISTINCT FROM (SELECT v FROM _seen WHERE k = 'list') THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the non-groom list differs: % / %', _rest, (SELECT v FROM _seen WHERE k = 'list');
  END IF;
  SELECT json_agg(q ORDER BY k)::text INTO _quotes FROM (
    SELECT 'walk' AS k, row_to_json(x)::text AS q
      FROM public.public_quote('every-line-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk')) x
    UNION ALL
    SELECT 'sit', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit')) x
    UNION ALL
    SELECT 'lesson', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'lesson')) x
    UNION ALL
    SELECT 'yard', row_to_json(x)::text
      FROM public.public_quote('every-line-proof', '60601', 2, 'weekly') x
  ) t;
  IF _quotes IS DISTINCT FROM (SELECT v FROM _seen WHERE k = 'quotes') THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the non-groom quotes differ: % / %', _quotes, (SELECT v FROM _seen WHERE k = 'quotes');
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; with grooming Coming soon the groom is off both doors, and every other line answers exactly as it did';
END $$;
RESET ROLE;

ROLLBACK;
