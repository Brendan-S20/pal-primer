-- QA round 3 phase 3 adversarial-review fixes for the visit lifecycle (B6).
--
-- Finding 1 (timezone-aware miss cutoff): admin_transition_missed_visits keyed
-- on scheduled_on < CURRENT_DATE, but the DB session zone is UTC while the rest
-- of the PR became timezone-aware. For an org west of Central (Pacific/Alaska/
-- Hawaii) a visit scheduled for the CURRENT local day, still inside its service
-- window, satisfies scheduled_on < CURRENT_DATE(UTC) and was wrongly swept to
-- missed. The cutoff now uses the org's LOCAL date (now() AT TIME ZONE tz), so a
-- visit is missed only once the org's own calendar day has moved past it.
--
-- Finding 2 (recovery from missed): missed was a terminal dead-end — a visit
-- that was actually serviced (or wrongly auto-missed) could never be completed,
-- rescheduled, or reclassified, so it never billed and had no recourse. The
-- office complete/skip, tech complete, and reschedule paths now accept 'missed'
-- as a starting state. Completing a missed prepaid visit debits normally (the
-- miss never debited, so no double charge); a completed/rescheduled visit
-- rejoins the normal billing/routing flow.

-- ── Finding 1: org-local miss cutoff ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_transition_missed_visits(_org_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _n integer; _tz text; _local_today date;
BEGIN
  SELECT COALESCE(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _org_id;
  IF _tz IS NULL THEN RETURN 0; END IF;
  -- The org's OWN calendar day, not UTC's. A visit is missed only once the
  -- org's local date has moved strictly past its scheduled day.
  _local_today := (now() AT TIME ZONE _tz)::date;

  UPDATE public.visits
     SET status = 'missed',
         eta_start = NULL,
         eta_end = NULL,
         window_violated = false,
         updated_at = now()
   WHERE organization_id = _org_id
     AND status = 'scheduled'
     AND scheduled_on < _local_today
     AND started_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) TO service_role;

-- ── Finding 2: allow recovery from 'missed' ──────────────────────────────────
-- Tech completion (retroactive): a missed visit that was actually serviced can
-- be completed. Completion photo + tech authorization still required.
CREATE OR REPLACE FUNCTION public.complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _has_photo boolean; _sub_id uuid; _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;
  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion') INTO _has_photo;
  IF NOT _has_photo THEN
    RAISE EXCEPTION 'A completion photo is required before completing this visit';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

-- Office completion (retroactive): same recovery for office/dispatch staff.
CREATE OR REPLACE FUNCTION public.office_complete_visit(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _status public.visit_status; _sub_id uuid; _client uuid;
        _cadence public.billing_cadence; _price integer;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled, in-progress, or missed visits can be completed';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  -- A concurrent completion beat us to it: no double debit.
  IF NOT FOUND THEN RETURN; END IF;

  SELECT v.subscription_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END; $function$;

-- Reschedule: a missed visit can be moved to a new date (returns to scheduled).
CREATE OR REPLACE FUNCTION public.reschedule_visit(_visit_id uuid, _new_date date, _note text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _old date; _status public.visit_status;
BEGIN
  SELECT organization_id, scheduled_on, status INTO _org, _old, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled or missed visits can be rescheduled';
  END IF;
  IF _new_date = _old THEN RETURN; END IF;

  UPDATE public.visits
     SET scheduled_on = _new_date,
         status = 'scheduled',
         rescheduled_from = COALESCE(rescheduled_from, _old),
         weather_flagged = COALESCE(_note IS NOT NULL, false) OR weather_flagged,
         weather_note = COALESCE(_note, weather_note),
         assigned_staff_id = NULL,
         sequence = NULL,
         updated_at = now()
   WHERE id = _visit_id;
END;
$function$;

-- Office skip: a missed visit can be reclassified as a skip (e.g. a make-up
-- credit or a billable no-service call) rather than left as a bare miss.
CREATE OR REPLACE FUNCTION public.office_skip_visit(_visit_id uuid, _reason text, _code skip_reason_code DEFAULT 'other'::skip_reason_code)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _price integer; _pct integer; _charge integer;
BEGIN
  SELECT v.organization_id, s.price_cents
    INTO _org, _price
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _reason IS NULL OR length(trim(_reason)) = 0 THEN
    RAISE EXCEPTION 'A reason is required to cancel a visit';
  END IF;

  SELECT billable_pct INTO _pct
    FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = _code;
  IF _pct IS NULL THEN
    _pct := public.default_skip_billable_pct(_code);
  END IF;

  _charge := ROUND(COALESCE(_price, 0) * _pct / 100.0)::int;

  UPDATE public.visits
     SET status = 'skipped',
         skip_reason = _reason,
         skip_reason_code = _code,
         skip_billable = (_charge > 0),
         skip_charge_cents = _charge,
         updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
END; $function$;
