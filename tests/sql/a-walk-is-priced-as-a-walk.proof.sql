-- A walk is priced as a walk (the service catalog, phase 5), proved against a
-- real Postgres rather than read off the migrations' text. Run by
-- tests/a-walk-is-priced-as-a-walk-in-a-real-database.test.ts, which passes
--   :lines      20261008120000_a-dog-walker-should-not-have-to-learn-about-dump-sites.sql
--   :p1         20261009200000_a-walk-is-not-a-cleanup.sql
--   :p2         20261009230000_a-visit-knows-its-service.sql
--   :durations  20261009230100_a-walk-takes-as-long-as-the-walk.sql
--   :pricing    20261011100000_a-walk-is-priced-as-a-walk.sql
--   :invoice    20261011100100_an-invoice-names-the-service.sql
--   :portal     20261011100200_a-customer-asks-for-a-walk.sql
-- The first four are applied only where the database does not have them yet
-- (the shared stack CI runs proofs against follows main, #358, #381, #384).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migrations included. Each group prints "ok: ..." only when every check
-- in it passed, or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the
-- first failure into a non-zero exit.
--
-- The point of the fixture being written BEFORE the three migrations: the
-- claim "a pet-waste quote is byte-for-byte what it was" can only be tested
-- by asking the OLD function first. On a stack that already has the pricing
-- migration (a replayed database, a second run) the before-row comes from the
-- new function and that group proves only that it is stable; the group says
-- which it measured.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- The bases, in order, each only where the stack was built before it.
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'service_lines'
) AS need_lines \gset
\if :need_lines
\i :lines
\endif
SELECT to_regclass('public.services') IS NULL AS need_services \gset
\if :need_services
\i :p1
\endif
SELECT NOT EXISTS (
  SELECT 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'service_id'
) AS need_service_ids \gset
\if :need_service_ids
\i :p2
\i :durations
\endif

-- Was the pricing migration already here? Then "before" is "now".
CREATE TEMP TABLE pq_meta ON COMMIT DROP AS
  SELECT to_regprocedure('public.public_quote(text, text, integer, text, text, uuid)') IS NOT NULL AS already;

-- ── Fixture ───────────────────────────────────────────────────────────────
-- Q scoops, walks, sits and grooms; its signup page is on, with tiered first
-- cleanups so the pet-waste quote carries every column. R is another business
-- with a walk of its own. Both get their seeded "Pet waste removal" from the
-- organizations trigger.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a5500000-0000-4000-8000-0000000000a1', 'owner-q@walk-priced.proof.invalid');
INSERT INTO public.organizations (id, name, slug, timezone, work_days, service_lines, public_signup_enabled, currency, first_cleanup_pricing) VALUES
  ('05500000-0000-4000-8000-0000000000aa', 'Walk Priced Proof Q', 'walk-priced-proof-q', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{pet_waste,dog_walking,pet_sitting,mobile_grooming}', true, 'usd',
   '{"mode":"by_last_cleaned","per_extra_dog_cents":1000,"tiers":[
      {"id":"week","label":"Within a week","price_cents":4500},
      {"id":"month","label":"1-4 weeks","price_cents":7500}]}'),
  ('05500000-0000-4000-8000-0000000000bb', 'Walk Priced Proof R', 'walk-priced-proof-r', 'America/Chicago',
   '{0,1,2,3,4,5,6}', '{dog_walking}', true, 'usd', '{"mode":"off"}');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a5500000-0000-4000-8000-0000000000a1', '05500000-0000-4000-8000-0000000000aa', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents, per_dog_addl_cents, initial_cleanup_cents) VALUES
  ('25500000-0000-4000-8000-0000000000a1', '05500000-0000-4000-8000-0000000000aa', 'Q Zone', ARRAY['60601'], 2000, 500, 7500),
  ('25500000-0000-4000-8000-0000000000b1', '05500000-0000-4000-8000-0000000000bb', 'R Zone', ARRAY['60602'], 3000, 0, 0);

INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents, extra_pet_cents, default_duration_min, active) VALUES
  ('55500000-0000-4000-8000-0000000000a1', '05500000-0000-4000-8000-0000000000aa', '30-minute walk', 'dog_walking', 'visit', 2500, 500, 30, true),
  ('55500000-0000-4000-8000-0000000000a2', '05500000-0000-4000-8000-0000000000aa', 'Full groom', 'mobile_grooming', 'hour', 6000, 1000, 90, true),
  ('55500000-0000-4000-8000-0000000000a3', '05500000-0000-4000-8000-0000000000aa', 'Overnight stay', 'pet_sitting', 'night', 6000, 1500, NULL, true),
  ('55500000-0000-4000-8000-0000000000a4', '05500000-0000-4000-8000-0000000000aa', 'Drop-in', 'pet_sitting', 'visit', NULL, 0, 20, true),
  ('55500000-0000-4000-8000-0000000000a5', '05500000-0000-4000-8000-0000000000aa', 'Old walk', 'dog_walking', 'visit', 2000, 0, 30, false),
  ('55500000-0000-4000-8000-0000000000b1', '05500000-0000-4000-8000-0000000000bb', 'R walk', 'dog_walking', 'visit', 1800, 0, 30, true);

SELECT count(*) = 0 AS no_pw FROM public.services s
 WHERE s.organization_id = '05500000-0000-4000-8000-0000000000aa' AND lower(s.name) = 'pet waste removal' \gset
\if :no_pw
\echo PROOF FAILED [fixture]: Q has no seeded pet-waste service
\quit 1
\endif
SELECT s.id AS pw_id FROM public.services s
 WHERE s.organization_id = '05500000-0000-4000-8000-0000000000aa' AND lower(s.name) = 'pet waste removal' \gset

-- A client of Q with a portal token and one yard, for the invoice and portal groups.
INSERT INTO public.clients (id, organization_id, account_type, display_name, portal_token, active) VALUES
  ('c5500000-0000-4000-8000-0000000000a1', '05500000-0000-4000-8000-0000000000aa', 'residential', 'Walk Priced Client', 'a5500000-0000-4000-8000-00000000c0de', true);
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, latitude, longitude) VALUES
  ('e5500000-0000-4000-8000-0000000000a1', '05500000-0000-4000-8000-0000000000aa',
   'c5500000-0000-4000-8000-0000000000a1', '412 Elm St', 'Chicago', '60601', 41.92, -87.65);

CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;

-- ── The pet-waste quote BEFORE ────────────────────────────────────────────
-- Three calls that between them read every column: one dog weekly, three
-- dogs biweekly, two dogs monthly with a tier. And a ZIP nobody serves.
CREATE TEMP TABLE pq_cases (k text, zip text, dogs int, freq text, tier text) ON COMMIT DROP;
INSERT INTO pq_cases VALUES
  ('one-weekly',     '60601', 1, 'weekly',   NULL),
  ('three-biweekly', '60601', 3, 'biweekly', NULL),
  ('two-monthly',    '60601', 2, 'monthly',  'month'),
  ('nowhere',        '99999', 1, 'weekly',   NULL);
CREATE TEMP TABLE pq_before (k text, j text) ON COMMIT DROP;
INSERT INTO pq_before
SELECT c.k, string_agg(row_to_json(q)::text, '|' ORDER BY q.zone_id)
  FROM pq_cases c LEFT JOIN LATERAL public.public_quote('walk-priced-proof-q', c.zip, c.dogs, c.freq, c.tier) q ON true
 GROUP BY c.k;

-- ── The three migrations, inside this transaction ─────────────────────────
\i :pricing
\i :invoice
\i :portal

