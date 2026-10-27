-- Proof for 20261027200000: a stranger is not sold a groom (#559).
--
-- A business that scoops, walks, sits and grooms, with its public signup on,
-- every one of those lines bookable and customer requestable on the switch
-- (as on main since #549), and a priced service on each.
--
--   1. As anon, public_services lists the pet-waste service, the walk and the
--      drop-in, and no mobile_grooming row.
--   2. As anon, public_quote for the groom answers nothing; the walk, the
--      drop-in and the zone quote each answer one row.
--   3. The switch still says grooming is customer requestable: the portal's
--      groom request (portal_request_groom) is not what this file closes.
--   4. Mutation: empty office_booked_service_lines() and show the groom is
--      listed and priced to anon again, and that every non-groom row from
--      sections 1 and 2 is byte for byte what it was. If the groom stays
--      hidden, INCONCLUSIVE: something else is doing the hiding.
--
-- Everything is inside one transaction that ends in ROLLBACK, the mutation
-- included. Run against a freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261027200000-a-stranger-is-not-sold-a-groom.sql

\set ON_ERROR_STOP on
-- The set_config() calls below return a row each; only the NOTICEs matter.
\o /dev/null
BEGIN;

-- ── FIXTURE ───────────────────────────────────────────────────────────────
CREATE TEMP TABLE _ids (k text PRIMARY KEY, v uuid);
CREATE TEMP TABLE _seen (k text PRIMARY KEY, v text);
GRANT SELECT ON _ids TO authenticated, anon, service_role;
GRANT SELECT, INSERT ON _seen TO authenticated, anon, service_role;

-- The switch as main has it since #549, pinned here so this proof does not
-- depend on which flips a database has had. Rolled back with the rest.
UPDATE public.platform_service_lines
   SET bookable = true, customer_requestable = true
 WHERE service_line IN ('pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming')
   AND (bookable IS DISTINCT FROM true OR customer_requestable IS DISTINCT FROM true);

DO $$
DECLARE
  _org uuid; _zone uuid; _walk uuid; _sit uuid; _groom uuid; _pw uuid;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO public.organizations (name, slug, portal_slug, public_signup_enabled, service_lines,
                                    timezone, work_days, currency)
  VALUES ('Groom Sale Proof', 'groom-sale-proof', 'groom-sale-proof-portal', true,
          ARRAY['pet_waste', 'dog_walking', 'pet_sitting', 'mobile_grooming'],
          'UTC', ARRAY[0,1,2,3,4,5,6], 'usd')
  RETURNING id INTO _org;
  PERFORM set_config('app.allow_protected_org_write', '', true);

  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents)
  VALUES (_org, 'Groom Sale Zone', ARRAY['60601'], 2000, 500, 7500)
  RETURNING id INTO _zone;

  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof walk', 'dog_walking', 'visit', 30, 2500, 500, true)
  RETURNING id INTO _walk;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof drop-in', 'pet_sitting', 'visit', 20, 2200, 0, true)
  RETURNING id INTO _sit;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, extra_pet_cents, active)
  VALUES (_org, 'Proof full groom', 'mobile_grooming', 'visit', 90, 8000, 1000, true)
  RETURNING id INTO _groom;

  -- The pet-waste service the organizations trigger seeds.
  SELECT s.id INTO _pw FROM public.services s
   WHERE s.organization_id = _org AND s.service_line = 'pet_waste'
   LIMIT 1;
  IF _pw IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the business has no seeded pet-waste service';
  END IF;
  -- Turning a line on seeds that line's own services (a sitting business
  -- gets a drop-in, a house sit, an overnight stay...). Retire every one but
  -- the four above, so each line has exactly one service to list and price.
  UPDATE public.services s SET active = false
   WHERE s.organization_id = _org AND s.id NOT IN (_pw, _walk, _sit, _groom);

  INSERT INTO _ids VALUES ('org', _org), ('zone', _zone), ('walk', _walk), ('sit', _sit),
                          ('groom', _groom), ('pw', _pw);
END $$;

-- ── 1. What anon is shown ─────────────────────────────────────────────────
SET LOCAL ROLE anon;
DO $$
DECLARE
  _lines text[];
  _ids uuid[];
BEGIN
  SELECT array_agg(s.service_line ORDER BY ord), array_agg(s.id ORDER BY ord)
    INTO _lines, _ids
    FROM public.public_services('groom-sale-proof')
         WITH ORDINALITY AS s(id, name, service_line, price_unit, base_price_cents,
                              extra_pet_cents, default_duration_min, ord);
  IF 'mobile_grooming' = ANY (_lines) THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: public_services listed a groom to a stranger: %', _lines;
  END IF;
  IF _ids IS DISTINCT FROM ARRAY[(SELECT v FROM _ids WHERE k = 'pw'),
                                 (SELECT v FROM _ids WHERE k = 'walk'),
                                 (SELECT v FROM _ids WHERE k = 'sit')] THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: public_services listed % (want pet waste, walk, drop-in)', _lines;
  END IF;
  -- The portal slug is the same business, and the same answer.
  IF EXISTS (SELECT 1 FROM public.public_services('groom-sale-proof-portal') s
              WHERE s.service_line = 'mobile_grooming') THEN
    RAISE EXCEPTION 'PROOF FAILED [list]: the portal slug listed a groom to a stranger';
  END IF;

  INSERT INTO _seen
  SELECT 'list', json_agg(row_to_json(s) ORDER BY s.id)::text
    FROM public.public_services('groom-sale-proof') s;
  RAISE NOTICE 'ok: anon is listed pet waste, the walk and the drop-in, and no groom';
