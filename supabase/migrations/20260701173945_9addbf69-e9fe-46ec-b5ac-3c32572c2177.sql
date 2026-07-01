
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS auto_generate_visits boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_generate_days_ahead integer NOT NULL DEFAULT 14 CHECK (auto_generate_days_ahead BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS auto_invoice_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overdue_reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS overdue_reminder_days integer NOT NULL DEFAULT 7 CHECK (overdue_reminder_days BETWEEN 1 AND 90);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz;

-- Bypass-caller admin functions callable from the nightly worker (SECURITY DEFINER, no auth checks)
CREATE OR REPLACE FUNCTION public.admin_generate_visits_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  _sub record; _next date; _candidate date; _inserted integer := 0;
  _prefs int[]; _step int; _dow int; _guard int;
BEGIN
  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on, s.preferred_weekdays
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    _prefs := _sub.preferred_weekdays;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates WHERE organization_id=_org_id AND blackout_on=_candidate) AND _guard < 14 LOOP
        _candidate := _candidate + 1; _guard := _guard + 1;
      END LOOP;
      INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      CONTINUE;
    END IF;

    IF _sub.frequency = 'twice_weekly' AND _prefs IS NOT NULL AND array_length(_prefs,1) >= 2 THEN
      _candidate := _sub.started_on - EXTRACT(DOW FROM _sub.started_on)::int;
      WHILE _candidate <= _through LOOP
        FOREACH _dow IN ARRAY _prefs LOOP
          _next := _candidate + _dow;
          IF _next >= _sub.started_on AND _next <= _through
             AND NOT EXISTS (SELECT 1 FROM public.blackout_dates WHERE organization_id=_org_id AND blackout_on=_next) THEN
            INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _next)
            ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
        END LOOP;
        _candidate := _candidate + 7;
      END LOOP;
      CONTINUE;
    END IF;

    _step := CASE _sub.frequency
      WHEN 'weekly' THEN 7 WHEN 'biweekly' THEN 14 WHEN 'twice_weekly' THEN 3 WHEN 'monthly' THEN NULL END;

    SELECT MAX(scheduled_on) INTO _next FROM public.visits WHERE subscription_id = _sub.id;
    IF _next IS NULL THEN
      _candidate := _sub.started_on;
      IF _prefs IS NOT NULL AND _sub.frequency IN ('weekly','biweekly') THEN
        _guard := 0;
        WHILE NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_prefs)) AND _guard < 7 LOOP
          _candidate := _candidate + 1; _guard := _guard + 1;
        END LOOP;
      END IF;
    ELSE
      IF _sub.frequency = 'monthly' THEN _candidate := (_next + INTERVAL '1 month')::date;
      ELSE _candidate := _next + _step; END IF;
    END IF;

    WHILE _candidate <= _through LOOP
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates WHERE organization_id=_org_id AND blackout_on=_candidate) AND _guard < 14 LOOP
        _candidate := _candidate + 1; _guard := _guard + 1;
      END LOOP;
      INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      IF FOUND THEN _inserted := _inserted + 1; END IF;
      IF _sub.frequency = 'monthly' THEN _candidate := (_candidate + INTERVAL '1 month')::date;
      ELSE _candidate := _candidate + _step; END IF;
    END LOOP;
  END LOOP;
  RETURN _inserted;
END; $fn$;

CREATE OR REPLACE FUNCTION public.admin_generate_invoices_for_org(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE _c record; _n integer := 0; _cid uuid; _org uuid; _invoice_id uuid; _v record;
  _total integer := 0; _min_date date; _max_date date; _count integer := 0;
BEGIN
  FOR _c IN
    SELECT DISTINCT v.client_id
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
  LOOP
    _cid := _c.client_id;
    SELECT organization_id INTO _org FROM public.clients WHERE id = _cid;
    SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
      INTO _count, _min_date, _max_date
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _cid AND v.scheduled_on <= _through AND li.id IS NULL
       AND s.billing_cadence='postpaid'
       AND (v.status='completed' OR (v.status='skipped' AND v.skip_billable=true));
    IF _count = 0 THEN CONTINUE; END IF;

    INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
    VALUES (_org, _cid, _min_date, _max_date, 'open', 'postpaid', now()) RETURNING id INTO _invoice_id;

    _total := 0;
    FOR _v IN
      SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
             v.skip_charge_cents, v.skip_reason_code, s.price_cents, p.address_line1
        FROM public.visits v
        JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.properties p ON p.id = v.property_id
        LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
       WHERE v.client_id = _cid AND v.scheduled_on <= _through AND li.id IS NULL
         AND s.billing_cadence='postpaid'
         AND (v.status='completed' OR (v.status='skipped' AND v.skip_billable=true))
       ORDER BY v.scheduled_on
    LOOP
      DECLARE _amt integer; _desc text;
      BEGIN
        IF _v.status = 'skipped' THEN
          _amt := COALESCE(_v.skip_charge_cents, 0);
          _desc := 'Skipped visit ' || to_char(_v.scheduled_on,'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
        ELSE
          _amt := COALESCE(_v.price_cents, 0);
          _desc := 'Service on ' || to_char(_v.scheduled_on,'YYYY-MM-DD') || COALESCE(' — ' || _v.address_line1, '');
        END IF;
        INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
        VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
        _total := _total + _amt;
      END;
    END LOOP;
    UPDATE public.invoices SET subtotal_cents=_total, total_cents=_total, updated_at=now() WHERE id=_invoice_id;
    _n := _n + 1;
  END LOOP;
  RETURN _n;
END; $fn$;
