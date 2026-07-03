
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS brand_color TEXT,
  ADD COLUMN IF NOT EXISTS logo_url TEXT,
  ADD COLUMN IF NOT EXISTS contact_phone TEXT,
  ADD COLUMN IF NOT EXISTS contact_email TEXT,
  ADD COLUMN IF NOT EXISTS portal_reschedule_cutoff_hours INTEGER NOT NULL DEFAULT 18,
  ADD COLUMN IF NOT EXISTS portal_allow_self_reschedule BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portal_allow_vacation_hold BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portal_allow_frequency_change BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS portal_auto_apply_changes BOOLEAN NOT NULL DEFAULT false;

DO $$ BEGIN
  CREATE TYPE public.addon_audience AS ENUM ('any','residential','commercial');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.addon_services
  ADD COLUMN IF NOT EXISTS audience public.addon_audience NOT NULL DEFAULT 'any';

DROP FUNCTION IF EXISTS public.portal_get_client(uuid);
CREATE FUNCTION public.portal_get_client(_token uuid)
RETURNS TABLE(
  client_id uuid, organization_id uuid, display_name text, account_type text,
  credit_balance_cents integer, org_name text,
  brand_color text, logo_url text, contact_phone text, contact_email text,
  autopay_enabled boolean, has_saved_card boolean, card_brand text, card_last4 text,
  reschedule_cutoff_hours integer, allow_self_reschedule boolean,
  allow_vacation_hold boolean, allow_frequency_change boolean, auto_apply_changes boolean,
  primary_frequency text, primary_price_cents integer, primary_dog_count integer,
  primary_unit_count integer, primary_billing_cadence text, station_count integer,
  next_visit_id uuid, next_visit_on date, next_visit_eta_start timestamptz,
  next_visit_eta_end timestamptz, next_visit_tech_name text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH client_row AS (
    SELECT c.*, o.name AS o_name, o.brand_color AS o_brand, o.logo_url AS o_logo,
           o.contact_phone AS o_phone, o.contact_email AS o_email,
           o.portal_reschedule_cutoff_hours AS o_cutoff,
           o.portal_allow_self_reschedule AS o_reschedule,
           o.portal_allow_vacation_hold   AS o_hold,
           o.portal_allow_frequency_change AS o_freq_change,
           o.portal_auto_apply_changes    AS o_auto
      FROM public.clients c
      JOIN public.organizations o ON o.id = c.organization_id
     WHERE c.portal_token = _token AND c.active = true
     LIMIT 1
  ),
  primary_sub AS (
    SELECT s.* FROM public.subscriptions s JOIN client_row cr ON cr.id = s.client_id
     WHERE s.status = 'active' ORDER BY s.started_on DESC LIMIT 1
  ),
  stations AS (
    SELECT COUNT(*)::int AS n FROM public.waste_stations ws
      JOIN client_row cr ON cr.id = ws.client_id WHERE ws.active = true
  ),
  next_v AS (
    SELECT v.id, v.scheduled_on, v.eta_start, v.eta_end, v.assigned_staff_id
      FROM public.visits v JOIN client_row cr ON cr.id = v.client_id
     WHERE v.scheduled_on >= CURRENT_DATE AND v.status IN ('scheduled','in_progress')
     ORDER BY v.scheduled_on, v.sequence NULLS LAST LIMIT 1
  )
  SELECT cr.id, cr.organization_id, cr.display_name, cr.account_type::text,
    cr.credit_balance_cents, cr.o_name, cr.o_brand, cr.o_logo, cr.o_phone, cr.o_email,
    cr.autopay_enabled, (cr.default_payment_method_id IS NOT NULL) AS has_saved_card,
    cr.default_card_brand, cr.default_card_last4,
    cr.o_cutoff, cr.o_reschedule, cr.o_hold, cr.o_freq_change, cr.o_auto,
    ps.frequency::text, ps.price_cents, ps.dog_count, ps.unit_count, ps.billing_cadence::text,
    st.n, nv.id, nv.scheduled_on, nv.eta_start, nv.eta_end,
    (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = nv.assigned_staff_id)
  FROM client_row cr
  LEFT JOIN primary_sub ps ON true
  LEFT JOIN stations st ON true
  LEFT JOIN next_v nv ON true
$$;
GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.portal_list_upcoming_visits(uuid);
CREATE FUNCTION public.portal_list_upcoming_visits(_token uuid)
RETURNS TABLE(
  visit_id uuid, scheduled_on date, status public.visit_status,
  street text, city text, postal_code text,
  eta_start timestamptz, eta_end timestamptz,
  tech_name text, weather_flagged boolean, weather_note text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.scheduled_on, v.status, p.street, p.city, p.postal_code,
         v.eta_start, v.eta_end,
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         COALESCE(v.weather_flagged, false), v.weather_note
    FROM public.clients c
    JOIN public.visits v ON v.client_id = c.id
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE c.portal_token = _token
     AND v.scheduled_on >= CURRENT_DATE
     AND v.status IN ('scheduled','in_progress')
   ORDER BY v.scheduled_on, v.sequence NULLS LAST
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_upcoming_visits(uuid) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.portal_list_recent_visits(uuid);
CREATE FUNCTION public.portal_list_recent_visits(_token uuid)
RETURNS TABLE(
  visit_id uuid, scheduled_on date, status public.visit_status,
  photo_paths text[], tech_name text, completed_at timestamptz, skip_reason text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT v.id, v.scheduled_on, v.status,
         COALESCE(ARRAY(
           SELECT vp.storage_path FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at
         ), ARRAY[]::text[]),
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         v.completed_at, v.skip_reason
    FROM public.visits v
    JOIN public.clients c ON c.id = v.client_id
   WHERE c.portal_token = _token AND c.active = true
     AND v.status IN ('completed','skipped')
   ORDER BY v.scheduled_on DESC
   LIMIT 30
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_recent_visits(uuid) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.portal_list_addon_catalog(uuid);
CREATE FUNCTION public.portal_list_addon_catalog(_token uuid)
RETURNS TABLE(
  addon_service_id uuid, code text, name text, description text,
  kind public.addon_kind, unit_price_cents integer,
  default_frequency public.addon_frequency
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.code, a.name, a.description, a.kind, a.unit_price_cents, a.default_frequency
    FROM public.clients c
    JOIN public.addon_services a ON a.organization_id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true AND a.active = true
     AND (a.audience = 'any' OR a.audience::text = c.account_type::text)
   ORDER BY a.name
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_addon_catalog(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_list_stations(_token uuid)
RETURNS TABLE(
  station_id uuid, label text, location_description text,
  liner_size text, capacity_liners integer, last_serviced_on date
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ws.id, ws.label, ws.location_description, ws.liner_size, ws.capacity_liners,
         (SELECT MAX(v.scheduled_on) FROM public.station_service_logs sl
           JOIN public.visits v ON v.id = sl.visit_id
           WHERE sl.waste_station_id = ws.id)
    FROM public.clients c
    JOIN public.waste_stations ws ON ws.client_id = c.id
   WHERE c.portal_token = _token AND c.active = true AND ws.active = true
   ORDER BY ws.sort_order, ws.label
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_stations(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_list_my_requests(_token uuid)
RETURNS TABLE(
  ticket_id uuid, visit_id uuid, visit_date date, category text, message text,
  status text, resolution_note text, resolved_at timestamptz, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id, t.visit_id, v.scheduled_on, t.category, t.message,
         t.status, t.resolution_note, t.resolved_at, t.created_at
    FROM public.clients c
    JOIN public.qc_tickets t ON t.client_id = c.id
    LEFT JOIN public.visits v ON v.id = t.visit_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY t.created_at DESC
   LIMIT 40
$$;
GRANT EXECUTE ON FUNCTION public.portal_list_my_requests(uuid) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_request_vacation_hold(
  _token uuid, _start date, _end date, _reason text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _n integer := 0; _auto boolean; _allow boolean;
BEGIN
  SELECT c.id, c.organization_id, o.portal_auto_apply_changes, o.portal_allow_vacation_hold
    INTO _cid, _org, _auto, _allow
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  IF NOT _allow THEN RAISE EXCEPTION 'Vacation holds are not enabled for this account'; END IF;
  IF _start IS NULL OR _end IS NULL OR _end < _start THEN
    RAISE EXCEPTION 'Invalid date range';
  END IF;
  IF _auto THEN
    UPDATE public.visits SET
      status='skipped',
      skip_reason = COALESCE(NULLIF(trim(_reason),''), 'Vacation hold'),
      skip_reason_code='customer_requested',
      skip_billable = false, skip_charge_cents = 0,
      updated_at = now()
     WHERE client_id = _cid
       AND scheduled_on BETWEEN _start AND _end
       AND status IN ('scheduled','in_progress');
    GET DIAGNOSTICS _n = ROW_COUNT;
  ELSE
    INSERT INTO public.qc_tickets(organization_id, client_id, category, message, status)
    VALUES (_org, _cid, 'other',
      format('Vacation hold requested %s → %s. %s', _start, _end, COALESCE(_reason,'')),
      'open');
    _n := 0;
  END IF;
  RETURN _n;
END $$;
GRANT EXECUTE ON FUNCTION public.portal_request_vacation_hold(uuid, date, date, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.portal_redeem_promo(_token uuid, _code text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _cid uuid; _org uuid; _p record; _amount integer;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  SELECT * INTO _p FROM public.promo_codes
   WHERE organization_id = _org AND upper(code) = upper(trim(_code)) AND active = true;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Code not found or inactive'; END IF;
  IF _p.expires_at IS NOT NULL AND _p.expires_at < now() THEN
    RAISE EXCEPTION 'Code has expired'; END IF;
  IF _p.max_redemptions IS NOT NULL AND _p.redemption_count >= _p.max_redemptions THEN
    RAISE EXCEPTION 'Code has reached its redemption limit'; END IF;
  IF EXISTS (SELECT 1 FROM public.credit_ledger
     WHERE client_id = _cid AND kind = 'promo' AND note = 'Promo: '||upper(_p.code)) THEN
    RAISE EXCEPTION 'You have already used this code'; END IF;
  IF _p.discount_type = 'amount' THEN
    _amount := COALESCE(_p.discount_value_cents, 0);
  ELSE
    RAISE EXCEPTION 'Percent codes are applied automatically to your next invoice';
  END IF;
  IF _amount <= 0 THEN RAISE EXCEPTION 'Code has no value'; END IF;
  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
  VALUES (_org, _cid, _amount, 'promo', 'Promo: '||upper(_p.code));
  UPDATE public.clients SET credit_balance_cents = credit_balance_cents + _amount WHERE id = _cid;
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = _p.id;
  RETURN _amount;
END $$;
GRANT EXECUTE ON FUNCTION public.portal_redeem_promo(uuid, text) TO anon, authenticated;

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
  v uuid; inv uuid; d date; wk int; ph_idx int;
BEGIN
  SELECT public.is_platform_admin(auth.uid())
    OR EXISTS (SELECT 1 FROM public.user_roles
      WHERE user_id = auth.uid() AND organization_id = _org_id
        AND role IN ('owner','office_manager'))
  INTO is_authorized;
  IF NOT is_authorized THEN
    RAISE EXCEPTION 'Not authorized to reseed this organization';
  END IF;

  UPDATE public.organizations SET
    brand_color   = COALESCE(brand_color,   '#16a34a'),
    contact_phone = COALESCE(contact_phone, '+15551234567'),
    contact_email = COALESCE(contact_email, 'hello@' || COALESCE(slug,'demo') || '.example')
   WHERE id = _org_id;

  DELETE FROM public.visit_photos
    WHERE organization_id = _org_id
      AND visit_id IN (SELECT id FROM public.visits WHERE organization_id = _org_id);
  DELETE FROM public.qc_tickets    WHERE organization_id = _org_id;
  DELETE FROM public.invoice_line_items
    WHERE invoice_id IN (SELECT id FROM public.invoices WHERE organization_id = _org_id);
  DELETE FROM public.credit_ledger WHERE organization_id = _org_id;
  DELETE FROM public.payments      WHERE organization_id = _org_id;
  DELETE FROM public.invoices      WHERE organization_id = _org_id;
  DELETE FROM public.station_service_logs WHERE organization_id = _org_id;
  DELETE FROM public.waste_stations WHERE organization_id = _org_id;
  DELETE FROM public.visits        WHERE organization_id = _org_id;
  DELETE FROM public.subscriptions WHERE organization_id = _org_id;
  DELETE FROM public.dogs          WHERE organization_id = _org_id;
  DELETE FROM public.properties    WHERE organization_id = _org_id;
  DELETE FROM public.addon_services WHERE organization_id = _org_id AND code LIKE 'DEMO_%';
  DELETE FROM public.clients
    WHERE organization_id = _org_id AND import_external_id LIKE 'DEMO-%';
  DELETE FROM public.gift_card_redemptions
    WHERE gift_card_id IN (SELECT id FROM public.gift_cards WHERE organization_id = _org_id);
  DELETE FROM public.gift_cards    WHERE organization_id = _org_id AND code LIKE 'DEMO%';
  DELETE FROM public.promo_codes   WHERE organization_id = _org_id AND code LIKE 'DEMO%';
  DELETE FROM public.leads;
  DELETE FROM public.zones
    WHERE organization_id = _org_id AND name IN ('Downtown Core','Westside Suburb');

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

  UPDATE public.clients SET referred_by_client_id = c1, referral_applied_at = now() - interval '20 days'
    WHERE id = c2;

  p1 := gen_random_uuid(); p2 := gen_random_uuid(); p3 := gen_random_uuid();
  p4 := gen_random_uuid(); p5 := gen_random_uuid(); p6 := gen_random_uuid();

  INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code,
        yard_size, boundary, boundary_area_sqm, latitude, longitude,
        aggressive_dog, invisible_fence, gate_code, access_notes)
  VALUES
    (p1, _org_id, c1, '142 W 74th St',   'New York', '10023', 'medium',
      '{"type":"Polygon","coordinates":[[[-73.978,40.777],[-73.9775,40.777],[-73.9775,40.7775],[-73.978,40.7775],[-73.978,40.777]]]}'::jsonb,
      280, 40.7773, -73.9778, false, true, '4213', 'Side gate — please close firmly'),
    (p2, _org_id, c2, '86 Bedford Ave',  'New York', '10024', 'large',
      '{"type":"Polygon","coordinates":[[[-73.984,40.786],[-73.9832,40.786],[-73.9832,40.7867],[-73.984,40.7867],[-73.984,40.786]]]}'::jsonb,
      540, 40.7863, -73.9836, false, false, NULL, 'Gate unlocked — dogs stay inside during service'),
    (p3, _org_id, c3, '2005 Broadway',   'New York', '10023', 'small',
      '{"type":"Polygon","coordinates":[[[-73.98,40.775],[-73.9797,40.775],[-73.9797,40.7754],[-73.98,40.7754],[-73.98,40.775]]]}'::jsonb,
      120, 40.7752, -73.9799, true,  false, '9911', 'Rex is aggressive — do NOT enter if he is out'),
    (p4, _org_id, c4, '311 E 12th St',   'New York', '10003', 'medium',
      '{"type":"Polygon","coordinates":[[[-73.984,40.732],[-73.9835,40.732],[-73.9835,40.7325],[-73.984,40.7325],[-73.984,40.732]]]}'::jsonb,
      260, 40.7322, -73.9837, false, false, NULL, NULL),
    (p5, _org_id, c5, '77 Riverside Dr', 'New York', '10024', 'xlarge',
      '{"type":"Polygon","coordinates":[[[-73.986,40.789],[-73.982,40.789],[-73.982,40.792],[-73.986,40.792],[-73.986,40.789]]]}'::jsonb,
      12000, 40.7905, -73.984, false, false, NULL, 'On-site contact: Dana (property manager) 555-0123'),
    (p6, _org_id, c6, '450 Brookline Pl','New York', '10001', 'xlarge',
      '{"type":"Polygon","coordinates":[[[-73.995,40.748],[-73.992,40.748],[-73.992,40.751],[-73.995,40.751],[-73.995,40.748]]]}'::jsonb,
      9000, 40.7495, -73.9935, false, false, NULL, 'Loading dock on north side; use bay 2');

  INSERT INTO public.dogs (organization_id, property_id, name, breed, temperament, weight_class) VALUES
    (_org_id, p1, 'Cooper',    'Golden Retriever',   'friendly',  'large'),
    (_org_id, p1, 'Bella',     'Beagle',             'friendly',  'medium'),
    (_org_id, p2, 'Luna',      'Poodle Mix',         'friendly',  'medium'),
    (_org_id, p2, 'Max',       'Labrador',           'friendly',  'large'),
    (_org_id, p2, 'Charlie',   'French Bulldog',     'nervous',   'small'),
    (_org_id, p3, 'Rex',       'German Shepherd',    'aggressive','large'),
    (_org_id, p4, 'Daisy',     'Cavalier',           'friendly',  'small');

  INSERT INTO public.waste_stations (organization_id, client_id, property_id, label, location_description, liner_size, capacity_liners, sort_order, active) VALUES
    (_org_id, c5, p5, 'Station A', 'Front lawn near pool gate',   'large', 200, 1, true),
    (_org_id, c5, p5, 'Station B', 'Back walking path — north',   'large', 200, 2, true),
    (_org_id, c5, p5, 'Station C', 'Back walking path — south',   'large', 200, 3, true),
    (_org_id, c5, p5, 'Station D', 'Playground perimeter',        'large', 200, 4, true),
    (_org_id, c5, p5, 'Station E', 'Clubhouse patio',             'medium',150, 5, true),
    (_org_id, c5, p5, 'Station F', 'Riverside walkway east',      'large', 200, 6, true),
    (_org_id, c5, p5, 'Station G', 'Riverside walkway west',      'large', 200, 7, true),
    (_org_id, c5, p5, 'Station H', 'Community garden entrance',   'medium',150, 8, true),
    (_org_id, c6, p6, 'Plaza 1',   'Main entrance turnaround',    'large', 200, 1, true),
    (_org_id, c6, p6, 'Plaza 2',   'Building A courtyard',        'large', 200, 2, true),
    (_org_id, c6, p6, 'Plaza 3',   'Building B courtyard',        'large', 200, 3, true),
    (_org_id, c6, p6, 'Plaza 4',   'Rear parking greenbelt',      'large', 200, 4, true);

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

  INSERT INTO public.addon_services(organization_id, code, name, description, kind, unit_price_cents, default_frequency, audience, active) VALUES
    (_org_id, 'DEMO_DEODORIZE', 'Yard deodorizer treatment',   'Freshens turf between visits — safe for pets and lawn.', 'recurring', 3500, 'monthly', 'residential', true),
    (_org_id, 'DEMO_TICK',      'Tick & flea perimeter spray', 'Seasonal perimeter spray focused on high-traffic dog areas.','one_time', 5500, NULL,     'residential', true),
    (_org_id, 'DEMO_HAUL',      'Trash haul-away',             'We bag it out — perfect for renters without curbside pickup.','recurring', 800,'weekly', 'residential', true),
    (_org_id, 'DEMO_STN_REFILL','Station liner refill (bulk)', 'Restock all pet-waste dispensers with 200 liners each.', 'one_time', 12500, NULL,        'commercial',  true),
    (_org_id, 'DEMO_COMMON',    'Extra common-area clean',     'Additional visit for high-traffic HOA/plaza common areas.','recurring', 15000,'monthly','commercial',  true);

  ph_idx := 0;
  FOR wk IN 1..8 LOOP
    d := current_date - (wk * 7);
    INSERT INTO public.visits (id, organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, weather_flagged, weather_note, rescheduled_from)
    VALUES (gen_random_uuid(), _org_id, c1, p1, s1, z_suburb,
            d, CASE WHEN wk = 3 THEN 'skipped'::visit_status ELSE 'completed'::visit_status END,
            CASE WHEN wk = 3 THEN NULL ELSE (d + time '10:30')::timestamptz END,
            wk = 3, CASE WHEN wk = 3 THEN 'Heavy rain — rescheduled +1 day' END,
            NULL) RETURNING id INTO v;
    IF wk IN (1,2,4) THEN
      ph_idx := (ph_idx % 3) + 1;
      INSERT INTO public.visit_photos (organization_id, visit_id, storage_path, kind, uploaded_by)
      VALUES (_org_id, v, 'demo/before-' || ph_idx || '.jpg', 'before', c1),
             (_org_id, v, 'demo/after-'  || ph_idx || '.jpg', 'after',  c1);
    END IF;

    INSERT INTO public.visits (id, organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at)
    VALUES (gen_random_uuid(), _org_id, c2, p2, s2, z_suburb, d, 'completed', (d + time '11:00')::timestamptz)
    RETURNING id INTO v;
    IF wk IN (1,3) THEN
      ph_idx := (ph_idx % 3) + 1;
      INSERT INTO public.visit_photos (organization_id, visit_id, storage_path, kind, uploaded_by)
      VALUES (_org_id, v, 'demo/before-' || ph_idx || '.jpg', 'before', c2),
             (_org_id, v, 'demo/after-'  || ph_idx || '.jpg', 'after',  c2);
    END IF;

    IF wk % 2 = 0 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
            scheduled_on, status, completed_at, skip_reason_code, skip_reason)
      VALUES (_org_id, c3, p3, s3, z_urban, d,
              CASE WHEN wk = 4 THEN 'skipped'::visit_status ELSE 'completed'::visit_status END,
              CASE WHEN wk = 4 THEN NULL ELSE (d + time '13:00')::timestamptz END,
              CASE WHEN wk = 4 THEN 'gate_locked'::skip_reason_code ELSE NULL END,
              CASE WHEN wk = 4 THEN 'Gate locked — could not access yard' END);
    END IF;

    IF wk <= 4 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
            scheduled_on, status, completed_at)
      VALUES (_org_id, c4, p4, s4, z_urban, d, 'completed', (d + time '14:15')::timestamptz);
    END IF;

    INSERT INTO public.visits (id, organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (gen_random_uuid(), _org_id, c5, p5, s5, z_suburb, d, 'completed', (d + time '08:00')::timestamptz, 8)
    RETURNING id INTO v;
    IF wk IN (1,2) THEN
      INSERT INTO public.visit_photos (organization_id, visit_id, storage_path, kind, uploaded_by)
      VALUES (_org_id, v, 'demo/before-3.jpg', 'before', c5),
             (_org_id, v, 'demo/after-3.jpg',  'after',  c5);
    END IF;

    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (_org_id, c5, p5, s5, z_suburb, d + 3, 'completed', (d + 3 + time '08:00')::timestamptz, 8);

    INSERT INTO public.visits (id, organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, completed_at, station_count_serviced)
    VALUES (gen_random_uuid(), _org_id, c6, p6, s6, z_urban, d, 'completed', (d + time '07:30')::timestamptz, 12)
    RETURNING id INTO v;
    IF wk = 1 THEN
      INSERT INTO public.visit_photos (organization_id, visit_id, storage_path, kind, uploaded_by)
      VALUES (_org_id, v, 'demo/before-3.jpg', 'before', c6),
             (_org_id, v, 'demo/after-3.jpg',  'after',  c6);
    END IF;
  END LOOP;

  FOR wk IN 1..2 LOOP
    d := current_date + (wk * 7);
    INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
          scheduled_on, status, eta_start, eta_end)
    VALUES
      (_org_id, c1, p1, s1, z_suburb, d, 'scheduled', (d + time '10:00')::timestamptz, (d + time '12:00')::timestamptz),
      (_org_id, c2, p2, s2, z_suburb, d, 'scheduled', (d + time '11:00')::timestamptz, (d + time '13:00')::timestamptz),
      (_org_id, c4, p4, s4, z_urban,  d, 'scheduled', (d + time '14:00')::timestamptz, (d + time '16:00')::timestamptz),
      (_org_id, c5, p5, s5, z_suburb, d, 'scheduled', (d + time '08:00')::timestamptz, (d + time '10:30')::timestamptz),
      (_org_id, c5, p5, s5, z_suburb, d + 3, 'scheduled', (d + 3 + time '08:00')::timestamptz, (d + 3 + time '10:30')::timestamptz),
      (_org_id, c6, p6, s6, z_urban,  d, 'scheduled', (d + time '07:30')::timestamptz, (d + time '10:00')::timestamptz);
    IF wk = 2 THEN
      INSERT INTO public.visits (organization_id, client_id, property_id, subscription_id, zone_id,
             scheduled_on, status, eta_start, eta_end)
      VALUES (_org_id, c3, p3, s3, z_urban, d, 'scheduled', (d + time '13:00')::timestamptz, (d + time '15:00')::timestamptz);
    END IF;
  END LOOP;

  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at, paid_at)
  VALUES (inv, _org_id, c1, 'postpaid', 'paid',
          12000, 12000, current_date - 35, current_date - 5, now() - interval '4 days', now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4 weekly visits (Cooper + Bella)', 12000);
  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at)
  VALUES (_org_id, inv, 12000, 'succeeded', now() - interval '2 days');

  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at, last_reminder_at)
  VALUES (inv, _org_id, c3, 'postpaid', 'open',
          5000, 5000, current_date - 55, current_date - 25, now() - interval '24 days', now() - interval '3 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '2 biweekly visits — Rex', 5000);

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

  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end)
  VALUES (inv, _org_id, c4, 'postpaid', 'draft', 10000, 10000, current_date - 28, current_date);
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4 weekly visits — Daisy', 10000);

  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at)
  VALUES (inv, _org_id, c5, 'postpaid', 'open', 76000, 76000,
          current_date - 30, current_date, now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '8 twice-weekly visits (Riverside)', 76000);

  inv := gen_random_uuid();
  INSERT INTO public.invoices (id, organization_id, client_id, kind, status,
        subtotal_cents, total_cents, period_start, period_end, issued_at)
  VALUES (inv, _org_id, c6, 'prepaid_topup', 'open', 30000, 30000,
          current_date - 2, current_date - 2, now() - interval '2 days');
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (inv, '4-visit prepaid top-up', 30000);

  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, note)
  VALUES (_org_id, c3, -3500, 'debit', 'Deep-clean applied against future invoice');

  INSERT INTO public.promo_codes (organization_id, code, discount_type, discount_value_cents, description, active)
  VALUES
    (_org_id, 'DEMOWELCOME', 'amount',  2000, '$20 off your first invoice', true),
    (_org_id, 'DEMOSPRING',  'percent', NULL, '15% off next 3 visits', true);
  UPDATE public.promo_codes SET discount_percent = 15 WHERE organization_id = _org_id AND code = 'DEMOSPRING';

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

  INSERT INTO public.leads (name, email, phone, dog_count, frequency, location, source, status, message) VALUES
    ('Alexandra Kim', 'alex.k@example.com',   '+15552220001', 2, 'weekly',   '10024', 'website', 'new',       'Two goldens — moving in next month'),
    ('Marcus Bell',   'marcus.b@example.com', '+15552220002', 1, 'biweekly', '10003', 'referral','contacted', 'Referred by Emily'),
    ('Lauren Woods',  'lauren.w@example.com', NULL,           3, 'weekly',   '10001', 'website', 'new',       'Big backyard, three dogs');

  INSERT INTO public.qc_tickets (organization_id, client_id, visit_id, category, message, status, resolution_note, resolved_at)
  SELECT _org_id, c1, v2.id, 'missed_spot', 'Corner near the shed still had a couple of piles', 'resolved',
         'Tech returned same day and cleaned the corner. Sorry we missed it!', now() - interval '10 days'
  FROM public.visits v2 WHERE v2.client_id = c1 ORDER BY v2.scheduled_on DESC LIMIT 1;

  INSERT INTO public.qc_tickets (organization_id, client_id, category, message, status)
  VALUES (_org_id, c3, 'gate_left_open', 'Please double check gate — Rex is an escape risk', 'open');

  INSERT INTO public.qc_tickets (organization_id, client_id, category, message, status, resolution_note)
  VALUES (_org_id, c5, 'other', 'Station D by the playground was overflowing on Monday', 'in_review',
          'Assigning a mid-week extra pickup. Will confirm within 24h.');

  RETURN jsonb_build_object(
    'ok', true, 'clients', 6,
    'visits_created',   (SELECT count(*) FROM public.visits WHERE organization_id = _org_id),
    'invoices_created', (SELECT count(*) FROM public.invoices WHERE organization_id = _org_id),
    'stations_created', (SELECT count(*) FROM public.waste_stations WHERE organization_id = _org_id),
    'addons_created',   (SELECT count(*) FROM public.addon_services WHERE organization_id = _org_id)
  );
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated;
