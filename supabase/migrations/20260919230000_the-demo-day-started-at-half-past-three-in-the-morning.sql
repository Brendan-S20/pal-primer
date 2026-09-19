-- The demo day started at half past three in the morning.
--
-- seed_demo_org built every visit timestamp as
-- `(day + time '07:30')::timestamptz`. The addition yields a `timestamp
-- without time zone`, and the bare cast resolves it against the SESSION
-- TimeZone -- UTC on Supabase -- so "07:30, where this business operates" was
-- stored as 07:30Z. Rendered on any American clock, the demo org's whole day
-- ran from before dawn: 3:30 AM Eastern, 2:30 AM Central. Found on 2026-09-19
-- by a UX pass over the seeded org, where every screenshot -- including the
-- set the App Store submission wants -- said the crew works by headlamp.
--
-- Production never had this fault: optimize_route_v2 anchors
-- `(day + workday_start) AT TIME ZONE org.timezone` (route-window.ts's
-- zonedTimeToUtc is the TypeScript mirror of that contract, and its test
-- asserts "never 3-4 AM"). The seed simply did not follow the contract the
-- product it demos already keeps. The fix is the same expression, against the
-- org's own timezone with the same coalesce the rest of the schema uses --
-- eight casts, all named below, none surviving (a regex over the new body
-- asserts no bare wall-clock cast remains before this file was committed).
--
-- The body below is NOT a copy of 20260802174000: 20260903170000 spliced the
-- demo photo insert out of the live function (42 rows pointing at storage
-- objects that never existed), and a fresh definition that resurrected it
-- would undo that fix silently. The splice is carried forward here, and
-- tests/a-photo-row-that-pointed-at-no-photo.test.ts is what caught the first
-- draft of this file doing exactly that resurrection.
--
-- Replays into an empty database: this file only redefines the function -- it
-- asserts nothing about rows, cron, or operations state. Already-seeded demo
-- orgs keep their pre-dawn timestamps until someone presses Reseed, which
-- re-runs this function through the product's own path.

