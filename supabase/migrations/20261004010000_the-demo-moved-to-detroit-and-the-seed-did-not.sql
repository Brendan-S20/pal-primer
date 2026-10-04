-- The demo moved to Detroit and the seed did not.
--
-- On 2026-08-30 the production demo was moved by hand from Manhattan to the
-- Detroit suburbs: every address, every pin, every yard outline and the
-- technicians' depot (docs/owner-actions-before-submission.md, section 7).
-- seed_demo_org was not moved with it. It still wrote ten properties in
-- "New York", ZIPs 10001-10024, pins at 40.7 N 74 W, two zones matching
-- Manhattan ZIPs and a Manhattan polygon, three leads asking about Manhattan
-- ZIPs, and a depot on W 34th St. So pressing Reseed on Settings -> Business
-- put the demo back in New York, undoing the relocation in one click, with
-- routing settings (20260911200000) tuned for suburban Detroit driving a
-- Manhattan grid. Owner decision 2026-10-03: the seeder produces Detroit.
-- (Production's own demo zones were rewritten to Detroit ZIPs by hand the
-- same day; this file touches only the function, not any org's rows.)
--
-- What it writes now, all of it metro Detroit, Oakland County:
--
--   Downtown Core    ZIP zone, flat:  48067 Royal Oak, 48220 Ferndale,
--                                     48072 Berkley
--   Westside Suburb  polygon zone, per sq ft:  48009 Birmingham,
--                    48301 Bloomfield Hills; box 42.525-42.565 N,
--                    83.300-83.195 W; centre 42.545, -83.2475; radius 5 km
--   Properties       six in the ZIP zone, four in the polygon, region MI,
--                    every pin inside its own ZIP's Census area, every yard
--                    outline a square of its own area around its own pin
--   Depot            1750 E Lincoln Ave, Royal Oak, MI 48067 -- the address
--                    production's staff were given in the relocation
--   Leads            48301, 48067, 48220
--
-- One fault fixed on the way: DEMO-03 was ZIP 10023 (a suburb ZIP) on a
-- point inside the suburb polygon while the seed put it in the urban zone,
-- so the matcher and the seed disagreed about it from the first render.
-- Every property's zone is now the one src/lib/zone-match.ts would choose,
-- and auto_zone_id -- what the matcher detected -- is written to match, so
-- the Properties tab does not show a seeded property as hand-overridden.
--
-- Not touched: the org's timezone. The seed reads it and never sets it, and
-- the production demo is on America/New_York (same offset and rules as
-- America/Detroit; see section 7). Client names, emails, phones and the
-- 'America/Chicago' fallback for an org with no timezone are unchanged.
--
-- Spliced by name against the body 20261001010000 left, raising if it is not
-- that body. A full CREATE OR REPLACE would restate ~600 lines to change four
-- blocks, and would have to carry 20260930010000's and 20261001010000's
-- splices forward by hand; a splice carries them by construction.
--
-- Replays into an empty database: it only redefines the function, and the
-- check at the end asserts what the new body says, not anything about rows.

DO $splice$
DECLARE
  _def text;
  _new text;
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);
  IF strpos(_def, 'Depot — 1750 E Lincoln Ave, Royal Oak, MI 48067') > 0
     AND strpos(_def, 'New York') = 0 THEN
    RETURN;  -- already spliced
  END IF;

  -- The two zones.
  _new := replace(_def,
$z0$  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode)
  VALUES (_org_id, 'Downtown Core', ARRAY['10001','10002','10003'], 2500, 500, 4500, 'zip', 'flat')
  RETURNING id INTO z_urban;

  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode, price_per_sqft_cents,
                            area_min_charge_cents, boundary,
                            center_latitude, center_longitude, radius_meters)
  VALUES (_org_id, 'Westside Suburb', ARRAY['10023','10024'], 2000, 400, 4000,
          'polygon', 'per_sqft', 0.75, 2500,
          '{"type":"Polygon","coordinates":[[[-73.99,40.77],[-73.97,40.77],[-73.97,40.79],[-73.99,40.79],[-73.99,40.77]]]}'::jsonb,
          40.78, -73.98, 3000)
  RETURNING id INTO z_suburb;$z0$,