-- ── 1. The pet-waste quote is what it was ─────────────────────────────────
DO $$
DECLARE _r record; _after text; _as_pw text; _n int := 0;
BEGIN
  FOR _r IN SELECT c.*, b.j FROM pq_cases c JOIN pq_before b ON b.k = c.k LOOP
    SELECT string_agg(row_to_json(q)::text, '|' ORDER BY q.zone_id) INTO _after
      FROM public.public_quote('walk-priced-proof-q', _r.zip, _r.dogs, _r.freq, _r.tier) q;
    SELECT string_agg(row_to_json(q)::text, '|' ORDER BY q.zone_id) INTO _as_pw
      FROM public.public_quote('walk-priced-proof-q', _r.zip, _r.dogs, _r.freq, _r.tier,
                               (SELECT s.id FROM public.services s
                                 WHERE s.organization_id = '05500000-0000-4000-8000-0000000000aa'
                                   AND lower(s.name) = 'pet waste removal')) q;
    IF _after IS DISTINCT FROM _r.j THEN
      RAISE EXCEPTION 'PROOF FAILED [same quote, %]: before % / after %', _r.k, _r.j, _after;
    END IF;
    IF _as_pw IS DISTINCT FROM _r.j THEN
      RAISE EXCEPTION 'PROOF FAILED [same quote, % as pet waste]: before % / after %', _r.k, _r.j, _as_pw;
    END IF;
    _n := _n + 1;
  END LOOP;
  IF _n <> 4 THEN RAISE EXCEPTION 'PROOF FAILED [same quote]: % cases compared, expected 4', _n; END IF;
  -- The row was not empty: the comparison compared something.
  IF (SELECT j FROM pq_before WHERE k = 'two-monthly') NOT LIKE '%"recurring_price_cents":8000%'
     OR (SELECT j FROM pq_before WHERE k = 'two-monthly') NOT LIKE '%"initial_cleanup_cents":8500%'
     OR (SELECT j FROM pq_before WHERE k = 'two-monthly') NOT LIKE '%"first_cleanup_label":"1-4 weeks"%' THEN
    RAISE EXCEPTION 'PROOF FAILED [same quote]: the monthly row does not carry the zone price and the tier: %',
      (SELECT j FROM pq_before WHERE k = 'two-monthly');
  END IF;
  IF (SELECT j FROM pq_before WHERE k = 'nowhere') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [same quote]: a ZIP nobody serves was quoted';
  END IF;
  IF (SELECT already FROM pq_meta) THEN
    RAISE NOTICE 'ok: the pet-waste quote, with no service and with the pet-waste service, is byte-for-byte the row the NEW function returned before (the stack already had the migration, so stability is what was measured)';
  ELSE
    RAISE NOTICE 'ok: the pet-waste quote, with no service and with the pet-waste service, is byte-for-byte the row the OLD function returned';
  END IF;
END $$;

