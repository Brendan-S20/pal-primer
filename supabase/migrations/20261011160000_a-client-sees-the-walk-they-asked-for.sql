-- A client sees the walk they asked for (the service catalog, phase 5: the
-- portal's plan and requests).
--
-- The portal read a plan as its frequency ("Weekly") and a one-off request
-- as "Extra visit", because until the catalog a business sold one thing and a
-- plan ran once a week. A dog walker's client is on Mon, Wed and Fri, and
-- asked on Tuesday for a 30-minute walk, not for a cleanup. Three portal
-- functions learn two facts the tables already hold:
--
--   subscriptions.weekdays   (20261010010000)  the days a plan runs on
--   qc_tickets.service_id    (20261011100200)  the service a request names
--
-- ── WHAT CHANGES, AND WHAT A PET-WASTE CLIENT SEES ───────────────────────
--
--   portal_get_client                 + primary_weekdays, primary_service_name,
--                                       primary_service_line
--   portal_list_prepaid_subscriptions + weekdays
--   portal_list_my_requests           + service_name
--
-- Every new column is appended at the END, so a reader that counts positions
-- (none in src/, but the rule 20260805040000 set) keeps reading the same row.
-- For a pet-waste business every new column is NULL: no plan of theirs has a
-- weekday set, no request of theirs names a service (the pet-waste service is
-- recorded as NULL, 20261011100200), and the app shows the name of a service
-- only when it is not the seeded "Pet waste removal" (visitServiceLabel). So
-- the header chip still reads "Weekly · 2 dogs · $24.00/visit" and a request
-- still reads "Extra visit".
--
-- ── DROP DISCARDS GRANTS ──────────────────────────────────────────────────
--
-- A return type cannot change under CREATE OR REPLACE, so each is dropped and
-- recreated, and DROP takes the grants with it. All three are the portal
-- server's to call through the admin client: postgres and service_role, and
-- nobody with a JWT. Each is revoked from PUBLIC, anon and authenticated and
-- granted back to service_role, and the check block at the end fails the
-- replay if any of the three came back callable by a client role. (Both
-- 20260731240000 and 20260929050000 left them that way; the publishable key
-- lost its grant on portal_list_prepaid_subscriptions here, where it had kept
-- it since 20260701170254, with nothing in src/ calling it that way.)
--
-- ── WHAT THE LIVE APP SEES BETWEEN THIS AND THE PUBLISH ───────────────────
--
-- Every caller reads the rows by column NAME (sb.rpc(...) returns objects),
-- and no caller passes a different argument, so the version of the app that
-- is live when this applies keeps working: it reads the columns it knows and
-- never sees the three new ones.
--
-- Replays into an empty database: three functions and their grants. No row
-- is needed, and the bodies are the live ones with one join each.

-- ── 1. portal_get_client ─────────────────────────────────────────────────
-- The 20260805040000 body, plus the primary plan's days and service.

DROP FUNCTION IF EXISTS public.portal_get_client(uuid);

CREATE FUNCTION public.portal_get_client(_token uuid)
RETURNS TABLE(
  client_id uuid, organization_id uuid, display_name text, account_type text,
  credit_balance_cents integer, org_name text, brand_color text, logo_url text,
  contact_phone text, contact_email text, autopay_enabled boolean,
  has_saved_card boolean, card_brand text, card_last4 text,
  reschedule_cutoff_hours integer, allow_self_reschedule boolean,
  allow_vacation_hold boolean, allow_frequency_change boolean,
  auto_apply_changes boolean, primary_frequency text, primary_price_cents integer,
  primary_dog_count integer, primary_unit_count integer, primary_billing_cadence text,
  station_count integer, next_visit_id uuid, next_visit_on date,
  next_visit_eta_start timestamp with time zone, next_visit_eta_end timestamp with time zone,
  next_visit_tech_name text,
  sms_consent_at timestamp with time zone,
  sms_opt_out boolean,
  primary_phone text,
  -- NEW, appended (20261011160000): the primary plan's days each week, and
  -- what it is for.
  primary_weekdays smallint[],
  primary_service_name text,
  primary_service_line text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
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
    (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = nv.assigned_staff_id),
    cr.sms_consent_at, cr.sms_opt_out, cr.primary_phone,
    ps.weekdays, svc.name, svc.service_line
  FROM client_row cr
  LEFT JOIN primary_sub ps ON true
  LEFT JOIN public.services svc ON svc.id = ps.service_id
  LEFT JOIN stations st ON true
  LEFT JOIN next_v nv ON true
$function$;

COMMENT ON FUNCTION public.portal_get_client(uuid) IS
  'Client + org + next visit for the portal. The three sms_* columns exist so '
  'the portal texting toggle can render its own current state; without them it '
  'shipped unwired because there was nothing to show. primary_weekdays and '
  'primary_service_* (20261011160000) say the days the plan runs on and what it is for.';

REVOKE ALL ON FUNCTION public.portal_get_client(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO service_role;

-- ── 2. portal_list_prepaid_subscriptions ─────────────────────────────────
-- The 20260701170254 body, plus the plan's days.

DROP FUNCTION IF EXISTS public.portal_list_prepaid_subscriptions(uuid);

CREATE FUNCTION public.portal_list_prepaid_subscriptions(_token uuid)
RETURNS TABLE(
  subscription_id uuid, price_cents integer, frequency public.service_frequency, property_label text,
  weekdays smallint[]
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.id, s.price_cents, s.frequency, p.label, s.weekdays
    FROM public.clients c
    JOIN public.subscriptions s ON s.client_id = c.id
    LEFT JOIN public.properties p ON p.id = s.property_id
   WHERE c.portal_token = _token AND s.status = 'active' AND s.billing_cadence = 'prepaid'
   ORDER BY p.label NULLS LAST
$$;

REVOKE ALL ON FUNCTION public.portal_list_prepaid_subscriptions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_prepaid_subscriptions(uuid) TO service_role;

-- ── 3. portal_list_my_requests ───────────────────────────────────────────
-- The 20260929050000 body, plus the name of the service a request is for.

DROP FUNCTION IF EXISTS public.portal_list_my_requests(uuid);

CREATE FUNCTION public.portal_list_my_requests(_token uuid)
RETURNS TABLE (
  ticket_id uuid, visit_id uuid, visit_date date, category text, message text,
  status text, resolution_note text, resolved_at timestamptz, created_at timestamptz,
  requested_on date, booked_on date,
  service_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT t.id, t.visit_id, v.scheduled_on, t.category, t.message,
         t.status, t.resolution_note, t.resolved_at, t.created_at,
         t.requested_on, b.scheduled_on,
         svc.name
    FROM public.clients c
    JOIN public.qc_tickets t ON t.client_id = c.id AND t.organization_id = c.organization_id
    LEFT JOIN public.visits v ON v.id = t.visit_id
    LEFT JOIN public.visits b ON b.id = t.booked_visit_id
    LEFT JOIN public.services svc ON svc.id = t.service_id
   WHERE c.portal_token = _token AND c.active = true
   ORDER BY t.created_at DESC
   LIMIT 40
$function$;

REVOKE ALL ON FUNCTION public.portal_list_my_requests(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_my_requests(uuid) TO service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn text;
  _cols text[];
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'public.portal_get_client(uuid)',
    'public.portal_list_prepaid_subscriptions(uuid)',
    'public.portal_list_my_requests(uuid)'
  ] LOOP
    IF to_regprocedure(_fn) IS NULL THEN
      RAISE EXCEPTION '% was not created', _fn;
    END IF;
    IF has_function_privilege('anon', _fn, 'EXECUTE')
       OR has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is reachable by an API role; it is the portal server''s to call', _fn;
    END IF;
    IF NOT has_function_privilege('service_role', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role cannot call %; every portal page would fail', _fn;
    END IF;
  END LOOP;

  -- The new columns are there, and at the end. A RETURNS TABLE column is an
  -- OUT argument, so the names are in proargnames after the one IN argument.
  SELECT proargnames INTO _cols FROM pg_proc WHERE oid = 'public.portal_get_client(uuid)'::regprocedure;
  IF _cols[array_length(_cols, 1) - 2 : array_length(_cols, 1)]
     <> ARRAY['primary_weekdays', 'primary_service_name', 'primary_service_line'] THEN
    RAISE EXCEPTION 'portal_get_client does not end in primary_weekdays, primary_service_name, primary_service_line: %', _cols;
  END IF;
  SELECT proargnames INTO _cols FROM pg_proc WHERE oid = 'public.portal_list_prepaid_subscriptions(uuid)'::regprocedure;
  IF _cols[array_length(_cols, 1)] <> 'weekdays' THEN
    RAISE EXCEPTION 'portal_list_prepaid_subscriptions does not end in weekdays: %', _cols;
  END IF;
  SELECT proargnames INTO _cols FROM pg_proc WHERE oid = 'public.portal_list_my_requests(uuid)'::regprocedure;
  IF _cols[array_length(_cols, 1)] <> 'service_name' THEN
    RAISE EXCEPTION 'portal_list_my_requests does not end in service_name: %', _cols;
  END IF;
END
$post$;