$z1$  -- Metro Detroit, where the demo's own business is (20261004010000). The two
  -- names are kept: the E2E specs and the production demo org know these zones
  -- by them. Downtown Core is the Woodward corridor by ZIP -- Royal Oak,
  -- Ferndale, Berkley. Westside Suburb is Birmingham and Bloomfield Hills: a
  -- polygon whose box holds exactly those two ZIP centers, the same two ZIPs
  -- listed so a visitor quoting by ZIP alone lands in it too, and a centre and
  -- radius that reach every corner of the box. Nothing in Downtown Core sits
  -- inside the polygon, so the matcher (polygon before ZIP) agrees with the
  -- zone_id written below for every property.
  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode)
  VALUES (_org_id, 'Downtown Core', ARRAY['48067','48220','48072'], 2500, 500, 4500, 'zip', 'flat')
  RETURNING id INTO z_urban;

  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode, price_per_sqft_cents,
                            area_min_charge_cents, boundary,
                            center_latitude, center_longitude, radius_meters)
  VALUES (_org_id, 'Westside Suburb', ARRAY['48009','48301'], 2000, 400, 4000,
          'polygon', 'per_sqft', 0.75, 2500,
          '{"type":"Polygon","coordinates":[[[-83.3000,42.5250],[-83.1950,42.5250],[-83.1950,42.5650],[-83.3000,42.5650],[-83.3000,42.5250]]]}'::jsonb,
          42.5450, -83.2475, 5000)
  RETURNING id INTO z_suburb;$z1$);
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer writes its two zones the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- The ten properties.
  _new := replace(_def,
$p0$  INSERT INTO public.properties (organization_id, client_id, zone_id, street, city, postal_code,
        yard_size, latitude, longitude, boundary, boundary_area_sqm,
        aggressive_dog, invisible_fence, do_not_enter_if_dog_out, access_notes)
  SELECT _org_id, c.id,
         CASE WHEN d.zone = 'urban' THEN z_urban ELSE z_suburb END,
         d.street, 'New York', d.zip, d.yard, d.lat, d.lon,
         d.boundary::jsonb, d.area, d.aggressive, d.fence, d.no_enter, d.notes
  FROM (VALUES
    ('DEMO-01','142 W 74th St',    '10023','suburb','medium',40.7773,-73.9778,'{"type":"Polygon","coordinates":[[[-73.978,40.777],[-73.9775,40.777],[-73.9775,40.7775],[-73.978,40.7775],[-73.978,40.777]]]}', 280::numeric,  false,true, false,'Side gate — please close firmly on the way out'),
    ('DEMO-02','86 Bedford Ave',   '10024','suburb','large', 40.7863,-73.9836,'{"type":"Polygon","coordinates":[[[-73.984,40.786],[-73.9832,40.786],[-73.9832,40.7867],[-73.984,40.7867],[-73.984,40.786]]]}', 540::numeric,  false,false,false,'Gate is unlocked during service hours; dogs stay indoors'),
    ('DEMO-03','2005 Broadway',    '10023','urban', 'small', 40.7752,-73.9799,'{"type":"Polygon","coordinates":[[[-73.98,40.775],[-73.9797,40.775],[-73.9797,40.7754],[-73.98,40.7754],[-73.98,40.775]]]}',   120::numeric,  true, false,true, 'Rex is reactive — do not enter the yard if he is out'),
    ('DEMO-04','311 E 12th St',    '10003','urban', 'medium',40.7322,-73.9837,'{"type":"Polygon","coordinates":[[[-73.984,40.732],[-73.9835,40.732],[-73.9835,40.7325],[-73.984,40.7325],[-73.984,40.732]]]}', 260::numeric,  false,false,false,'Straight through the side path, bins are by the shed'),
    ('DEMO-05','77 Riverside Dr',  '10024','suburb','xlarge',40.7905,-73.9840,'{"type":"Polygon","coordinates":[[[-73.986,40.789],[-73.982,40.789],[-73.982,40.792],[-73.986,40.792],[-73.986,40.789]]]}',  12000::numeric,false,false,false,'On-site contact is the property manager at the clubhouse'),
    ('DEMO-06','450 Brookline Pl', '10001','urban', 'xlarge',40.7495,-73.9935,'{"type":"Polygon","coordinates":[[[-73.995,40.748],[-73.992,40.748],[-73.992,40.751],[-73.995,40.751],[-73.995,40.748]]]}',  9000::numeric, false,false,false,'Loading dock on the north side; use bay 2'),
    ('DEMO-07','58 Morton St',     '10003','urban', 'small', 40.7311,-74.0044,'{"type":"Polygon","coordinates":[[[-74.005,40.731],[-74.0045,40.731],[-74.0045,40.7314],[-74.005,40.7314],[-74.005,40.731]]]}',150::numeric,  false,false,false,'Rear yard, entrance through the alley'),
    ('DEMO-08','19 Bank St',       '10002','urban', 'medium',40.7359,-74.0021,'{"type":"Polygon","coordinates":[[[-74.003,40.735],[-74.0025,40.735],[-74.0025,40.7356],[-74.003,40.7356],[-74.003,40.735]]]}',230::numeric,  false,true, false,'Invisible fence is live — collar stays on the dog'),
    ('DEMO-09','904 Amsterdam Ave','10024','suburb','medium',40.7981,-73.9683,'{"type":"Polygon","coordinates":[[[-73.969,40.798],[-73.9685,40.798],[-73.9685,40.7985],[-73.969,40.7985],[-73.969,40.798]]]}',245::numeric,  false,false,false,'Two dogs, both friendly; leave the ticket on the door'),
    ('DEMO-10','12 Harborview Ln', '10001','urban', 'xlarge',40.7442,-74.0090,'{"type":"Polygon","coordinates":[[[-74.010,40.744],[-74.007,40.744],[-74.007,40.746],[-74.010,40.746],[-74.010,40.744]]]}', 7600::numeric, false,false,false,'Six buildings — service the shared greens only')
  ) AS d(ext, street, zip, zone, yard, lat, lon, boundary, area, aggressive, fence, no_enter, notes)
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext;$p0$,
$p1$  -- House numbers are invented; the streets are real to their towns, and each
  -- pin sits inside its ZIP's Census area, so a map, the ZIP and the zone all
  -- say the same place. Each boundary is a square of the yard's own area
  -- centred on its pin. auto_zone_id is what the matcher detects, and the
  -- zone here is exactly that, so the two agree from the first render.
  INSERT INTO public.properties (organization_id, client_id, zone_id, auto_zone_id, street, city,
        region, postal_code, yard_size, latitude, longitude, boundary, boundary_area_sqm,
        aggressive_dog, invisible_fence, do_not_enter_if_dog_out, access_notes)
  SELECT _org_id, c.id,
         CASE WHEN d.zone = 'urban' THEN z_urban ELSE z_suburb END,
         CASE WHEN d.zone = 'urban' THEN z_urban ELSE z_suburb END,
         d.street, d.city, 'MI', d.zip, d.yard, d.lat, d.lon,
         d.boundary::jsonb, d.area, d.aggressive, d.fence, d.no_enter, d.notes
  FROM (VALUES
    ('DEMO-01','742 Pierce St',      'Birmingham',      '48009','suburb','medium',42.5478,-83.2139,'{"type":"Polygon","coordinates":[[[-83.214,42.54772],[-83.2138,42.54772],[-83.2138,42.54788],[-83.214,42.54788],[-83.214,42.54772]]]}',           280::numeric,  false,true, false,'Side gate — please close firmly on the way out'),
    ('DEMO-02','612 Henrietta St',   'Birmingham',      '48009','suburb','large', 42.5491,-83.2186,'{"type":"Polygon","coordinates":[[[-83.21874,42.549],[-83.21846,42.549],[-83.21846,42.5492],[-83.21874,42.5492],[-83.21874,42.549]]]}',           540::numeric,  false,false,false,'Gate is unlocked during service hours; dogs stay indoors'),
    ('DEMO-03','814 S Lafayette Ave','Royal Oak',       '48067','urban', 'small', 42.4823,-83.1428,'{"type":"Polygon","coordinates":[[[-83.14287,42.48225],[-83.14273,42.48225],[-83.14273,42.48235],[-83.14287,42.48235],[-83.14287,42.48225]]]}', 120::numeric,  true, false,true, 'Rex is reactive — do not enter the yard if he is out'),
    ('DEMO-04','1407 E Fourth St',   'Royal Oak',       '48067','urban', 'medium',42.4885,-83.1282,'{"type":"Polygon","coordinates":[[[-83.1283,42.48843],[-83.1281,42.48843],[-83.1281,42.48857],[-83.1283,42.48857],[-83.1283,42.48843]]]}',         260::numeric,  false,false,false,'Straight through the side path, bins are by the shed'),
    ('DEMO-05','4100 Quarton Rd',    'Bloomfield Hills','48301','suburb','xlarge',42.5561,-83.2710,'{"type":"Polygon","coordinates":[[[-83.27167,42.55561],[-83.27033,42.55561],[-83.27033,42.55659],[-83.27167,42.55659],[-83.27167,42.55561]]]}', 12000::numeric,false,false,false,'On-site contact is the property manager at the clubhouse'),
    ('DEMO-06','450 W Nine Mile Rd', 'Ferndale',        '48220','urban', 'xlarge',42.4604,-83.1393,'{"type":"Polygon","coordinates":[[[-83.13988,42.45997],[-83.13872,42.45997],[-83.13872,42.46083],[-83.13988,42.46083],[-83.13988,42.45997]]]}', 9000::numeric, false,false,false,'Loading dock on the north side; use bay 2'),
    ('DEMO-07','533 Leroy St',       'Ferndale',        '48220','urban', 'small', 42.4637,-83.1387,'{"type":"Polygon","coordinates":[[[-83.13877,42.46364],[-83.13863,42.46364],[-83.13863,42.46376],[-83.13877,42.46376],[-83.13877,42.46364]]]}', 150::numeric,  false,false,false,'Rear yard, entrance through the alley'),
    ('DEMO-08','2245 Robina Ave',    'Berkley',         '48072','urban', 'medium',42.5012,-83.1798,'{"type":"Polygon","coordinates":[[[-83.17989,42.50113],[-83.17971,42.50113],[-83.17971,42.50127],[-83.17989,42.50127],[-83.17989,42.50113]]]}', 230::numeric,  false,true, false,'Invisible fence is live — collar stays on the dog'),
    ('DEMO-09','3120 Lahser Rd',     'Bloomfield Hills','48301','suburb','medium',42.5381,-83.2636,'{"type":"Polygon","coordinates":[[[-83.2637,42.53803],[-83.2635,42.53803],[-83.2635,42.53817],[-83.2637,42.53817],[-83.2637,42.53803]]]}',         245::numeric,  false,false,false,'Two dogs, both friendly; leave the ticket on the door'),
    ('DEMO-10','3900 Coolidge Hwy',  'Berkley',         '48072','urban', 'xlarge',42.4925,-83.1838,'{"type":"Polygon","coordinates":[[[-83.18433,42.49211],[-83.18327,42.49211],[-83.18327,42.49289],[-83.18433,42.49289],[-83.18433,42.49211]]]}', 7600::numeric, false,false,false,'Six buildings — service the shared greens only')
  ) AS d(ext, street, city, zip, zone, yard, lat, lon, boundary, area, aggressive, fence, no_enter, notes)
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext;$p1$);
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer writes its properties the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- The depot.
  _new := replace(_def,
$s0$  -- ── STAFF ───────────────────────────────────────────────────────────────
  -- Staff rows are NOT wiped: they carry user_id and are what the demo logins
  -- resolve to. But the seeder decides where this org's work is, so it owns
  -- the depot too. Taylor Tech's start and end address were left at
  -- `1100 E 5th St, Austin, TX 78702` by earlier testing while every seeded
  -- property is in New York — the dispatch map opened zoomed out to the whole
  -- continent with one pin in Texas, and every drive-time estimate was
  -- computed against a depot 1,700 miles from the route.
  UPDATE public.staff
     SET start_latitude  = 40.7484, start_longitude = -73.9857,
         start_address   = 'Depot — 20 W 34th St, New York, NY 10001',
         end_latitude    = 40.7484, end_longitude   = -73.9857,
         end_address     = 'Depot — 20 W 34th St, New York, NY 10001'
   WHERE organization_id = _org_id AND active;$s0$,
$s1$  -- ── STAFF ───────────────────────────────────────────────────────────────
  -- Staff rows are NOT wiped: they carry user_id and are what the demo logins
  -- resolve to. But the seeder decides where this org's work is, so it owns
  -- the depot too, and the depot is where the work is: Royal Oak, between the
  -- Woodward-corridor ZIPs and Birmingham. A start point anywhere else opens
  -- the dispatch map zoomed out to the continent and prices every drive-time
  -- estimate from the wrong city -- which is what a depot left in Texas did to
  -- a route in another state before this block existed.
  UPDATE public.staff
     SET start_latitude  = 42.4826, start_longitude = -83.1236,
         start_address   = 'Depot — 1750 E Lincoln Ave, Royal Oak, MI 48067',
         end_latitude    = 42.4826, end_longitude   = -83.1236,
         end_address     = 'Depot — 1750 E Lincoln Ave, Royal Oak, MI 48067'
   WHERE organization_id = _org_id AND active;$s1$);
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer sets its depot the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- The three leads.
  _new := replace(_def,
$l0$  INSERT INTO public.leads (organization_id, name, email, phone, dog_count, frequency,
        location, source, status, message)
  VALUES
    (_org_id, 'Renee Alvarez', 'renee.a@example.com',  '+15552220001', 2, 'weekly',   '10024', 'website', 'new',       'Two goldens — moving in next month'),
    (_org_id, 'Theo Bright',   'theo.b@example.com',   '+15552220002', 1, 'biweekly', '10003', 'referral','contacted', 'Referred by Emily'),
    (_org_id, 'Lauren Woods',  'lauren.w@example.com', NULL,           3, 'weekly',   '10001', 'website', 'new',       'Big backyard, three dogs');$l0$,
$l1$  INSERT INTO public.leads (organization_id, name, email, phone, dog_count, frequency,
        location, source, status, message)
  VALUES
    (_org_id, 'Renee Alvarez', 'renee.a@example.com',  '+15552220001', 2, 'weekly',   '48301', 'website', 'new',       'Two goldens — moving in next month'),
    (_org_id, 'Theo Bright',   'theo.b@example.com',   '+15552220002', 1, 'biweekly', '48067', 'referral','contacted', 'Referred by Emily'),
    (_org_id, 'Lauren Woods',  'lauren.w@example.com', NULL,           3, 'weekly',   '48220', 'website', 'new',       'Big backyard, three dogs');$l1$);
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer writes its leads the way this splice expects; re-cut it against the current body.';
  END IF;

  EXECUTE _new;