-- ── 2. A walk is priced as a walk ─────────────────────────────────────────
DO $$
DECLARE r record; _n int;
BEGIN
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a1');
  IF r.base_price_cents <> 2500 OR r.recurring_price_cents <> 2500 OR r.per_dog_addl_cents <> 500
     OR r.initial_cleanup_cents <> 0 OR r.first_cleanup_mode <> 'off' OR r.first_cleanup_label IS NOT NULL
     OR r.first_cleanup_options <> '[]'::jsonb OR r.zone_id <> '25500000-0000-4000-8000-0000000000a1'
     OR r.zone_name <> 'Q Zone' OR r.currency <> 'usd' THEN
    RAISE EXCEPTION 'PROOF FAILED [walk]: one dog weekly quoted %', row_to_json(r);
  END IF;
  -- Three dogs, biweekly: two extra dogs at $5, and NO cadence multiplier.
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 3, 'biweekly', NULL, '55500000-0000-4000-8000-0000000000a1');
  IF r.base_price_cents <> 3500 OR r.recurring_price_cents <> 3500 THEN
    RAISE EXCEPTION 'PROOF FAILED [walk]: three dogs biweekly quoted % (a walk costs the same whatever the cadence)', row_to_json(r);
  END IF;
  -- An hourly groom at its own 90 minutes, two pets: (60 + 10) × 1.5.
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 2, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a2');
  IF r.recurring_price_cents <> 10500 THEN
    RAISE EXCEPTION 'PROOF FAILED [groom]: quoted %', row_to_json(r);
  END IF;
  -- A nightly stay: one night is a visit.
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a3');
  IF r.recurring_price_cents <> 6000 THEN
    RAISE EXCEPTION 'PROOF FAILED [stay]: quoted %', row_to_json(r);
  END IF;
  -- An unpriced service: the row, with no price to charge.
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a4');
  IF r.organization_id IS NULL OR r.base_price_cents IS NOT NULL OR r.recurring_price_cents IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [unpriced]: quoted %', row_to_json(r);
  END IF;
  -- A deactivated service, another business's service, a ZIP nobody serves: nothing.
  SELECT count(*) INTO _n FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a5');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [retired]: a deactivated service was quoted'; END IF;
  SELECT count(*) INTO _n FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000b1');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [other business]: R''s walk was quoted on Q''s page'; END IF;
  SELECT count(*) INTO _n FROM public.public_quote('walk-priced-proof-q', '99999', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a1');
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [nowhere]: a walk was quoted where the business does not go'; END IF;
  -- R's own page quotes R's walk.
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-r', '60602', 2, 'weekly', NULL, '55500000-0000-4000-8000-0000000000b1');
  IF r.recurring_price_cents <> 1800 THEN
    RAISE EXCEPTION 'PROOF FAILED [R]: quoted %', row_to_json(r);
  END IF;
  RAISE NOTICE 'ok: a walk, a groom and a stay are priced from the service with no cadence multiplier and no first cleanup; unpriced is NULL; retired, foreign and out-of-area are nothing';
END $$;

-- ── 3. anon prices only through public_quote ──────────────────────────────
SET ROLE anon;
DO $$
DECLARE r record; _err text;
BEGIN
  SELECT * INTO r FROM public.public_quote('walk-priced-proof-q', '60601', 1, 'weekly', NULL, '55500000-0000-4000-8000-0000000000a1');
  IF r.recurring_price_cents <> 2500 THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: the signup page cannot price a walk: %', row_to_json(r);
  END IF;
  BEGIN
    PERFORM public.service_price_cents('visit', 2500, 500, 30);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call service_price_cents'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.service_line_item_name('x');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call service_line_item_name'; END IF;
  RAISE NOTICE 'ok: anon prices a walk through public_quote and cannot call the helpers';
END $$;
RESET ROLE;

-- ── 4. The invoice names the service ──────────────────────────────────────
-- Two postpaid plans, a cleanup and a walk, each with a completed visit last
-- week; then two prepaid plans with a visit next week. The pet-waste lines
-- must read exactly as they always did.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on, billing_cadence, service_id)
SELECT x.id::uuid, '05500000-0000-4000-8000-0000000000aa', 'c5500000-0000-4000-8000-0000000000a1',
       'e5500000-0000-4000-8000-0000000000a1', 'residential', 'weekly', x.price, 1, p.today - 14, x.cadence::billing_cadence, x.svc::uuid
  FROM proof_day p, (VALUES
    ('d5500000-0000-4000-8000-0000000000a1', 2000, 'postpaid', :'pw_id'),
    ('d5500000-0000-4000-8000-0000000000a2', 2500, 'postpaid', '55500000-0000-4000-8000-0000000000a1'),
    ('d5500000-0000-4000-8000-0000000000a3', 2000, 'prepaid',  :'pw_id'),
    ('d5500000-0000-4000-8000-0000000000a4', 6000, 'prepaid',  '55500000-0000-4000-8000-0000000000a3')
  ) AS x(id, price, cadence, svc);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status, price_cents)
