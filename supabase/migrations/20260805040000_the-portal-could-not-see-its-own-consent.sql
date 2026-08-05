-- The portal opt-in had no way to know whether it was already on.
--
-- `portalSetSmsConsent` shipped with migration 20260805020000 and was called
-- from nothing. Part of why: `portal_get_client` returns thirty-odd columns
-- about the client and none of them say whether that client has agreed to be
-- texted, so a toggle on the portal had no state to render. A control that
-- cannot show its own current value is not a control.
--
-- Three columns added, chosen narrowly:
--
--   sms_consent_at   whether there is consent at all
--   sms_opt_out      whether they have since replied STOP, which overrides it
--   primary_phone    the number it would go to, so the portal can say "texts
--                    to (734) 555-0100" rather than asking somebody to agree
--                    to messages at a number they cannot see
--
-- `sms_consent_text` is deliberately NOT returned. The portal shows the CURRENT
-- wording when asking for consent; the stored historical wording is evidence
-- for an audit and belongs on the staff side, not echoed back to the client as
-- though it were today's terms.
--
-- The phone is already the client's own, on their own authenticated session —
-- this discloses nothing they did not give you.
--
-- ── DROP DISCARDS GRANTS ──────────────────────────────────────────────────
--
-- The return type changes, so CREATE OR REPLACE cannot do it and the function
-- has to be dropped first. DROP takes the grants with it, and this function is
-- reachable ONLY as service_role (the portal calls it through the admin
-- client). Losing that grant does not fail loudly — it breaks every portal
-- page for every client of every tenant, at once. The grant is restored at the
-- bottom of this file, and `anon`/`authenticated` are revoked explicitly so a
-- future reader can see the absence is deliberate rather than forgotten.

DROP FUNCTION IF EXISTS public.portal_get_client(uuid);

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
  -- NEW, appended. Added at the END so positional consumers of the existing
  -- thirty columns keep working; this function is read by several portal
  -- screens and reordering it would break the ones not touched here.
  sms_consent_at timestamp with time zone,
  sms_opt_out boolean,
  primary_phone text
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
    cr.sms_consent_at, cr.sms_opt_out, cr.primary_phone
  FROM client_row cr
  LEFT JOIN primary_sub ps ON true
  LEFT JOIN stations st ON true
  LEFT JOIN next_v nv ON true
$function$;

COMMENT ON FUNCTION public.portal_get_client(uuid) IS
  'Client + org + next visit for the portal. The three sms_* columns exist so '
  'the portal texting toggle can render its own current state; without them it '
  'shipped unwired because there was nothing to show.';

-- Restored, not assumed. Verified before the drop: postgres and service_role
-- held EXECUTE, and nothing else did.
REVOKE ALL ON FUNCTION public.portal_get_client(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.portal_get_client(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.portal_get_client(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.portal_get_client(uuid) TO service_role;