END
$splice$;

REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated, service_role;

-- What this file establishes, read off the body it leaves: no New York, every
-- ZIP literal Michigan's, every coordinate-shaped number inside metro Detroit,
-- every property written with region MI, and still no anon caller. Nothing
-- here reads a row, so it holds on an empty database and on production alike.
DO $check$
DECLARE
  _seed text;
  _m text[];
  _zips int := 0;
  _coords int := 0;
BEGIN
  SELECT prosrc INTO _seed FROM pg_proc WHERE oid = 'public.seed_demo_org(uuid)'::regprocedure;
  IF _seed ~* 'New York|Manhattan|, NY [0-9]' THEN
    RAISE EXCEPTION 'seed_demo_org still writes New York';
  END IF;
  FOR _m IN SELECT regexp_matches(_seed, '''([0-9]{5})''', 'g') LOOP
    _zips := _zips + 1;
    IF _m[1] !~ '^48[0-9]{3}$' THEN
      RAISE EXCEPTION 'seed_demo_org still writes ZIP %, which is not metro Detroit', _m[1];
    END IF;
  END LOOP;
  FOR _m IN SELECT regexp_matches(_seed, '(-?[0-9]{2,3}\.[0-9]{3,})', 'g') LOOP
    _coords := _coords + 1;
    IF NOT (_m[1]::numeric BETWEEN 42.0 AND 42.9 OR _m[1]::numeric BETWEEN -83.6 AND -82.8) THEN
      RAISE EXCEPTION 'seed_demo_org still writes the coordinate %, which is not metro Detroit', _m[1];
    END IF;
  END LOOP;
  -- Five zone ZIPs, ten properties, three leads; ten pins, ten outlines, one
  -- polygon, a centre and a depot. Fewer would mean the scan above found
  -- nothing to check, which must not read as a pass.
  IF _zips < 18 OR _coords < 40 THEN
    RAISE EXCEPTION 'seed_demo_org: expected the Detroit literals this file wrote, found % ZIPs and % coordinates', _zips, _coords;
  END IF;
  IF strpos(_seed, 'd.street, d.city, ''MI'', d.zip') = 0 THEN
    RAISE EXCEPTION 'seed_demo_org does not write its properties as Michigan';
  END IF;
  IF has_function_privilege('anon', 'public.seed_demo_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reseed an organization';
  END IF;
END
$check$;