SELECT x.id::uuid, '05500000-0000-4000-8000-0000000000aa', x.sub::uuid, 'c5500000-0000-4000-8000-0000000000a1',
       'e5500000-0000-4000-8000-0000000000a1', p.today + x.offs, x.status::visit_status, x.price
  FROM proof_day p, (VALUES
    ('f5500000-0000-4000-8000-0000000000a1', 'd5500000-0000-4000-8000-0000000000a1', -7, 'completed', 2000),
    ('f5500000-0000-4000-8000-0000000000a2', 'd5500000-0000-4000-8000-0000000000a2', -7, 'completed', 2500),
    ('f5500000-0000-4000-8000-0000000000a3', 'd5500000-0000-4000-8000-0000000000a3', 7, 'scheduled', NULL),
    ('f5500000-0000-4000-8000-0000000000a4', 'd5500000-0000-4000-8000-0000000000a4', 7, 'scheduled', NULL)
  ) AS x(id, sub, offs, status, price);

DO $$
DECLARE _inv uuid; _pw text; _walk text; _n int;
BEGIN
  -- The visits carry their service (phase 2's trigger copied the plan's).
  IF (SELECT service_id FROM public.visits WHERE id = 'f5500000-0000-4000-8000-0000000000a2') <> '55500000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice]: the walk visit does not carry the walk';
  END IF;
  _inv := public.admin_generate_invoice_for_client('c5500000-0000-4000-8000-0000000000a1', (SELECT today FROM proof_day));
  IF _inv IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [invoice]: no postpaid invoice was generated'; END IF;
  SELECT description INTO _pw FROM public.invoice_line_items WHERE invoice_id = _inv AND visit_id = 'f5500000-0000-4000-8000-0000000000a1';
  SELECT description INTO _walk FROM public.invoice_line_items WHERE invoice_id = _inv AND visit_id = 'f5500000-0000-4000-8000-0000000000a2';
  IF _pw IS DISTINCT FROM 'Service on ' || to_char((SELECT today FROM proof_day) - 7, 'YYYY-MM-DD') || ' - 412 Elm St' THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice]: the pet-waste line changed: %', _pw;
  END IF;
  IF _walk IS DISTINCT FROM '30-minute walk on ' || to_char((SELECT today FROM proof_day) - 7, 'YYYY-MM-DD') || ' - 412 Elm St' THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice]: the walk line does not name the walk: %', _walk;
  END IF;
  -- The amounts are the visits' own (the 20260903150000 freeze survived).
  IF (SELECT amount_cents FROM public.invoice_line_items WHERE invoice_id = _inv AND visit_id = 'f5500000-0000-4000-8000-0000000000a2') <> 2500 THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice]: the walk line is not priced from the visit';
  END IF;
  RAISE NOTICE 'ok: the postpaid invoice reads "Service on ..." for the cleanup and "30-minute walk on ..." for the walk, each at the visit''s price';
END $$;

-- The prepaid generator checks manage_client_billing: the owner.
SELECT set_config('request.jwt.claims', json_build_object('sub', 'a5500000-0000-4000-8000-0000000000a1', 'role', 'authenticated')::text, true);
DO $$
DECLARE _inv uuid; _d text; _day text := to_char((SELECT today FROM proof_day) + 7, 'YYYY-MM-DD');
BEGIN
  _inv := public.generate_prepaid_invoice('d5500000-0000-4000-8000-0000000000a3', 1);
  SELECT description INTO _d FROM public.invoice_line_items WHERE invoice_id = _inv AND visit_id = 'f5500000-0000-4000-8000-0000000000a3';
  IF _d IS DISTINCT FROM 'Prepaid service on ' || _day THEN
    RAISE EXCEPTION 'PROOF FAILED [prepaid]: the pet-waste line changed: %', _d;
  END IF;
  _inv := public.generate_prepaid_invoice('d5500000-0000-4000-8000-0000000000a4', 1);
  SELECT description INTO _d FROM public.invoice_line_items WHERE invoice_id = _inv AND visit_id = 'f5500000-0000-4000-8000-0000000000a4';
  IF _d IS DISTINCT FROM 'Prepaid Overnight stay on ' || _day THEN
    RAISE EXCEPTION 'PROOF FAILED [prepaid]: the stay line does not name the stay: %', _d;
  END IF;
  RAISE NOTICE 'ok: the prepaid invoice reads "Prepaid service on ..." for the cleanup and "Prepaid Overnight stay on ..." for the stay';