END $$;

-- ── 2. What anon is quoted ────────────────────────────────────────────────
DO $$
DECLARE
  _n int;
  _r record;
BEGIN
  SELECT count(*) INTO _n
    FROM public.public_quote('groom-sale-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'groom'));
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: public_quote priced a groom for a stranger (% row(s))', _n;
  END IF;

  SELECT * INTO _r FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 3000 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the walk quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('groom-sale-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit'));
  IF NOT FOUND OR _r.recurring_price_cents IS DISTINCT FROM 2200 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the drop-in quoted %', row_to_json(_r);
  END IF;
  SELECT * INTO _r FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly');
  IF NOT FOUND OR _r.base_price_cents IS DISTINCT FROM 2500 THEN
    RAISE EXCEPTION 'PROOF FAILED [quote]: the yard quoted %', row_to_json(_r);
  END IF;

  INSERT INTO _seen
  SELECT 'quotes', json_agg(q ORDER BY k)::text FROM (
    SELECT 'walk' AS k, row_to_json(x)::text AS q
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk')) x
    UNION ALL
    SELECT 'sit', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit')) x
    UNION ALL
    SELECT 'yard', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly') x
    UNION ALL
    SELECT 'pw', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'pw')) x
  ) t;
  RAISE NOTICE 'ok: anon is quoted nothing for the groom, and the walk, the drop-in and the yard as before';
END $$;
RESET ROLE;

-- ── 3. The portal's groom request is still open ───────────────────────────
DO $$
BEGIN
  IF NOT ('mobile_grooming' = ANY (public.customer_requestable_service_lines()))
     OR NOT ('mobile_grooming' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'PROOF FAILED [switch]: grooming is no longer bookable and customer requestable';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace
                AND p.proname = 'portal_request_groom'
                AND p.prosrc LIKE '%office_booked_service_lines%') THEN
    RAISE EXCEPTION 'PROOF FAILED [portal]: portal_request_groom reads office_booked_service_lines()';
  END IF;
  RAISE NOTICE 'ok: grooming is still on both switches, and portal_request_groom does not ask the office-booked list';
END $$;

-- ── 4. Mutation: no office-booked lines, the groom is for sale again ──────
CREATE OR REPLACE FUNCTION public.office_booked_service_lines()
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT '{}'::text[];
$function$;

SET LOCAL ROLE anon;
DO $$
DECLARE
  _listed int;
  _quoted int;
  _rest text;
  _quotes text;
BEGIN
  SELECT count(*) INTO _listed
    FROM public.public_services('groom-sale-proof') s WHERE s.service_line = 'mobile_grooming';
  SELECT count(*) INTO _quoted
    FROM public.public_quote('groom-sale-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'groom'));
  IF _listed <> 1 OR _quoted <> 1 THEN
    RAISE EXCEPTION 'INCONCLUSIVE [mutation]: with no office-booked lines the groom was listed % time(s) and quoted % time(s); something else hides it',
      _listed, _quoted;
  END IF;

  -- Everything that is not the groom is exactly what the fixed functions said.
  SELECT json_agg(row_to_json(s) ORDER BY s.id)::text INTO _rest
    FROM public.public_services('groom-sale-proof') s WHERE s.service_line <> 'mobile_grooming';
  IF _rest IS DISTINCT FROM (SELECT v FROM _seen WHERE k = 'list') THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the non-groom list differs: % / %', _rest, (SELECT v FROM _seen WHERE k = 'list');
  END IF;
  SELECT json_agg(q ORDER BY k)::text INTO _quotes FROM (
    SELECT 'walk' AS k, row_to_json(x)::text AS q
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'walk')) x
    UNION ALL
    SELECT 'sit', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 1, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'sit')) x
    UNION ALL
    SELECT 'yard', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly') x
    UNION ALL
    SELECT 'pw', row_to_json(x)::text
      FROM public.public_quote('groom-sale-proof', '60601', 2, 'weekly', NULL, (SELECT v FROM _ids WHERE k = 'pw')) x
  ) t;
  IF _quotes IS DISTINCT FROM (SELECT v FROM _seen WHERE k = 'quotes') THEN
    RAISE EXCEPTION 'PROOF FAILED [unchanged]: the non-groom quotes differ: % / %', _quotes, (SELECT v FROM _seen WHERE k = 'quotes');
  END IF;
  RAISE NOTICE 'ok: mutation reproduced; with no office-booked lines the groom is listed and priced to anon, and pet waste, walking and sitting answer exactly as they did';
END $$;
RESET ROLE;

ROLLBACK;
