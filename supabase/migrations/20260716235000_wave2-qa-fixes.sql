-- QA fixes for round 8 wave 2 (adversarial review findings).
--
-- 1 (P1) Cross-tenant spoofing on commercial units: property_units /
--   unit_incidents / dogs.unit_id only checked can_write_org on
--   organization_id, so a writer in org A could attach org B's property/unit/
--   dog ids. Validation triggers (same pattern as tg_client_holds_validate in
--   20260716210000) now enforce the whole chain: unit.property belongs to
--   unit.org, incident.unit belongs to incident.property (which belongs to
--   incident.org), incident.dog lives in that unit (or at least on that
--   property), and dogs.unit_id must point at a unit on the dog's own
--   property.
-- 2 (P1) run_billing_cycles concurrency: the addon status flip had no
--   status='pending' guard, so two concurrent runs (pg_cron + nightly worker)
--   could double-bill addons or emit $0 invoices. Fixed with a per-client
--   advisory xact lock in run_billing_cycles, a claim-style pending guard on
--   the addon flip in admin_generate_invoice_for_client, and a zero-line-item
--   guard that deletes an empty invoice instead of leaving a $0 open one.
-- 3 (P1, note only) 20260716220000 force-flipped auto_invoice_enabled=true
--   for ALL orgs, overriding explicit opt-outs. That data change already ran
--   and we cannot recover who had opted out, so NO data change is made here.
--   The default stays true for new orgs; the app-side fix makes the toggle
--   effective again (autoSendScheduledInvoices now runs inside the
--   auto_invoice_enabled gate, and autopay respects the grace window) so an
--   org that re-disables the toggle actually stops the automation.
-- 6 (P2) offending_count was incremented read-modify-write in JS; expose an
--   atomic increment_unit_offense() instead.

-- ── Finding 1: cross-tenant validation triggers ──────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_property_units_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.id = NEW.property_id AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Property does not belong to this organization';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS property_units_validate ON public.property_units;
CREATE TRIGGER property_units_validate
  BEFORE INSERT OR UPDATE ON public.property_units
  FOR EACH ROW EXECUTE FUNCTION public.tg_property_units_validate();

CREATE OR REPLACE FUNCTION public.tg_unit_incidents_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.properties p
     WHERE p.id = NEW.property_id AND p.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Property does not belong to this organization';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.property_units u
     WHERE u.id = NEW.unit_id AND u.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'Unit does not belong to this property';
  END IF;
  -- A named dog must live in this unit, or at minimum on this property
  -- (property-level dogs that were never assigned to a unit).
  IF NEW.dog_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d
     WHERE d.id = NEW.dog_id
       AND (d.unit_id = NEW.unit_id OR d.property_id = NEW.property_id)
  ) THEN
    RAISE EXCEPTION 'Dog does not belong to this unit';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS unit_incidents_validate ON public.unit_incidents;
CREATE TRIGGER unit_incidents_validate
  BEFORE INSERT OR UPDATE ON public.unit_incidents
  FOR EACH ROW EXECUTE FUNCTION public.tg_unit_incidents_validate();

-- dogs.unit_id could be pointed at another org's / another property's unit by
-- a direct UPDATE (RLS only checks the dog's own organization_id).
CREATE OR REPLACE FUNCTION public.tg_dogs_unit_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.unit_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.property_units u
     WHERE u.id = NEW.unit_id AND u.property_id = NEW.property_id
  ) THEN
    RAISE EXCEPTION 'Unit does not belong to this dog''s property';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS dogs_unit_validate ON public.dogs;
CREATE TRIGGER dogs_unit_validate
  BEFORE INSERT OR UPDATE ON public.dogs
  FOR EACH ROW EXECUTE FUNCTION public.tg_dogs_unit_validate();

-- ── Finding 2: billing engine concurrency ────────────────────────────────────
--
-- admin_generate_invoice_for_client: identical to 20260716220000 except
--   (a) the addon flip is now a CLAIM — UPDATE ... WHERE status='pending';
--       when NOT FOUND (a concurrent run already invoiced it) the line item
--       is skipped instead of double-billed;
--   (b) if, after both loops, the invoice ended up with zero line items
--       (every billable was claimed by a concurrent run between the candidate
--       count and the loops), the empty invoice is deleted and NULL returned
--       instead of leaving a $0 open invoice.

CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _invoice_id uuid; _v record; _a record;
  _total integer := 0; _min_date date; _max_date date;
  _visit_count integer := 0; _addon_count integer := 0;
  _li_id uuid; _addon_min date; _addon_max date;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;

  SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
    INTO _visit_count, _min_date, _max_date
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
   WHERE v.client_id = _client_id
     AND v.scheduled_on <= _through
     AND li.id IS NULL
     AND s.billing_cadence = 'postpaid'
     AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));

  SELECT COUNT(*), MIN(occurred_on), MAX(occurred_on)
    INTO _addon_count, _addon_min, _addon_max
    FROM public.addon_charges
   WHERE client_id = _client_id
     AND status = 'pending'
     AND occurred_on <= _through;

  IF _visit_count = 0 AND _addon_count = 0 THEN
    RETURN NULL;
  END IF;

  IF _addon_count > 0 THEN
    _min_date := LEAST(COALESCE(_min_date, _addon_min), _addon_min);
    _max_date := GREATEST(COALESCE(_max_date, _addon_max), _addon_max);
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', 'postpaid', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
           v.skip_charge_cents, v.skip_reason_code,
           s.price_cents, p.address_line1
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
     ORDER BY v.scheduled_on
  LOOP
    DECLARE _amt integer; _desc text;
    BEGIN
      IF _v.status = 'skipped' THEN
        _amt := COALESCE(_v.skip_charge_cents, 0);
        _desc := 'Skipped visit ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
      ELSE
        _amt := COALESCE(_v.price_cents, 0);
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.address_line1, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;
    END;
  END LOOP;

  FOR _a IN
    SELECT * FROM public.addon_charges
     WHERE client_id = _client_id AND status = 'pending' AND occurred_on <= _through
     ORDER BY occurred_on
  LOOP
    -- CLAIM the charge first (status guard): if a concurrent run already
    -- flipped it to 'invoiced' (or it was voided/paid meanwhile), NOT FOUND —
    -- skip the line item instead of billing the addon twice.
    UPDATE public.addon_charges
       SET status = 'invoiced', updated_at = now()
     WHERE id = _a.id AND status = 'pending';
    IF NOT FOUND THEN
      CONTINUE;
    END IF;

    INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, NULL,
      _a.description || ' (' || to_char(_a.occurred_on,'YYYY-MM-DD') || ')' ||
      CASE WHEN _a.quantity > 1 THEN ' x ' || _a.quantity ELSE '' END,
      _a.amount_cents)
    RETURNING id INTO _li_id;

    UPDATE public.addon_charges
       SET invoice_line_item_id = _li_id, updated_at = now()
     WHERE id = _a.id;
    _total := _total + _a.amount_cents;
  END LOOP;

  -- Everything we counted was claimed by a concurrent run before we could
  -- bill it: delete the empty shell instead of leaving a $0 open invoice.
  IF NOT EXISTS (
    SELECT 1 FROM public.invoice_line_items WHERE invoice_id = _invoice_id
  ) THEN
    DELETE FROM public.invoices WHERE id = _invoice_id;
    RETURN NULL;
  END IF;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) TO service_role;

-- run_billing_cycles: identical to 20260716220000 except each per-client
-- block now takes a transaction-scoped advisory lock, so two concurrent
-- engine runs (pg_cron + nightly worker hitting the same org) serialize per
-- client instead of both generating from the same unbilled snapshot.

CREATE OR REPLACE FUNCTION public.run_billing_cycles(_org_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c record;
  _period_start date;
  _through date;
  _invoice_id uuid;
  _generated integer := 0;
BEGIN
  FOR _c IN
    SELECT c.id AS client_id,
           c.billing_frequency,
           o.invoice_grace_days,
           x.oldest_billable
      FROM (
        SELECT b.client_id, MIN(b.item_on) AS oldest_billable
          FROM (
            SELECT v.client_id, v.organization_id, v.scheduled_on AS item_on
              FROM public.visits v
              JOIN public.subscriptions s ON s.id = v.subscription_id
              LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
             WHERE li.id IS NULL
               AND s.billing_cadence = 'postpaid'
               AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
            UNION ALL
            SELECT ac.client_id, ac.organization_id, ac.occurred_on
              FROM public.addon_charges ac
             WHERE ac.status = 'pending'
               AND public.client_default_billing_cadence(ac.client_id) = 'postpaid'
          ) b
         WHERE (_org_id IS NULL OR b.organization_id = _org_id)
         GROUP BY b.client_id
      ) x
      JOIN public.clients c ON c.id = x.client_id AND c.active = true
      JOIN public.organizations o ON o.id = c.organization_id
     WHERE o.auto_invoice_enabled = true
  LOOP
    -- Serialize per client across concurrent engine runs (pg_cron and the
    -- app-side nightly worker overlap by design). Held to end of transaction.
    PERFORM pg_advisory_xact_lock(hashtext('billing:' || _c.client_id::text));

    IF _c.billing_frequency = 'after_each_visit' THEN
      _through := current_date;
    ELSE
      _period_start := CASE _c.billing_frequency
        WHEN 'weekly'    THEN date_trunc('week', current_date)::date
        WHEN 'monthly'   THEN date_trunc('month', current_date)::date
        WHEN 'quarterly' THEN date_trunc('quarter', current_date)::date
        WHEN 'yearly'    THEN date_trunc('year', current_date)::date
      END;
      IF _period_start IS NULL OR _c.oldest_billable >= _period_start THEN
        CONTINUE; -- the oldest billable's cadence period has not ended yet
      END IF;
      _through := _period_start - 1;
    END IF;

    BEGIN
      _invoice_id := public.admin_generate_invoice_for_client(_c.client_id, _through);
      IF _invoice_id IS NOT NULL THEN
        UPDATE public.invoices
           SET send_after = current_date + COALESCE(_c.invoice_grace_days, 3)
         WHERE id = _invoice_id;
        _generated := _generated + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One client's failure must not block the rest of the run.
      RAISE WARNING 'run_billing_cycles: client % failed: %', _c.client_id, SQLERRM;
    END;
  END LOOP;

  RETURN _generated;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_billing_cycles(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_billing_cycles(uuid) TO service_role;

-- ── Finding 6: atomic offending_count increment ──────────────────────────────
-- Replaces the JS read-modify-write in logUnitIncident (two concurrent
-- incident logs could lose an increment).

CREATE OR REPLACE FUNCTION public.increment_unit_offense(_unit_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE _org uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.property_units WHERE id = _unit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Unit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE public.property_units
     SET offending_count = offending_count + 1
   WHERE id = _unit_id;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.increment_unit_offense(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.increment_unit_offense(uuid) TO authenticated, service_role;
