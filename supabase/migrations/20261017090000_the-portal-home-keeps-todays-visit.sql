-- The portal home keeps today's visit (#480).
--
-- portal_get_client picked the client's next visit with
-- `v.scheduled_on >= CURRENT_DATE`. CURRENT_DATE is the database's day, which
-- is UTC, and scheduled_on is the organization's calendar day. For an org in
-- America/Chicago, UTC is a day ahead from about 19:00 local until midnight,
-- so for those hours the portal home skipped today's visit and showed the
-- next one, or none.
--
-- 20260728120000 fixed the same bug in portal_list_upcoming_visits with
-- (now() AT TIME ZONE COALESCE(o.timezone, 'UTC'))::date. This file uses that
-- expression and its fallback. client_row now also carries o.timezone so
-- next_v can read it; nothing else in the body changes.
--
-- The return type is unchanged, so CREATE OR REPLACE keeps the grants. The
-- REVOKE and GRANT are restated anyway, as 20261011160000 left them (no later
-- migration touches them), so this file is correct whatever ran before it.
--
-- Replays into an empty database: one function, no rows.

CREATE OR REPLACE FUNCTION public.portal_get_client(_token uuid)
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
           o.portal_auto_apply_changes    AS o_auto,
           o.timezone                     AS o_tz
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
     WHERE v.scheduled_on >= (now() AT TIME ZONE COALESCE(cr.o_tz, 'UTC'))::date
       AND v.status IN ('scheduled','in_progress')
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

REVOKE ALL ON FUNCTION public.portal_get_client(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO service_role;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _src text;
BEGIN
  IF has_function_privilege('anon', 'public.portal_get_client(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.portal_get_client(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'portal_get_client is reachable by an API role; it is the portal server''s to call';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.portal_get_client(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot call portal_get_client; every portal page would fail';
  END IF;

  SELECT prosrc INTO _src FROM pg_proc WHERE oid = 'public.portal_get_client(uuid)'::regprocedure;
  IF _src ILIKE '%CURRENT_DATE%' THEN
    RAISE EXCEPTION 'portal_get_client still compares against CURRENT_DATE, the UTC day';
  END IF;
END
$post$;
