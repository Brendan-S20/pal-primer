
CREATE OR REPLACE FUNCTION public.seed_demo_org(_org_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  is_authorized boolean;
  z_urban uuid; z_suburb uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid;
  p1 uuid; p2 uuid; p3 uuid; p4 uuid; p5 uuid; p6 uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid;
  v uuid;
  inv uuid;
  d date;
  wk int;
BEGIN
  SELECT
    public.is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid()
        AND organization_id = _org_id
        AND role IN ('owner','office_manager')
    )
  INTO is_authorized;
  IF NOT is_authorized THEN
    RAISE EXCEPTION 'Not authorized to reseed this organization';
  END IF;

  -- Wipe prior demo rows (tagged by import_external_id LIKE 'DEMO-%')
  DELETE FROM public.visit_photos
    WHERE organization_id = _org_id
      AND visit_id IN (
        SELECT id FROM public.visits WHERE organization_id = _org_id
      );
  DELETE FROM public.qc_tickets    WHERE organization_id = _org_id;
  DELETE FROM public.invoice_line_items
    WHERE invoice_id IN (SELECT id FROM public.invoices WHERE organization_id = _org_id);
  DELETE FROM public.credit_ledger WHERE organization_id = _org_id;
  DELETE FROM public.payments      WHERE organization_id = _org_id;
  DELETE FROM public.invoices      WHERE organization_id = _org_id;
  DELETE FROM public.visits        WHERE organization_id = _org_id;
  DELETE FROM public.subscriptions WHERE organization_id = _org_id;
  DELETE FROM public.dogs          WHERE organization_id = _org_id;
  DELETE FROM public.properties    WHERE organization_id = _org_id;
  DELETE FROM public.clients
    WHERE organization_id = _org_id
      AND import_external_id LIKE 'DEMO-%';
  DELETE FROM public.gift_card_redemptions
    WHERE gift_card_id IN (SELECT id FROM public.gift_cards WHERE organization_id = _org_id);
  DELETE FROM public.gift_cards    WHERE organization_id = _org_id AND code LIKE 'DEMO%';
  DELETE FROM public.promo_codes   WHERE organization_id = _org_id AND code LIKE 'DEMO%';
  DELETE FROM public.leads;  -- leads are global; safe to clear demo ones by email
  DELETE FROM public.zones
    WHERE organization_id = _org_id
      AND name IN ('Downtown Core','Westside Suburb');

  -- Zones
  INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode)
  VALUES (gen_random_uuid(), _org_id, 'Downtown Core',
          ARRAY['10001','10002','10003'], 2500, 500, 4500, 'zip', 'flat')
  RETURNING id INTO z_urban;

  INSERT INTO public.zones (id, organization_id, name, zip_codes, base_price_cents,
                            per_dog_addl_cents, initial_cleanup_cents,
                            geo_match_mode, pricing_mode, price_per_sqft_cents,
                            area_min_charge_cents, boundary,
                            center_latitude, center_longitude, radius_meters)
  VALUES (gen_random_uuid(), _org_id, 'Westside Suburb',
          ARRAY['10023','10024'], 2000, 400, 4000, 'polygon', 'per_sqft', 0.75, 2500,
          '{"type":"Polygon","coordinates":[[[-73.99,40.77],[-73.97,40.77],[-73.97,40.79],[-73.99,40.79],[-73.99,40.77]]]}'::jsonb,
          40.78, -73.98, 3000)
  RETURNING id INTO z_suburb;

  -- Clients (with referral pair)
  c1 := gen_random_uuid(); c2 := gen_random_uuid(); c3 := gen_random_uuid();
  c4 := gen_random_uuid(); c5 := gen_random_uuid(); c6 := gen_random_uuid();

  INSERT INTO public.clients (id, organization_id, display_name, account_type,
        primary_email, primary_phone, credit_balance_cents, referral_code,
        import_source, import_external_id, autopay_enabled, default_card_brand, default_card_last4)
  VALUES
    (c1, _org_id, 'Emily & Marc Johnson',       'residential', 'emily.j@example.com', '+15551110001', 0,     'EMILY10',  'generic_csv', 'DEMO-1', true,  'visa', '4242'),
    (c2, _org_id, 'Sophia Ramirez',              'residential', 'sophia.r@example.com','+15551110002', 4500,  'SOPH10',   'generic_csv', 'DEMO-2', false, null,   null),
    (c3, _org_id, 'David Chen',                  'residential', 'david.c@example.com', '+15551110003',-3500, 'DAVE10',   'generic_csv', 'DEMO-3', true,  'mastercard','5555'),
    (c4, _org_id, 'Priya Patel',                 'residential', 'priya.p@example.com', '+15551110004', 0,     'PRIYA10',  'generic_csv', 'DEMO-4', false, null,   null),
    (c5, _org_id, 'Riverside HOA',               'commercial',  'ops@riverside-hoa.org','+15551110005',12000,'RIVER10',  'generic_csv', 'DEMO-5', true,  'amex', '0005'),
    (c6, _org_id, 'Brookline Commercial Plaza',  'commercial',  'mgmt@brookline.example','+15551110006',0,   'BROOK10',  'generic_csv', 'DEMO-6', false, null,   null);

  -- Sophia referred by Emily
  UPDATE public.clients SET referred_by_client_id = c1, referral_applied_at = now() - interval '20 days'
    WHERE id = c2;

  -- Properties (with yard boundary polygons + area)
  p1 := gen_random_uuid(); p2 := gen_random_uuid(); p3 := gen_random_uuid();
  p4 := gen_random_uuid(); p5 := gen_random_uuid(); p6 := gen_random_uuid();

  INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code,
        yard_size, boundary, boundary_area_sqm, latitude, longitude,
        aggressive_dog, invisible_fence)
  VALUES
    (p1, _org_id, c1, '142 W 74th St',        'New York', '10023', 'medium',
      '{"type":"Polygon","coordinates":[[[-73.978,40.777],[-73.9775,40.777],[-73.9775,40.7775],[-73.978,40.7775],[-73.978,40.777]]]}'::jsonb,
      280, 40.7773, -73.9778, false, true),
    (p2, _org_id, c2, '86 Bedford Ave',       'New York', '10024', 'large',
      '{"type":"Polygon","coordinates":[[[-73.984,40.786],[-73.9832,40.786],[-73.9832,40.7867],[-73.984,40.7867],[-73.984,40.786]]]}'::jsonb,
      540, 40.7863, -73.9836, false, false),
    (p3, _org_id, c3, '2005 Broadway',        'New York', '10023', 'small',
      '{"type":"Polygon","coordinates":[[[-73.98,40.775],[-73.9797,40.775],[-73.9797,40.7754],[-73.98,40.7754],[-73.98,40.775]]]}'::jsonb,
      120, 40.7752, -73.9799, true,  false),
    (p4, _org_id, c4, '311 E 12th St',        'New York', '10003', 'medium',
      '{"type":"Polygon","coordinates":[[[-73.984,40.732],[-73.9835,40.732],[-73.9835,40.7325],[-73.984,40.7325],[-73.984,40.732]]]}'::jsonb,
      260, 40.7322, -73.9837, false, false),
    (p5, _org_id, c5, '77 Riverside Dr',      'New York', '10024', 'xlarge',
      '{"type":"Polygon","coordinates":[[[-73.986,40.789],[-73.982,40.789],[-73.982,40.792],[-73.986,40.792],[-73.986,40.789]]]}'::jsonb,
      12000, 40.7905, -73.984, false, false),
    (p6, _org_id, c6, '450 Brookline Pl',     'New York', '10001', 'xlarge',
      '{"type":"Polygon","coordinates":[[[-73.995,40.748],[-73.992,40.748],[-73.992,40.751],[-73.995,40.751],[-73.995,40.748]]]}'::jsonb,
      9000, 40.7495, -73.9935, false, false);

  -- Dogs
  INSERT INTO public.dogs (organization_id, property_id, name, breed, temperament, weight_class) VALUES
    (_org_id, p1, 'Cooper',    'Golden Retriever',   'friendly',  'large'),
    (_org_id, p1, 'Bella',     'Beagle',             'friendly',  'medium'),
    (_org_id, p2, 'Luna',      'Poodle Mix',         'friendly',  'medium'),
    (_org_id, p2, 'Max',       'Labrador',           'friendly',  'large'),
    (_org_id, p2, 'Charlie',   'French Bulldog',     'nervous',   'small'),
    (_org_id, p3, 'Rex',       'German Shepherd',    'aggressive','large'),
    (_org_id, p4, 'Daisy',     'Cavalier',           'friendly',  'small'),
    (_org_id, p5, 'Community pack (approx 25)', NULL, 'unknown', NULL),
    (_org_id, p6, 'Building pack (approx 40)',  NULL, 'unknown', NULL);

  -- Subscriptions
  s1 := gen_random_uuid(); s2 := gen_random_uuid(); s3 := gen_random_uuid();
  s4 := gen_random_uuid(); s5 := gen_random_uuid(); s6 := gen_random_uuid();

  INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, zone_id,
        account_type, frequency, price_cents, dog_count, unit_count, billing_cadence,
        preferred_weekdays, status, started_on) VALUES
    (s1, _org_id, c1, p1, z_suburb, 'residential', 'weekly',       3000, 2, NULL, 'postpaid', ARRAY[2], 'active', current_date - 60),
    (s2, _org_id, c2, p2, z_suburb, 'residential', 'weekly',       3500, 3, NULL, 'prepaid',  ARRAY[3], 'active', current_date - 45),
    (s3, _org_id, c3, p3, z_urban,  'residential', 'biweekly',     2500, 1, NULL, 'postpaid', ARRAY[4], 'active', current_date - 90),
    (s4, _org_id, c4, p4, z_urban,  'residential', 'weekly',       2500, 1, NULL, 'postpaid', ARRAY[1], 'active', current_date - 30),
    (s5, _org_id, c5, p5, z_suburb, 'commercial',  'twice_weekly', 9500, NULL, 8, 'postpaid', ARRAY[1,4], 'active', current_date - 120),
    (s6, _org_id, c6, p6, z_urban,  'commercial',  'weekly',       7500, NULL, 12,'prepaid',  ARRAY[3], 'active', current_date - 100);

  -- Past 8 weeks of visits, mixing statuses. Insert deterministically.
  FOR wk IN 1..8 LOOP
    d := current_date - (wk * 7);

    -- Emily/Cooper — weekly, mostly completed. Week 3 weather-rescheduled.
    INSERT INTO public.visits (id, organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, weather_flagged, weather_note, rescheduled_from)
    VALUES (gen_random_uuid(), _org_id, c1, p1, s1, z_suburb,
            d, CASE WHEN wk = 3 THEN 'skipped'::visit_status ELSE 'completed'::visit_status END,
            CASE WHEN wk = 3 THEN NULL ELSE (d + time '10:30')::timestamptz END,
            wk = 3, CASE WHEN wk = 3 THEN 'Heavy rain — rescheduled +1 day' END,
            NULL) RETURNING id INTO v;
    IF wk IN (1,2,4) THEN
      INSERT INTO public.visit_photos (organization_id, visit_id, storage_path, kind, uploaded_by)
      VALUES (_org_id, v, 'demo/visits/' || v::text || '/before.jpg', 'before', c1),
             (_org_id, v, 'demo/visits/' || v::text || '/after.jpg',  'after',  c1);
    END IF;

    -- Sophia — weekly, all completed
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at)
    VALUES (_org_id, c2, p2, s2, z_suburb, d, 'completed', (d + time '11:00')::timestamptz);

    -- David — biweekly (every other week)
    IF wk % 2 = 0 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
            scheduled_on, status, completed_at, skip_reason_code, skip_reason)
      VALUES (_org_id, c3, p3, s3, z_urban, d,
              CASE WHEN wk = 4 THEN 'skipped'::visit_status ELSE 'completed'::visit_status END,
              CASE WHEN wk = 4 THEN NULL ELSE (d + time '13:00')::timestamptz END,
              CASE WHEN wk = 4 THEN 'gate_locked'::skip_reason_code ELSE NULL END,
              CASE WHEN wk = 4 THEN 'Gate locked — could not access yard' END);
    END IF;

    -- Priya — weekly (started 4 weeks ago)
    IF wk <= 4 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
            scheduled_on, status, completed_at)
      VALUES (_org_id, c4, p4, s4, z_urban, d, 'completed', (d + time '14:15')::timestamptz);
    END IF;

    -- Riverside HOA — twice weekly (Mon+Thu)
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (_org_id, c5, p5, s5, z_suburb, d, 'completed', (d + time '08:00')::timestamptz, 8);
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (_org_id, c5, p5, s5, z_suburb, d + 3, 'completed', (d + 3 + time '08:00')::timestamptz, 8);

    -- Brookline Plaza — weekly
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (_org_id, c6, p6, s6, z_urban, d, 'completed', (d + time '07:30')::timestamptz, 12);
  END LOOP;

  -- Upcoming visits (next 2 weeks) for all subs
  FOR wk IN 1..2 LOOP
    d := current_date + (wk * 7);
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id, scheduled_on, status)
    VALUES
      (_org_id, c1, p1, s1, z_suburb, d,     'scheduled'),
      (_org_id, c2, p2, s2, z_suburb, d,     'scheduled'),
      (_org_id, c4, p4, s4, z_urban,  d,     'scheduled'),
      (_org_id, c5, p5, s5, z_suburb, d,     'scheduled'),
      (_org_id, c5, p5, s5, z_suburb, d + 3, 'scheduled'),
      (_org_id, c6, p6, s6, z_urban,  d,     'scheduled');
    IF wk = 2 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id, scheduled_on, status)
      VALUES (_org_id, c3, p3, s3, z_urban, d, 'scheduled');
    END IF;
  END LOOP;

  -- Invoices
  -- 1) Emily: paid invoice (postpaid, last period)
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at, paid_at)
  VALUES (inv, _org_id, c1, 'postpaid', 'paid',
          12000, 12000, current_date - 35, current_date - 5, now() - interval '4 days', now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4 weekly visits (Cooper + Bella)', 12000);
  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at)
  VALUES (_org_id, inv, 12000, 'succeeded', now() - interval '2 days');

  -- 2) David: OPEN + overdue (dunning)
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at, last_reminder_at)
  VALUES (inv, _org_id, c3, 'postpaid', 'open',
          5000, 5000, current_date - 55, current_date - 25, now() - interval '24 days', now() - interval '3 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '2 biweekly visits — Rex', 5000);

  -- 3) Sophia: prepaid_topup, paid — credited balance
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at, paid_at)
  VALUES (inv, _org_id, c2, 'prepaid_topup', 'paid',
          14000, 14000, current_date - 20, current_date - 20, now() - interval '20 days', now() - interval '20 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4-visit prepaid top-up', 14000);
  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at)
  VALUES (_org_id, inv, 14000, 'succeeded', now() - interval '20 days');
  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, note, invoice_id)
  VALUES (_org_id, c2, 14000, 'topup', 'Prepaid top-up (4 visits)', inv);

  -- 4) Priya: draft quote
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end)
  VALUES (inv, _org_id, c4, 'postpaid', 'draft', 10000, 10000, current_date - 28, current_date);
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4 weekly visits — Daisy', 10000);

  -- 5) Riverside HOA — open invoice
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at)
  VALUES (inv, _org_id, c5, 'postpaid', 'open', 76000, 76000,
          current_date - 30, current_date, now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '8 twice-weekly visits (Riverside)', 76000);

  -- 6) Brookline — prepaid top-up outstanding
  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at)
  VALUES (inv, _org_id, c6, 'prepaid_topup', 'open', 30000, 30000,
          current_date - 2, current_date - 2, now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4-visit prepaid top-up', 30000);

  -- Credit ledger for David negative balance (retainer used)
  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, note)
  VALUES (_org_id, c3, -3500, 'debit', 'Deep-clean applied against future invoice');

  -- Promo codes
  INSERT INTO public.promo_codes (organization_id, code, discount_type, discount_value_cents, description, active)
  VALUES
    (_org_id, 'DEMOWELCOME', 'amount',  2000, '$20 off first invoice', true),
    (_org_id, 'DEMOSPRING',  'percent', NULL, '15% off next 3 visits', true);
  UPDATE public.promo_codes SET discount_percent = 15 WHERE organization_id = _org_id AND code = 'DEMOSPRING';

  -- Gift card
  DECLARE gc uuid;
  BEGIN
    INSERT INTO public.gift_cards (organization_id, code, initial_balance_cents, remaining_balance_cents,
          purchaser_email, purchaser_name, recipient_email, recipient_name, message, status)
    VALUES (_org_id, 'DEMOGIFT100', 10000, 6000,
            'emily.j@example.com', 'Emily Johnson',
            'priya.p@example.com', 'Priya Patel',
            'Welcome to the neighborhood!', 'active')
    RETURNING id INTO gc;
    INSERT INTO public.gift_card_redemptions (gift_card_id, client_id, amount_cents)
    VALUES (gc, c4, 4000);
  END;

  -- Leads
  INSERT INTO public.leads (name, email, phone, dog_count, frequency, location, source, status, message) VALUES
    ('Alexandra Kim', 'alex.k@example.com',   '+15552220001', 2, 'weekly',   '10024', 'website', 'new',       'Two goldens — moving in next month'),
    ('Marcus Bell',   'marcus.b@example.com', '+15552220002', 1, 'biweekly', '10003', 'referral','contacted', 'Referred by Emily'),
    ('Lauren Woods',  'lauren.w@example.com', NULL,           3, 'weekly',   '10001', 'website', 'new',       'Big backyard, three dogs');

  -- QC tickets
  INSERT INTO public.qc_tickets (organization_id, client_id, visit_id, category, message, status, resolution_note, resolved_at)
  SELECT _org_id, c1, v.id, 'missed_spot', 'Corner near the shed still had a couple of piles', 'resolved',
         'Returned same day and cleaned', now() - interval '10 days'
  FROM public.visits v WHERE v.client_id = c1 ORDER BY v.scheduled_on DESC LIMIT 1;

  INSERT INTO public.qc_tickets (organization_id, client_id, category, message, status)
  VALUES (_org_id, c3, 'gate_left_open', 'Please double check gate — Rex is an escape risk', 'open');

  RETURN jsonb_build_object(
    'ok', true,
    'clients', 6,
    'visits_created', (SELECT count(*) FROM public.visits WHERE organization_id = _org_id),
    'invoices_created', (SELECT count(*) FROM public.invoices WHERE organization_id = _org_id)
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated;