END $$;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── 5. A customer asks for a walk ─────────────────────────────────────────
DO $$
DECLARE _r record; _day date := (SELECT today FROM proof_day) + 3; _err text; _svc uuid;
BEGIN
  -- No service: the extra cleanup, as every request before.
  SELECT * INTO _r FROM public.portal_request_one_off('a5500000-0000-4000-8000-00000000c0de', 'e5500000-0000-4000-8000-0000000000a1', _day, 'as before');
  IF NOT _r.created THEN RAISE EXCEPTION 'PROOF FAILED [portal]: the first request was not created'; END IF;
  SELECT service_id INTO _svc FROM public.qc_tickets WHERE id = _r.ticket_id;
  IF _svc IS NOT NULL THEN RAISE EXCEPTION 'PROOF FAILED [portal]: a request with no service recorded %', _svc; END IF;

  -- A walk, another day: recorded.
  SELECT * INTO _r FROM public.portal_request_one_off('a5500000-0000-4000-8000-00000000c0de', 'e5500000-0000-4000-8000-0000000000a1', _day + 1, 'a walk please', '55500000-0000-4000-8000-0000000000a1');
  IF NOT _r.created THEN RAISE EXCEPTION 'PROOF FAILED [portal]: the walk request was not created'; END IF;
  SELECT service_id INTO _svc FROM public.qc_tickets WHERE id = _r.ticket_id;
  IF _svc IS DISTINCT FROM '55500000-0000-4000-8000-0000000000a1' THEN
    RAISE EXCEPTION 'PROOF FAILED [portal]: the walk request recorded %', _svc;
  END IF;

  -- Another business's service, and a retired one: refused, the same way.
  BEGIN
    PERFORM public.portal_request_one_off('a5500000-0000-4000-8000-00000000c0de', 'e5500000-0000-4000-8000-0000000000a1', _day + 2, '', '55500000-0000-4000-8000-0000000000b1');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'service_not_offered' THEN RAISE EXCEPTION 'PROOF FAILED [portal]: R''s walk was % on Q''s portal', COALESCE(_err, 'accepted'); END IF;
  _err := NULL;
  BEGIN
    PERFORM public.portal_request_one_off('a5500000-0000-4000-8000-00000000c0de', 'e5500000-0000-4000-8000-0000000000a1', _day + 2, '', '55500000-0000-4000-8000-0000000000a5');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'service_not_offered' THEN RAISE EXCEPTION 'PROOF FAILED [portal]: a retired walk was % on the portal', COALESCE(_err, 'accepted'); END IF;

  -- The old rules still hold, after the service check.
  _err := NULL;
  BEGIN
    PERFORM public.portal_request_one_off('a5500000-0000-4000-8000-00000000c0de', 'e5500000-0000-4000-8000-0000000000a1', (SELECT today FROM proof_day) + 31, '', '55500000-0000-4000-8000-0000000000a1');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS DISTINCT FROM 'date_too_far' THEN RAISE EXCEPTION 'PROOF FAILED [portal]: 31 days out was %', COALESCE(_err, 'accepted'); END IF;

  IF has_function_privilege('anon', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_request_one_off(uuid, uuid, date, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [portal]: an API role can call portal_request_one_off';
  END IF;
  RAISE NOTICE 'ok: a portal request records the service asked for, refuses another business''s or a retired one, and keeps every older rule';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL PRICING PROOFS PASSED'; END $$;
ROLLBACK;
