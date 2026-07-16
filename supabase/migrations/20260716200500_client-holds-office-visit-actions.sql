-- QA round 8 (client detail): vacation holds + office-side visit actions.
--
-- 1. client_holds: a date range during which a client gets no visits.
--    Inserting a hold removes already-scheduled visits inside the range
--    (trigger), and generate_visits_core skips dates inside a hold.
-- 2. office_complete_visit / office_skip_visit: the client-detail Visits tab
--    lets office roles complete or cancel a visit. The existing complete_visit
--    and skip_visit RPCs authorize the ASSIGNED TECH (and require a completion
--    photo), so these office variants mirror their bodies with a
--    can_write_org check and no photo requirement.

-- ── client_holds ────────────────────────────────────────────────────────────

CREATE TABLE public.client_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  reason text CHECK (char_length(reason) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on)
);

CREATE INDEX client_holds_client_idx ON public.client_holds (client_id, starts_on, ends_on);
CREATE INDEX client_holds_org_idx ON public.client_holds (organization_id);

ALTER TABLE public.client_holds ENABLE ROW LEVEL SECURITY;

-- Same posture as other org tables (see client_notes / addon_subscriptions):
-- every org member can read, office roles (can_write_org) manage.
CREATE POLICY client_holds_select ON public.client_holds
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY client_holds_write ON public.client_holds
  FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- On hold insert, scheduled visits inside the range come off the board.
-- History (completed/skipped/canceled) is untouched.
CREATE OR REPLACE FUNCTION public.tg_client_holds_remove_visits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  DELETE FROM public.visits
   WHERE client_id = NEW.client_id
     AND status = 'scheduled'
     AND scheduled_on BETWEEN NEW.starts_on AND NEW.ends_on;
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER client_holds_remove_visits
  AFTER INSERT ON public.client_holds
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_holds_remove_visits();

-- ── generate_visits_core: skip dates inside a hold ──────────────────────────
-- Recreated from 20260715090000_client-detail-foundations.sql with one change:
-- each insert is guarded by NOT EXISTS over client_holds so no visit is
-- generated on a date inside a hold for that client.

CREATE OR REPLACE FUNCTION public.generate_visits_core(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _sub record;
  _next date;
  _candidate date;
  _stop date;
  _inserted integer := 0;
  _prefs int[];
  _step int;
  _dow int;
  _guard int;
BEGIN
  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on,
           s.ends_on, s.preferred_weekdays, s.interval_weeks, s.interval_days
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    _prefs := _sub.preferred_weekdays;
    -- Generation never runs past the subscription's end date.
    _stop := LEAST(_through, COALESCE(_sub.ends_on, _through));
    IF _stop < _sub.started_on THEN CONTINUE; END IF;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;
      IF (_sub.ends_on IS NULL OR _candidate <= _sub.ends_on)
         AND NOT EXISTS (SELECT 1 FROM public.client_holds h
                          WHERE h.client_id = _sub.client_id
                            AND _candidate BETWEEN h.starts_on AND h.ends_on) THEN
        INSERT INTO public.visits
          (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
        VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
        ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
        IF FOUND THEN _inserted := _inserted + 1; END IF;
      END IF;
      CONTINUE;
    END IF;

    IF _sub.frequency = 'twice_weekly' AND _prefs IS NOT NULL AND array_length(_prefs,1) >= 2 THEN
      _candidate := _sub.started_on;
      _candidate := _candidate - EXTRACT(DOW FROM _candidate)::int;
      WHILE _candidate <= _stop LOOP
        FOREACH _dow IN ARRAY _prefs LOOP
          _next := _candidate + _dow;
          IF _next >= _sub.started_on AND _next <= _stop
             AND NOT EXISTS (SELECT 1 FROM public.blackout_dates
                              WHERE organization_id = _org_id AND blackout_on = _next)
             AND NOT EXISTS (SELECT 1 FROM public.client_holds h
                              WHERE h.client_id = _sub.client_id
                                AND _next BETWEEN h.starts_on AND h.ends_on) THEN
            INSERT INTO public.visits
              (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _next)
            ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
        END LOOP;
        _candidate := _candidate + 7;
      END LOOP;
      CONTINUE;
    END IF;

    -- weekly honors interval_weeks (every N weeks); every_n_days uses
    -- interval_days. Both default to their base cadence when unset.
    _step := CASE _sub.frequency
      WHEN 'weekly'        THEN 7 * GREATEST(COALESCE(_sub.interval_weeks, 1), 1)
      WHEN 'biweekly'      THEN 14
      WHEN 'twice_weekly'  THEN 3
      WHEN 'every_n_days'  THEN GREATEST(COALESCE(_sub.interval_days, 1), 1)
      WHEN 'monthly'       THEN NULL
    END;

    SELECT MAX(scheduled_on) INTO _next FROM public.visits WHERE subscription_id = _sub.id;
    IF _next IS NULL THEN
      _candidate := _sub.started_on;
      IF _prefs IS NOT NULL AND _sub.frequency IN ('weekly','biweekly') THEN
        _guard := 0;
        WHILE NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_prefs)) AND _guard < 7 LOOP
          _candidate := _candidate + 1;
          _guard := _guard + 1;
        END LOOP;
      END IF;
    ELSE
      IF _sub.frequency = 'monthly' THEN
        _candidate := (_next + INTERVAL '1 month')::date;
      ELSE
        _candidate := _next + _step;
      END IF;
    END IF;

    WHILE _candidate <= _stop LOOP
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;

      IF _candidate > _stop THEN EXIT; END IF;

      IF NOT EXISTS (SELECT 1 FROM public.client_holds h
                      WHERE h.client_id = _sub.client_id
                        AND _candidate BETWEEN h.starts_on AND h.ends_on) THEN
        INSERT INTO public.visits
          (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
        VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
        ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
        IF FOUND THEN _inserted := _inserted + 1; END IF;
      END IF;

      IF _sub.frequency = 'monthly' THEN
        _candidate := (_candidate + INTERVAL '1 month')::date;
      ELSE
        _candidate := _candidate + _step;
      END IF;
    END LOOP;
  END LOOP;

  RETURN _inserted;
END;
$fn$;

-- Grant posture is unchanged: core stays internal to the two wrappers.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date) FROM PUBLIC, anon, authenticated;

-- ── Office visit actions ────────────────────────────────────────────────────

-- Mirrors complete_visit (prepaid credit debit included) but authorizes
-- office roles instead of the assigned tech and does not require a
-- completion photo (the office is recording a fact, not proving one).
CREATE OR REPLACE FUNCTION public.office_complete_visit(_visit_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _status public.visit_status; _sub_id uuid; _client uuid;
        _cadence public.billing_cadence; _price integer;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress') THEN
    RAISE EXCEPTION 'Only scheduled or in-progress visits can be completed';
  END IF;

  UPDATE public.visits
     SET status='completed', completed_at = now(),
         started_at = COALESCE(started_at, now()), updated_at = now()
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');

  SELECT v.subscription_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _sub_id, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END; $$;
GRANT EXECUTE ON FUNCTION public.office_complete_visit(uuid) TO authenticated;

-- Mirrors skip_visit (org skip-billing rules applied) but authorizes office
-- roles instead of the assigned tech.
CREATE OR REPLACE FUNCTION public.office_skip_visit(
  _visit_id uuid,
  _reason text,
  _code public.skip_reason_code DEFAULT 'other'
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
   WHERE id = _visit_id AND status IN ('scheduled','in_progress');
END; $$;
GRANT EXECUTE ON FUNCTION public.office_skip_visit(uuid, text, public.skip_reason_code) TO authenticated;