CREATE OR REPLACE FUNCTION public.seed_demo_org(_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  is_authorized boolean;
  _tz text;
  z_urban uuid;
  z_suburb uuid;
  gc uuid;
  inv uuid;
  vrec record;
  crec record;
  staff_ids uuid[];
  n_staff int;
  idx int := 0;
  today date := current_date;
  today_dow int := EXTRACT(DOW FROM current_date)::int;
  som date := date_trunc('month', current_date)::date;
  -- Always inside the current calendar month AND never in the future, on every
  -- day of the month including the 1st.
  mtd_day date := GREATEST(date_trunc('month', current_date)::date, current_date - 3);
  month_end date;
  m int;
  today_total int;
  n_completed_today int;
BEGIN
  SELECT public.is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND organization_id = _org_id
        AND role IN ('owner','office_manager'))
  INTO is_authorized;
  IF NOT is_authorized THEN
    RAISE EXCEPTION 'Not authorized to reseed this organization';
  END IF;

  -- The org's wall clock. Every visit timestamp below is a WALL-CLOCK intent
  -- ("07:30, where this business operates"), and `AT TIME ZONE` on the naive
  -- timestamp is what stores that intent as the right instant. The bare
  -- `::timestamptz` casts this replaces resolved against the SESSION zone --
  -- UTC on Supabase -- so 07:30 was stored as 07:30Z and every demo day
  -- started at half past three in the morning Eastern. Same coalesce as the
  -- SQL default and org-day.ts's DEFAULT_ORG_TIMEZONE; if these disagree, two
  -- layers put the same visit at two times.
  SELECT COALESCE(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _org_id;

  UPDATE public.organizations SET
    brand_color   = COALESCE(brand_color,   '#16a34a'),
    contact_phone = COALESCE(contact_phone, '+15551234567'),
    contact_email = COALESCE(contact_email, 'hello@' || COALESCE(slug,'demo') || '.example')
   WHERE id = _org_id;

  -- ── WIPE ────────────────────────────────────────────────────────────────
  -- Every delete here is scoped to _org_id. The order is FK order: invoices
  -- reference clients ON DELETE RESTRICT, so invoices and their line items go
  -- before clients; everything else cascades but is deleted explicitly so the
  -- set is legible rather than implied.
  DELETE FROM public.visit_photos
    WHERE organization_id = _org_id
      AND visit_id IN (SELECT id FROM public.visits WHERE organization_id = _org_id);
  DELETE FROM public.qc_tickets    WHERE organization_id = _org_id;
  DELETE FROM public.invoice_line_items
    WHERE invoice_id IN (SELECT id FROM public.invoices WHERE organization_id = _org_id);
  -- addon_subscriptions holds the only two edges in this graph that neither
  -- cascade nor null out: RESTRICT to addon_services and NO ACTION to
  -- properties. Both are deleted below, so it has to go first or the whole
  -- reseed aborts on a foreign key — which is exactly what the first dry run
  -- did.
  DELETE FROM public.addon_charges WHERE organization_id = _org_id;
  DELETE FROM public.addon_subscriptions WHERE organization_id = _org_id;
  DELETE FROM public.credit_ledger WHERE organization_id = _org_id;
  DELETE FROM public.payments      WHERE organization_id = _org_id;
  DELETE FROM public.invoices      WHERE organization_id = _org_id;
  DELETE FROM public.station_service_logs WHERE organization_id = _org_id;
  DELETE FROM public.waste_stations WHERE organization_id = _org_id;
  DELETE FROM public.visits        WHERE organization_id = _org_id;
  DELETE FROM public.subscriptions WHERE organization_id = _org_id;
  DELETE FROM public.dogs          WHERE organization_id = _org_id;
  DELETE FROM public.properties    WHERE organization_id = _org_id;
  DELETE FROM public.addon_services WHERE organization_id = _org_id;
  DELETE FROM public.gift_card_redemptions
    WHERE gift_card_id IN (SELECT id FROM public.gift_cards WHERE organization_id = _org_id);
  DELETE FROM public.gift_cards    WHERE organization_id = _org_id;
  DELETE FROM public.promo_codes   WHERE organization_id = _org_id;

  -- Scoped. The previous version deleted the whole table across every tenant.
  DELETE FROM public.leads         WHERE organization_id = _org_id;

  -- `referred_by_client_id` is a self-reference with ON DELETE SET NULL, so
  -- one statement is enough; the RESTRICT edge from invoices is already clear.
  DELETE FROM public.clients       WHERE organization_id = _org_id;

  DELETE FROM public.zones         WHERE organization_id = _org_id;

  -- ── ZONES ───────────────────────────────────────────────────────────────
  INSERT INTO public.zones (organization_id, name, zip_codes, base_price_cents,
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
  RETURNING id INTO z_suburb;

  -- ── CLIENTS ─────────────────────────────────────────────────────────────
  -- `import_external_id` is the join key for everything below, so the seed is
  -- one VALUES list per table instead of ten hand-threaded uuid variables.
  -- It is also what a future wipe could key on if this ever needs to coexist
  -- with real data.
  --
  -- credit_balance_cents is deliberately NOT set here. It is maintained by the
  -- trigger on credit_ledger, which RECOUNTS; writing it directly seeds drift.
  INSERT INTO public.clients (organization_id, display_name, account_type, primary_email,
        primary_phone, referral_code, import_source, import_external_id,
        autopay_enabled, default_card_brand, default_card_last4)
  SELECT _org_id, d.nm, d.acct::account_type, d.em, d.ph, d.ref,
         'generic_csv'::import_source, d.ext, d.autopay, d.brand, d.last4
  FROM (VALUES
    ('DEMO-01','Emily & Marc Johnson',      'residential','emily.j@example.com',   '+15551110001','EMILY10', true,  'visa',      '4242'),
    ('DEMO-02','Sophia Ramirez',            'residential','sophia.r@example.com',  '+15551110002','SOPH10',  false, NULL,        NULL),
    ('DEMO-03','David Chen',                'residential','david.c@example.com',   '+15551110003','DAVE10',  true,  'mastercard','5555'),
    ('DEMO-04','Priya Patel',               'residential','priya.p@example.com',   '+15551110004','PRIYA10', false, NULL,        NULL),
    ('DEMO-05','Riverside HOA',             'commercial', 'ops@riverside.example', '+15551110005','RIVER10', true,  'amex',      '0005'),
    ('DEMO-06','Brookline Commercial Plaza','commercial', 'mgmt@brookline.example','+15551110006','BROOK10', false, NULL,        NULL),
    ('DEMO-07','Marcus Bell',               'residential','marcus.b@example.com',  '+15551110007','MARC10',  true,  'visa',      '1881'),
    ('DEMO-08','Alexandra Kim',             'residential','alex.k@example.com',    '+15551110008','ALEX10',  false, NULL,        NULL),
    ('DEMO-09','Nadia Okafor',              'residential','nadia.o@example.com',   '+15551110009','NADIA10', true,  'visa',      '9021'),
    ('DEMO-10','Harborview Townhomes',      'commercial', 'hoa@harborview.example','+15551110010','HARB10',  true,  'mastercard','7314')
  ) AS d(ext, nm, acct, em, ph, ref, autopay, brand, last4);

  UPDATE public.clients SET referred_by_client_id = (
    SELECT id FROM public.clients WHERE organization_id = _org_id AND import_external_id = 'DEMO-01'
  ), referral_applied_at = now() - interval '20 days'
   WHERE organization_id = _org_id AND import_external_id = 'DEMO-02';

  -- ── PROPERTIES ──────────────────────────────────────────────────────────
  -- No gate_code, no lock_box_code, no key_location. The demo org is
  -- screenshotted; nothing in it should look like a credential even when the
  -- credential is invented. `access_notes` carries the same operational
  -- meaning without a number to redact.
  INSERT INTO public.properties (organization_id, client_id, zone_id, street, city, postal_code,
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
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext;

  INSERT INTO public.dogs (organization_id, property_id, name, breed, temperament, weight_class)
  SELECT _org_id, p.id, d.nm, d.breed, d.tmpr::dog_temperament, d.wc
  FROM (VALUES
    ('DEMO-01','Cooper',  'Golden Retriever','friendly',  'large'),
    ('DEMO-01','Bella',   'Beagle',          'friendly',  'medium'),
    ('DEMO-02','Luna',    'Poodle Mix',      'friendly',  'medium'),
    ('DEMO-02','Max',     'Labrador',        'friendly',  'large'),
    ('DEMO-02','Charlie', 'French Bulldog',  'nervous',   'small'),
    ('DEMO-03','Rex',     'German Shepherd', 'aggressive','large'),
    ('DEMO-04','Daisy',   'Cavalier',        'friendly',  'small'),
    ('DEMO-07','Scout',   'Border Collie',   'friendly',  'medium'),
    ('DEMO-08','Juno',    'Vizsla',          'friendly',  'medium'),
    ('DEMO-09','Pepper',  'Corgi',           'friendly',  'small'),
    ('DEMO-09','Mochi',   'Shiba Inu',       'nervous',   'small')
  ) AS d(ext, nm, breed, tmpr, wc)
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext
  JOIN public.properties p ON p.client_id = c.id;

  INSERT INTO public.waste_stations (organization_id, client_id, property_id, label,
        location_description, liner_size, capacity_liners, sort_order, active)
  SELECT _org_id, c.id, p.id, d.label, d.loc, d.liner, d.cap, d.ord, true
  FROM (VALUES
    ('DEMO-05','Station A','Front lawn near the pool gate','large', 200,1),
    ('DEMO-05','Station B','Back walking path — north',    'large', 200,2),
    ('DEMO-05','Station C','Back walking path — south',    'large', 200,3),
    ('DEMO-05','Station D','Playground perimeter',         'large', 200,4),
    ('DEMO-05','Station E','Clubhouse patio',              'medium',150,5),
    ('DEMO-05','Station F','Riverside walkway east',       'large', 200,6),
    ('DEMO-05','Station G','Riverside walkway west',       'large', 200,7),
    ('DEMO-05','Station H','Community garden entrance',    'medium',150,8),
    ('DEMO-06','Plaza 1',  'Main entrance turnaround',     'large', 200,1),
    ('DEMO-06','Plaza 2',  'Building A courtyard',         'large', 200,2),
    ('DEMO-06','Plaza 3',  'Building B courtyard',         'large', 200,3),
    ('DEMO-06','Plaza 4',  'Rear parking greenbelt',       'large', 200,4),
    ('DEMO-10','Green 1',  'Central lawn',                 'large', 200,1),
    ('DEMO-10','Green 2',  'East path by the mailboxes',   'medium',150,2),
    ('DEMO-10','Green 3',  'West path by the carports',    'medium',150,3)
  ) AS d(ext, label, loc, liner, cap, ord)
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext
  JOIN public.properties p ON p.client_id = c.id;

  -- ── SUBSCRIPTIONS ───────────────────────────────────────────────────────
  -- `preferred_weekdays` is expressed as an offset from TODAY's weekday, not
  -- as a fixed day. Six of the ten land on today whatever day the reseed runs,
  -- so /my-day and the "Visits today" card are never empty — which is the
  -- whole point of a demo org and is what the previous seeder could not do.
  INSERT INTO public.subscriptions (organization_id, client_id, property_id, zone_id,
        account_type, frequency, price_cents, dog_count, unit_count, billing_cadence,
        preferred_weekdays, status, started_on)
  SELECT _org_id, c.id, p.id, p.zone_id, d.acct::account_type, d.freq::service_frequency,
         d.price, d.dogs, d.units, d.cadence::billing_cadence,
         (SELECT array_agg(((today_dow + wd) % 7)::int) FROM unnest(d.offsets) AS wd),
         'active'::subscription_status, today - d.age
  FROM (VALUES
    ('DEMO-01','residential','weekly',      3000, 2,   NULL::int, 'postpaid', ARRAY[0],   70),
    ('DEMO-02','residential','weekly',      3500, 3,   NULL, 'prepaid',  ARRAY[0],   63),
    ('DEMO-03','residential','biweekly',    2500, 1,   NULL, 'postpaid', ARRAY[4],   84),
    ('DEMO-04','residential','weekly',      2500, 1,   NULL, 'postpaid', ARRAY[0],   56),
    ('DEMO-05','commercial', 'twice_weekly',9500, NULL,8,    'postpaid', ARRAY[0,3], 119),
    ('DEMO-06','commercial', 'weekly',      7500, NULL,12,   'prepaid',  ARRAY[3],   98),
    ('DEMO-07','residential','weekly',      2800, 1,   NULL, 'postpaid', ARRAY[0],   49),
    ('DEMO-08','residential','weekly',      3200, 1,   NULL, 'postpaid', ARRAY[2],   42),
    ('DEMO-09','residential','biweekly',    2600, 2,   NULL, 'postpaid', ARRAY[5],   77),
    ('DEMO-10','commercial', 'weekly',      6800, NULL,6,    'postpaid', ARRAY[0],   91)
  ) AS d(ext, acct, freq, price, dogs, units, cadence, offsets, age)
  JOIN public.clients c ON c.organization_id = _org_id AND c.import_external_id = d.ext
  JOIN public.properties p ON p.client_id = c.id;

  INSERT INTO public.addon_services(organization_id, code, name, description, kind,
        unit_price_cents, default_frequency, audience, active)
  VALUES
    (_org_id, 'DEMO_DEODORIZE', 'Yard deodorizer treatment',   'Freshens turf between visits — safe for pets and lawn.',      'recurring'::addon_kind, 3500, 'monthly'::addon_frequency, 'residential'::addon_audience, true),
    (_org_id, 'DEMO_TICK',      'Tick & flea perimeter spray', 'Seasonal perimeter spray focused on high-traffic dog areas.','one_time'::addon_kind,  5500, NULL,                       'residential'::addon_audience, true),
    (_org_id, 'DEMO_HAUL',      'Trash haul-away',             'We bag it out — for renters without curbside pickup.',        'recurring'::addon_kind,  800, 'weekly'::addon_frequency,  'residential'::addon_audience, true),
    (_org_id, 'DEMO_STN_REFILL','Station liner refill (bulk)', 'Restock all pet-waste dispensers with 200 liners each.',      'one_time'::addon_kind, 12500, NULL,                       'commercial'::addon_audience,  true),
    (_org_id, 'DEMO_COMMON',    'Extra common-area clean',     'Additional visit for high-traffic HOA and plaza commons.',    'recurring'::addon_kind,15000, 'monthly'::addon_frequency, 'commercial'::addon_audience,  true);

  -- ── PREPAID CREDIT, BEFORE ANY VISIT IS COMPLETED ───────────────────────
  -- finalize_visit_completion debits a prepaid client per visit. Topping up
  -- afterwards would leave the balance correct but the ledger nonsensical —
  -- weeks of service on an account that had no money in it.
  FOR crec IN
    SELECT s.client_id, s.price_cents, s.started_on
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.billing_cadence = 'prepaid'
  LOOP
    FOR m IN 0..3 LOOP
      inv := gen_random_uuid();
      INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
            subtotal_cents, total_cents, period_start, period_end,
            issued_at, paid_at, created_at)
      VALUES (inv, _org_id, crec.client_id, 'prepaid_topup'::invoice_kind, 'paid'::invoice_status,
              crec.price_cents * 5, crec.price_cents * 5,
              CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END,
              CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END,
              (CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval '9 hours',
              (CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval '9 hours',
              (CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval '9 hours');
      INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
      VALUES (inv, '5-visit prepaid top-up', crec.price_cents * 5);
      INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status,
            paid_at, created_at, collected_by_organization_id)
      VALUES (_org_id, inv, crec.price_cents * 5, 'succeeded'::payment_status,
              (CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval '9 hours',
              (CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval '9 hours',
              _org_id);
      PERFORM public.post_credit_entry(_org_id, crec.client_id, crec.price_cents * 5,
              'prepayment', inv, NULL, 'Prepaid top-up (5 visits)');
    END LOOP;
  END LOOP;

  -- ── VISITS, FROM THE PRODUCT'S OWN SCHEDULER ────────────────────────────
  -- generate_visits_core walks each subscription from started_on, so one call
  -- produces the history AND the next three weeks. Everything it writes is
  -- 'scheduled'; the tape is played below.
  PERFORM public.generate_visits_core(_org_id, today + 21, NULL);

  -- History. Roughly 91% completed, which is a believable operator — a demo
  -- reading 100% is as unconvincing as one reading 1%.
  --   rn % 40 = 7   → missed  (the visit that never happened)
  --   rn % 17 = 3   → skipped (with a reason, half of them billable)
  FOR vrec IN
    SELECT id, scheduled_on,
           row_number() OVER (ORDER BY scheduled_on, id) AS rn
      FROM public.visits
     WHERE organization_id = _org_id AND scheduled_on < today
  LOOP
    IF vrec.rn % 40 = 7 THEN
      UPDATE public.visits SET status = 'missed'::visit_status WHERE id = vrec.id;
    ELSIF vrec.rn % 17 = 3 THEN
      UPDATE public.visits
         SET status = 'skipped'::visit_status,
             skip_reason_code = CASE WHEN vrec.rn % 34 = 3 THEN 'weather'::skip_reason_code
                                     ELSE 'client_cancelled_late'::skip_reason_code END,
             skip_reason = CASE WHEN vrec.rn % 34 = 3 THEN 'Heavy rain — rescheduled to the next service day'
                                ELSE 'Client cancelled the morning of' END,
             skip_billable = (vrec.rn % 34 <> 3),
             skip_charge_cents = CASE WHEN vrec.rn % 34 = 3 THEN 0 ELSE 1000 END,
             weather_flagged = (vrec.rn % 34 = 3),
             weather_note = CASE WHEN vrec.rn % 34 = 3 THEN 'Rain over the service window' END
       WHERE id = vrec.id;
    ELSE
      UPDATE public.visits
         SET status = 'completed'::visit_status,
             started_at   = ((vrec.scheduled_on + time '08:00' + ((vrec.rn % 8) * interval '45 minutes')) AT TIME ZONE _tz),
             completed_at = ((vrec.scheduled_on + time '08:00' + ((vrec.rn % 8) * interval '45 minutes') + interval '26 minutes') AT TIME ZONE _tz),
             completion_source = 'tech_live'
       WHERE id = vrec.id;
      -- Posts the prepaid debit and the station service log. Skipping this is
      -- how seeded data ends up with a credit balance that does not match its
      -- own ledger.
      PERFORM public.finalize_visit_completion(vrec.id);
    END IF;
  END LOOP;

  -- Today. A route that is part done: the tech is mid-morning, four behind
  -- them, one in hand, the rest ahead.
  SELECT count(*) INTO today_total
    FROM public.visits WHERE organization_id = _org_id AND scheduled_on = today;
  n_completed_today := LEAST(4, GREATEST(today_total - 2, 0));

  idx := 0;
  FOR vrec IN
    SELECT id, scheduled_on, row_number() OVER (ORDER BY id) AS rn
      FROM public.visits
     WHERE organization_id = _org_id AND scheduled_on = today
     ORDER BY id
  LOOP
    UPDATE public.visits
       SET eta_start = ((today + time '07:30' + ((vrec.rn - 1) * interval '50 minutes')) AT TIME ZONE _tz),
           eta_end   = ((today + time '08:10' + ((vrec.rn - 1) * interval '50 minutes')) AT TIME ZONE _tz),
           sequence  = vrec.rn
     WHERE id = vrec.id;

    IF vrec.rn <= n_completed_today THEN
      UPDATE public.visits
         SET status = 'completed'::visit_status,
             started_at   = ((today + time '07:30' + ((vrec.rn - 1) * interval '50 minutes')) AT TIME ZONE _tz),
             completed_at = ((today + time '07:56' + ((vrec.rn - 1) * interval '50 minutes')) AT TIME ZONE _tz),
             completion_source = 'tech_live'
       WHERE id = vrec.id;
      PERFORM public.finalize_visit_completion(vrec.id);
    ELSIF vrec.rn = n_completed_today + 1 THEN
      UPDATE public.visits
         SET status = 'in_progress'::visit_status,
             started_at = now() - interval '18 minutes'
       WHERE id = vrec.id;
    END IF;
  END LOOP;

  -- Future visits get a window too, so the dispatch board is not a column of
  -- blanks past today.
  UPDATE public.visits vv
     SET eta_start = ((vv.scheduled_on + time '07:30' + (rk.n * interval '50 minutes')) AT TIME ZONE _tz),
         eta_end   = ((vv.scheduled_on + time '08:10' + (rk.n * interval '50 minutes')) AT TIME ZONE _tz),
         sequence  = rk.n + 1
    FROM (SELECT id, (row_number() OVER (PARTITION BY scheduled_on ORDER BY id) - 1) AS n
            FROM public.visits
           WHERE organization_id = _org_id AND scheduled_on > today) rk
   WHERE vv.id = rk.id;

  -- ── INVOICES, FROM THE PRODUCT'S OWN BILLER ─────────────────────────────
  -- One run per month boundary, so a postpaid client ends up with a run of
  -- monthly invoices rather than a single unreadable one covering ten weeks.
  FOR m IN REVERSE 3..0 LOOP
    month_end := (date_trunc('month', today) - (m || ' months')::interval + interval '1 month' - interval '1 day')::date;
    IF month_end > today THEN month_end := today; END IF;
    FOR crec IN
      SELECT DISTINCT s.client_id
        FROM public.subscriptions s
       WHERE s.organization_id = _org_id AND s.billing_cadence = 'postpaid'
    LOOP
      PERFORM public.admin_generate_invoice_for_client(crec.client_id, month_end);
    END LOOP;
  END LOOP;

  -- Everything the biller wrote is `open` and issued `now()`. Age it: an
  -- invoice for a period that closed before this month gets its real dates and
  -- is paid; the current period stays open, and two of the closed ones stay
  -- open so AR aging and the overdue count have something in them.
  UPDATE public.invoices
     SET issued_at  = (period_end + 1)::timestamptz + interval '9 hours',
         created_at = (period_end + 1)::timestamptz + interval '9 hours',
         due_on     = period_end + 15,
         sent_at    = (period_end + 1)::timestamptz + interval '9 hours',
         send_after = period_end + 1
   WHERE organization_id = _org_id AND kind = 'postpaid';

  WITH ranked AS (
    SELECT id, row_number() OVER (ORDER BY period_end, id) AS rn
      FROM public.invoices
     WHERE organization_id = _org_id AND kind = 'postpaid' AND period_end < som
  )
  UPDATE public.invoices i
     SET status  = 'paid'::invoice_status,
         paid_at = (i.period_end + 4)::timestamptz + interval '14 hours'
    FROM ranked r
   WHERE i.id = r.id AND r.rn % 7 <> 3;

  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status,
        paid_at, created_at, collected_by_organization_id)
  SELECT _org_id, i.id, i.total_cents - COALESCE(i.credit_applied_cents, 0),
         'succeeded'::payment_status, i.paid_at, i.paid_at, _org_id
    FROM public.invoices i
   WHERE i.organization_id = _org_id
     AND i.kind = 'postpaid'
     AND i.status = 'paid'
     AND i.total_cents - COALESCE(i.credit_applied_cents, 0) > 0;

  -- One postpaid invoice settles inside the current calendar month, so
  -- Collected MTD is never $0.00 — not even when a reseed runs on the 1st.
  UPDATE public.invoices
     SET status  = 'paid'::invoice_status,
         paid_at = mtd_day::timestamptz + interval '11 hours'
   WHERE id = (
     SELECT id FROM public.invoices
      WHERE organization_id = _org_id AND kind = 'postpaid' AND status = 'open'
        AND total_cents > 0
      ORDER BY period_end DESC, id LIMIT 1
   );

  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status,
        paid_at, created_at, collected_by_organization_id)
  SELECT _org_id, i.id, i.total_cents - COALESCE(i.credit_applied_cents, 0),
         'succeeded'::payment_status, i.paid_at, i.paid_at, _org_id
    FROM public.invoices i
   WHERE i.organization_id = _org_id
     AND i.kind = 'postpaid'
     AND i.status = 'paid'
     AND i.total_cents - COALESCE(i.credit_applied_cents, 0) > 0
     AND NOT EXISTS (SELECT 1 FROM public.payments p WHERE p.invoice_id = i.id);

  -- `post_credit_entry` and `apply_credit_to_invoice` stamp created_at with
  -- now(), which is right when the app calls them and wrong for ten weeks of
  -- backdated history: the client record would show every top-up and every
  -- visit debit landing in the same second this afternoon. Move each entry to
  -- the date of the thing it is about. The balance is untouched — it is
  -- maintained by a trigger that recounts delta_cents, and this changes none.
  UPDATE public.credit_ledger cl
     SET created_at = vv.completed_at
    FROM public.visits vv
   WHERE cl.organization_id = _org_id
     AND cl.visit_id = vv.id
     AND vv.completed_at IS NOT NULL;

  UPDATE public.credit_ledger cl
     SET created_at = COALESCE(ii.paid_at, ii.issued_at)
    FROM public.invoices ii
   WHERE cl.organization_id = _org_id
     AND cl.invoice_id = ii.id
     AND COALESCE(ii.paid_at, ii.issued_at) IS NOT NULL;

  -- ── STAFF ───────────────────────────────────────────────────────────────
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
   WHERE organization_id = _org_id AND active;

  -- History is assigned here; today and forward are left to
  -- assign_demo_visits_to_staff, which already owns that half and is what the
  -- app calls on its own. Per-tech figures on /reports read from completed
  -- visits, so unassigned history renders an empty table on a page whose whole
  -- point is the comparison.
  SELECT array_agg(id ORDER BY
           CASE role WHEN 'tech' THEN 1 WHEN 'dispatcher' THEN 2
                     WHEN 'office_manager' THEN 3 ELSE 4 END, display_name)
    INTO staff_ids
    FROM public.staff
   WHERE organization_id = _org_id AND active
     AND role IN ('tech','dispatcher','office_manager');

  IF staff_ids IS NOT NULL AND array_length(staff_ids, 1) > 0 THEN
    n_staff := array_length(staff_ids, 1);
    idx := 0;
    FOR vrec IN
      SELECT id FROM public.visits
       WHERE organization_id = _org_id AND scheduled_on < today
       ORDER BY scheduled_on, id
    LOOP
      UPDATE public.visits SET assigned_staff_id = staff_ids[(idx % n_staff) + 1] WHERE id = vrec.id;
      idx := idx + 1;
    END LOOP;
  END IF;

  PERFORM public.assign_demo_visits_to_staff(_org_id);

  -- That round-robins today and the future across tech, dispatcher and manager,
  -- which leaves /my-day showing two stops out of six. History keeps the
  -- round-robin — /reports compares techs and needs more than one to compare —
  -- but TODAY goes to the tech. A one-tech operator running today's route is
  -- both the realistic small-business case and the screen the field app is
  -- demonstrated on.
  UPDATE public.visits
     SET assigned_staff_id = (SELECT id FROM public.staff
                               WHERE organization_id = _org_id AND role = 'tech' AND active
                               ORDER BY created_at LIMIT 1)
   WHERE organization_id = _org_id
     AND scheduled_on = today
     AND EXISTS (SELECT 1 FROM public.staff
                  WHERE organization_id = _org_id AND role = 'tech' AND active);

  -- ── THE REST OF THE FURNITURE ───────────────────────────────────────────
  INSERT INTO public.promo_codes (organization_id, code, discount_type,
        discount_value_cents, discount_percent, description, active)
  VALUES
    (_org_id, 'DEMOWELCOME', 'fixed',   2000, NULL, '$20 off your first invoice', true),
    (_org_id, 'DEMOSPRING',  'percent', NULL, 15,   '15% off your next 3 visits', true);

  INSERT INTO public.gift_cards (organization_id, code, initial_balance_cents,
        remaining_balance_cents, purchaser_email, purchaser_name,
        recipient_email, recipient_name, message, status)
  VALUES (_org_id, 'DEMOGIFT100', 10000, 6000,
          'emily.j@example.com', 'Emily Johnson',
          'priya.p@example.com', 'Priya Patel',
          'Welcome to the neighborhood!', 'active')
  RETURNING id INTO gc;

  INSERT INTO public.gift_card_redemptions (organization_id, gift_card_id, client_id, amount_cents)
  SELECT _org_id, gc, c.id, 4000
    FROM public.clients c
   WHERE c.organization_id = _org_id AND c.import_external_id = 'DEMO-04';

  INSERT INTO public.leads (organization_id, name, email, phone, dog_count, frequency,
        location, source, status, message)
  VALUES
    (_org_id, 'Renee Alvarez', 'renee.a@example.com',  '+15552220001', 2, 'weekly',   '10024', 'website', 'new',       'Two goldens — moving in next month'),
    (_org_id, 'Theo Bright',   'theo.b@example.com',   '+15552220002', 1, 'biweekly', '10003', 'referral','contacted', 'Referred by Emily'),
    (_org_id, 'Lauren Woods',  'lauren.w@example.com', NULL,           3, 'weekly',   '10001', 'website', 'new',       'Big backyard, three dogs');

  INSERT INTO public.qc_tickets (organization_id, client_id, visit_id, category, message,
        status, resolution_note, resolved_at)
  SELECT _org_id, c.id, v2.id, 'missed_spot',
         'Corner near the shed still had a couple of piles', 'resolved',
         'Tech went back the same day and cleared it. Sorry we missed it.',
         now() - interval '10 days'
    FROM public.clients c
    JOIN LATERAL (
      SELECT id FROM public.visits
       WHERE client_id = c.id AND status = 'completed'
       ORDER BY scheduled_on DESC LIMIT 1
    ) v2 ON true
   WHERE c.organization_id = _org_id AND c.import_external_id = 'DEMO-01';

  INSERT INTO public.qc_tickets (organization_id, client_id, category, message, status)
  SELECT _org_id, c.id, 'gate_left_open',
         'Please double-check the gate — Rex is an escape risk', 'open'
    FROM public.clients c
   WHERE c.organization_id = _org_id AND c.import_external_id = 'DEMO-03';

  INSERT INTO public.qc_tickets (organization_id, client_id, category, message, status, resolution_note)
  SELECT _org_id, c.id, 'other',
         'Station D by the playground was overflowing on Monday', 'acknowledged',
         'Assigning a mid-week extra pickup. Will confirm within 24h.'
    FROM public.clients c
   WHERE c.organization_id = _org_id AND c.import_external_id = 'DEMO-05';

  RETURN jsonb_build_object(
    'ok', true,
    'clients',          (SELECT count(*) FROM public.clients   WHERE organization_id = _org_id),
    'visits_created',   (SELECT count(*) FROM public.visits    WHERE organization_id = _org_id),
    'visits_today',     (SELECT count(*) FROM public.visits    WHERE organization_id = _org_id AND scheduled_on = today),
    'invoices_created', (SELECT count(*) FROM public.invoices  WHERE organization_id = _org_id),
    'payments_created', (SELECT count(*) FROM public.payments  WHERE organization_id = _org_id),
    'collected_mtd_cents', (SELECT COALESCE(sum(amount_cents),0) FROM public.payments
                             WHERE organization_id = _org_id AND status = 'succeeded'
                               AND paid_at >= som::timestamptz),
    'stations_created', (SELECT count(*) FROM public.waste_stations WHERE organization_id = _org_id),
    'addons_created',   (SELECT count(*) FROM public.addon_services WHERE organization_id = _org_id)
  );
END;
$fn$;

-- Redefining a function after the 2026-08-09 lockdown means restating who may
-- call it -- CREATE OR REPLACE keeps existing grants, but the sweep's rule
-- (tests/the-lockdown-that-only-held-for-the-functions-that-existed-that-day)
-- is that the file that creates a function says so itself, because grants that
-- exist only by inheritance are grants nobody can audit from the repo.
-- Authenticated keeps EXECUTE: the function's own first act is the role check
-- 20260809180000 already asserts against this exact signature.
REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated;
