-- ============================================================================
-- LIVE HOTFIX — run once in Lovable Cloud → Database → SQL editor.
--
-- WHY: The two migrations added tonight via git push were never applied to the
-- live database (Lovable does not auto-apply externally git-pushed migration
-- files). Live is missing has_permission (finding #1) AND the entire portal
-- auth schema (finding #4) — which is why /portal/{uuid} returns
-- "Invalid or expired portal link": the deployed code calls
-- portal_resolve_contact, which does not exist on live.
--
-- This is the two migration files concatenated in order. Fully idempotent
-- (safe to run more than once). Running it brings live in sync with the repo
-- and immediately restores the portal (now behind OTP auth).
--
-- Section A = 20260708200000  (finding #1 + #47: action-level permissions)
-- Section B = 20260708210000  (finding #4: portal authentication)
-- ============================================================================


-- ========================= SECTION A (finding #1 + #47) =====================
-- Action-level permission model (QA findings #1 + #47).
--
-- Adds a capability matrix (has_permission) mirroring src/lib/permissions.ts,
-- tightens RLS on financially sensitive tables, guards DNA fine/billing
-- columns with a trigger, and rebuilds the add-on RPCs with a capped,
-- visit-bound technician "field" path.
--
-- Written convergently (CREATE OR REPLACE / DROP POLICY IF EXISTS): safe to
-- apply regardless of minor drift. Verified against a schema-identical local
-- stack; live definitions were confirmed to match the repo on 2026-07-08.

-- ── 1. Capability matrix ────────────────────────────────────────────────────
-- Keep in sync with ROLE_PERMISSIONS in src/lib/permissions.ts.
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _org_id
      AND (
        ur.role = 'owner'
        OR (ur.role = 'office_manager' AND _permission NOT IN ('manage_org_billing', 'manage_franchise'))
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons'))
        OR (ur.role = 'tech' AND _permission = 'record_field_addons')
      )
  );
$$;
REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role;

-- ── 2. Org-configurable cap for field-billed add-ons (default $200) ─────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS field_addon_cap_cents integer NOT NULL DEFAULT 20000;

-- ── 3. Tightened RLS ─────────────────────────────────────────────────────────
-- Zones: dispatcher becomes read-only ("Members read zones" stays as-is).
DROP POLICY IF EXISTS "Managers write zones" ON public.zones;
DROP POLICY IF EXISTS "Pricing managers write zones" ON public.zones;
CREATE POLICY "Pricing managers write zones" ON public.zones
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_pricing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_pricing'));

-- Invoices: reads and writes are billing/finance-only (previously any member
-- could read and any dispatcher could write).
DROP POLICY IF EXISTS "invoices writable by managers" ON public.invoices;
DROP POLICY IF EXISTS "invoices writable by billing managers" ON public.invoices;
CREATE POLICY "invoices writable by billing managers" ON public.invoices
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));
DROP POLICY IF EXISTS "invoices readable by org members" ON public.invoices;
DROP POLICY IF EXISTS "invoices readable by billing and finance roles" ON public.invoices;
CREATE POLICY "invoices readable by billing and finance roles" ON public.invoices
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), organization_id, 'manage_client_billing')
    OR public.has_permission(auth.uid(), organization_id, 'view_financials')
  );

DROP POLICY IF EXISTS "line items writable via parent invoice" ON public.invoice_line_items;
DROP POLICY IF EXISTS "line items writable via parent invoice" ON public.invoice_line_items;
CREATE POLICY "line items writable via parent invoice" ON public.invoice_line_items
  FOR ALL TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_line_items.invoice_id
      AND public.has_permission(auth.uid(), i.organization_id, 'manage_client_billing')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_line_items.invoice_id
      AND public.has_permission(auth.uid(), i.organization_id, 'manage_client_billing')
  ));
DROP POLICY IF EXISTS "line items readable via parent invoice" ON public.invoice_line_items;
DROP POLICY IF EXISTS "line items readable via parent invoice" ON public.invoice_line_items;
CREATE POLICY "line items readable via parent invoice" ON public.invoice_line_items
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = invoice_line_items.invoice_id
      AND (
        public.has_permission(auth.uid(), i.organization_id, 'manage_client_billing')
        OR public.has_permission(auth.uid(), i.organization_id, 'view_financials')
      )
  ));

DROP POLICY IF EXISTS "payments writable by managers" ON public.payments;
DROP POLICY IF EXISTS "payments writable by billing managers" ON public.payments;
CREATE POLICY "payments writable by billing managers" ON public.payments
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));
DROP POLICY IF EXISTS "payments readable by org members" ON public.payments;
DROP POLICY IF EXISTS "payments readable by billing and finance roles" ON public.payments;
CREATE POLICY "payments readable by billing and finance roles" ON public.payments
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), organization_id, 'manage_client_billing')
    OR public.has_permission(auth.uid(), organization_id, 'view_financials')
  );

-- Credit ledger: system paths (complete_visit debits, Stripe webhooks) run as
-- SECURITY DEFINER / service_role and are unaffected by these policies.
DROP POLICY IF EXISTS "managers write ledger" ON public.credit_ledger;
DROP POLICY IF EXISTS "billing managers write ledger" ON public.credit_ledger;
CREATE POLICY "billing managers write ledger" ON public.credit_ledger
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));
DROP POLICY IF EXISTS "org members read ledger" ON public.credit_ledger;
DROP POLICY IF EXISTS "billing managers read ledger" ON public.credit_ledger;
CREATE POLICY "billing managers read ledger" ON public.credit_ledger
  FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));

-- Add-on charges/subscriptions: table access is billing-only; the technician
-- field path goes exclusively through the create_addon_charge RPC below.
DROP POLICY IF EXISTS "addon_charges writable by org staff" ON public.addon_charges;
DROP POLICY IF EXISTS "addon_charges writable by billing managers" ON public.addon_charges;
CREATE POLICY "addon_charges writable by billing managers" ON public.addon_charges
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));
DROP POLICY IF EXISTS "addon_charges readable by org" ON public.addon_charges;
DROP POLICY IF EXISTS "addon_charges readable by billing and finance roles" ON public.addon_charges;
CREATE POLICY "addon_charges readable by billing and finance roles" ON public.addon_charges
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), organization_id, 'manage_client_billing')
    OR public.has_permission(auth.uid(), organization_id, 'view_financials')
  );

DROP POLICY IF EXISTS "addon_subs writable by managers" ON public.addon_subscriptions;
DROP POLICY IF EXISTS "addon_subs writable by billing managers" ON public.addon_subscriptions;
CREATE POLICY "addon_subs writable by billing managers" ON public.addon_subscriptions
  FOR ALL TO authenticated
  USING (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'))
  WITH CHECK (public.has_permission(auth.uid(), organization_id, 'manage_client_billing'));

-- ── 4. DNA billing guard ─────────────────────────────────────────────────────
-- Field collection stays member-writable (techs log/ship samples), but fine
-- amounts and the billed transition are billing actions. RLS can't do
-- column-level checks, hence a trigger. auth.uid() IS NULL = service-role or
-- system job — allowed.
CREATE OR REPLACE FUNCTION public.tg_dna_matches_guard_billing()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN NEW; END IF;
  IF (NEW.fine_cents IS DISTINCT FROM OLD.fine_cents)
     OR (NEW.status = 'billed' AND OLD.status IS DISTINCT FROM 'billed') THEN
    IF NOT public.has_permission(auth.uid(), OLD.organization_id, 'manage_dna_billing') THEN
      RAISE EXCEPTION 'Setting fines or billing DNA samples requires office permissions';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS dna_matches_guard_billing ON public.dna_matches;
CREATE TRIGGER dna_matches_guard_billing
  BEFORE UPDATE ON public.dna_matches
  FOR EACH ROW EXECUTE FUNCTION public.tg_dna_matches_guard_billing();

-- Deleting a processed sample erases a billing record — same capability.
CREATE OR REPLACE FUNCTION public.tg_dna_matches_guard_delete()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RETURN OLD; END IF;
  IF OLD.status NOT IN ('new', 'sent_to_lab')
     AND NOT public.has_permission(auth.uid(), OLD.organization_id, 'manage_dna_billing') THEN
    RAISE EXCEPTION 'Deleting a processed DNA sample requires office permissions';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS dna_matches_guard_delete ON public.dna_matches;
CREATE TRIGGER dna_matches_guard_delete
  BEFORE DELETE ON public.dna_matches
  FOR EACH ROW EXECUTE FUNCTION public.tg_dna_matches_guard_delete();

-- ── 5. Add-on RPCs: capped, visit-bound field path ───────────────────────────
CREATE OR REPLACE FUNCTION public.create_addon_charge(
  _client_id uuid,
  _addon_service_id uuid,
  _quantity integer DEFAULT 1,
  _unit_price_cents integer DEFAULT NULL,
  _description text DEFAULT NULL,
  _visit_id uuid DEFAULT NULL,
  _source text DEFAULT 'office',
  _note text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _org uuid; _svc record; _price integer; _amt integer; _desc text;
  _charge_id uuid; _ledger_id uuid; _cadence text; _cap integer;
  _visit_client uuid; _visit_tech uuid; _visit_found boolean := false;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;

  SELECT * INTO _svc FROM public.addon_services WHERE id = _addon_service_id AND organization_id = _org;
  IF _svc IS NULL THEN RAISE EXCEPTION 'Add-on service not found'; END IF;

  IF _source = 'field' THEN
    -- Technician flow: confirmed in the UI, bound to the caller's own visit,
    -- always at catalog price, and capped per charge by the org setting.
    IF NOT public.has_permission(auth.uid(), _org, 'record_field_addons') THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
    IF _visit_id IS NULL THEN
      RAISE EXCEPTION 'Field add-ons must be billed from a visit';
    END IF;
    SELECT true, v.client_id, s.user_id INTO _visit_found, _visit_client, _visit_tech
      FROM public.visits v
      LEFT JOIN public.staff s ON s.id = v.assigned_staff_id
     WHERE v.id = _visit_id AND v.organization_id = _org;
    IF NOT _visit_found THEN RAISE EXCEPTION 'Visit not found'; END IF;
    IF _visit_client IS DISTINCT FROM _client_id THEN
      RAISE EXCEPTION 'Visit does not belong to this client';
    END IF;
    IF _visit_tech IS DISTINCT FROM auth.uid()
       AND NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN
      RAISE EXCEPTION 'Field add-ons can only be billed from your own visit';
    END IF;
    _price := _svc.unit_price_cents;  -- catalog price only, no override
    _amt := _price * GREATEST(_quantity, 1);
    SELECT COALESCE(field_addon_cap_cents, 20000) INTO _cap
      FROM public.organizations WHERE id = _org;
    IF _amt > _cap THEN
      RAISE EXCEPTION 'Field add-ons are capped at $% per charge — ask the office to bill this one',
        to_char(_cap / 100.0, 'FM999990.00');
    END IF;
  ELSE
    IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN
      RAISE EXCEPTION 'Not authorized';
    END IF;
    _price := COALESCE(_unit_price_cents, _svc.unit_price_cents);
    _amt := _price * GREATEST(_quantity, 1);
  END IF;

  _desc := COALESCE(_description, _svc.name);
  _cadence := public.client_default_billing_cadence(_client_id);

  INSERT INTO public.addon_charges(
    organization_id, client_id, addon_service_id, visit_id, description,
    unit_price_cents, quantity, amount_cents, source, note, created_by
  ) VALUES (
    _org, _client_id, _addon_service_id, _visit_id, _desc,
    _price, GREATEST(_quantity, 1), _amt, _source, _note, auth.uid()
  ) RETURNING id INTO _charge_id;

  IF _cadence = 'prepaid' AND _amt > 0 THEN
    INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
    VALUES (_org, _client_id, -_amt, 'addon_debit', 'Add-on: ' || _desc)
    RETURNING id INTO _ledger_id;

    UPDATE public.addon_charges
       SET status = 'paid_from_credit', credit_ledger_id = _ledger_id, updated_at = now()
     WHERE id = _charge_id;
  END IF;

  RETURN _charge_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.void_addon_charge(_charge_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE _c record;
BEGIN
  SELECT * INTO _c FROM public.addon_charges WHERE id = _charge_id;
  IF _c IS NULL THEN RAISE EXCEPTION 'Charge not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _c.organization_id, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _c.status = 'invoiced' THEN RAISE EXCEPTION 'Already invoiced - void the invoice instead'; END IF;
  IF _c.status = 'voided' THEN RETURN; END IF;

  IF _c.status = 'paid_from_credit' AND _c.credit_ledger_id IS NOT NULL THEN
    INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
    VALUES (_c.organization_id, _c.client_id, _c.amount_cents, 'refund', 'Void add-on: ' || _c.description);
  END IF;

  UPDATE public.addon_charges SET status='voided', updated_at=now() WHERE id=_charge_id;
END;
$$;

-- ── 6. Billing RPCs move from can_write_org (includes dispatcher) to
--       manage_client_billing. Routing/dispatch RPCs (assign/optimize/
--       reassign/reschedule/reorder/generate_visits) intentionally stay on
--       can_write_org — dispatching is that role's job. ─────────────────────
CREATE OR REPLACE FUNCTION public.apply_referral_code(_new_client_id uuid, _code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _reward int; _referrer uuid; _already timestamptz;
BEGIN
  SELECT organization_id, referral_applied_at INTO _org, _already FROM public.clients WHERE id = _new_client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _already IS NOT NULL THEN RAISE EXCEPTION 'Referral already applied for this client'; END IF;

  SELECT id FROM public.clients
   WHERE organization_id = _org AND lower(referral_code) = lower(trim(_code)) AND id <> _new_client_id
   INTO _referrer;
  IF _referrer IS NULL THEN RAISE EXCEPTION 'Referral code not found'; END IF;

  SELECT referral_reward_cents INTO _reward FROM public.organizations WHERE id = _org;
  IF _reward IS NULL OR _reward <= 0 THEN _reward := 0; END IF;

  UPDATE public.clients
     SET referred_by_client_id = _referrer,
         referral_applied_at = now(),
         updated_at = now()
   WHERE id = _new_client_id;

  IF _reward > 0 THEN
    PERFORM public.post_credit_entry(_org, _new_client_id, _reward, 'referral_bonus', NULL, NULL,
      'Welcome credit from referral code ' || upper(trim(_code)));
    PERFORM public.post_credit_entry(_org, _referrer, _reward, 'referral_reward', NULL, NULL,
      'Referral reward for new client');
  END IF;

  RETURN jsonb_build_object('referrer_id', _referrer, 'reward_cents', _reward);
END; $function$
;
CREATE OR REPLACE FUNCTION public.generate_addon_charges_through(_org_id uuid, _through date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _s record; _n integer := 0; _step interval; _next date; _charge_id uuid;
BEGIN
  IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;

  FOR _s IN
    SELECT * FROM public.addon_subscriptions
     WHERE organization_id = _org_id AND status = 'active' AND next_charge_on <= _through
  LOOP
    _step := CASE _s.frequency
      WHEN 'weekly' THEN interval '7 days'
      WHEN 'biweekly' THEN interval '14 days'
      WHEN 'monthly' THEN interval '1 month'
      WHEN 'quarterly' THEN interval '3 months'
      WHEN 'yearly' THEN interval '1 year'
    END;

    _next := _s.next_charge_on;
    WHILE _next <= _through LOOP
      INSERT INTO public.addon_charges(
        organization_id, client_id, addon_service_id, addon_subscription_id,
        description, unit_price_cents, quantity, amount_cents, occurred_on, source
      )
      SELECT _s.organization_id, _s.client_id, _s.addon_service_id, _s.id,
             svc.name, _s.price_cents, _s.quantity, _s.price_cents * _s.quantity, _next, 'recurring'
        FROM public.addon_services svc WHERE svc.id = _s.addon_service_id
      RETURNING id INTO _charge_id;

      IF public.client_default_billing_cadence(_s.client_id) = 'prepaid' THEN
        DECLARE _lid uuid; _amt integer;
        BEGIN
          SELECT amount_cents INTO _amt FROM public.addon_charges WHERE id = _charge_id;
          INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
          VALUES (_s.organization_id, _s.client_id, -_amt, 'addon_debit',
                  'Recurring add-on ' || _next::text)
          RETURNING id INTO _lid;
          UPDATE public.addon_charges
             SET status='paid_from_credit', credit_ledger_id=_lid, updated_at=now()
           WHERE id=_charge_id;
        END;
      END IF;

      _n := _n + 1;
      _next := (_next + _step)::date;
    END LOOP;

    UPDATE public.addon_subscriptions SET next_charge_on = _next, updated_at = now() WHERE id = _s.id;
  END LOOP;

  RETURN _n;
END; $function$
;
CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
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
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;

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
    RAISE EXCEPTION 'No unbilled items for this client through %', _through;
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
    INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, NULL,
      _a.description || ' (' || to_char(_a.occurred_on,'YYYY-MM-DD') || ')' ||
      CASE WHEN _a.quantity > 1 THEN ' x ' || _a.quantity ELSE '' END,
      _a.amount_cents)
    RETURNING id INTO _li_id;

    UPDATE public.addon_charges
       SET status = 'invoiced', invoice_line_item_id = _li_id, updated_at = now()
     WHERE id = _a.id;
    _total := _total + _a.amount_cents;
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.generate_invoices_for_org(_org_id uuid, _through date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _c record; _n integer := 0;
BEGIN
  IF NOT public.has_permission(auth.uid(), _org_id, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  FOR _c IN
    SELECT DISTINCT client_id FROM (
      SELECT v.client_id
        FROM public.visits v
        JOIN public.subscriptions s ON s.id = v.subscription_id
        LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
       WHERE v.organization_id = _org_id
         AND v.scheduled_on <= _through
         AND li.id IS NULL
         AND s.billing_cadence = 'postpaid'
         AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
      UNION
      SELECT ac.client_id
        FROM public.addon_charges ac
       WHERE ac.organization_id = _org_id
         AND ac.status = 'pending'
         AND ac.occurred_on <= _through
         AND public.client_default_billing_cadence(ac.client_id) = 'postpaid'
    ) x
  LOOP
    BEGIN
      PERFORM public.generate_invoice_for_client(_c.client_id, _through);
      _n := _n + 1;
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END LOOP;
  RETURN _n;
END; $function$
;
CREATE OR REPLACE FUNCTION public.generate_prepaid_invoice(_subscription_id uuid, _visit_count integer)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
  _invoice_id uuid; _v record; _total integer := 0;
  _min date; _max date; _n integer := 0;
BEGIN
  SELECT organization_id, client_id, billing_cadence, price_cents
    INTO _org, _client, _cadence, _price
    FROM public.subscriptions WHERE id = _subscription_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Subscription not found'; END IF;
  IF _cadence <> 'prepaid' THEN RAISE EXCEPTION 'Subscription is not prepaid'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF _visit_count IS NULL OR _visit_count < 1 THEN RAISE EXCEPTION 'visit_count must be >= 1'; END IF;

  INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at)
  VALUES (_org, _client, 'open', 'prepaid_topup', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id, v.scheduled_on
      FROM public.visits v
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.subscription_id = _subscription_id
       AND v.status = 'scheduled'
       AND li.id IS NULL
     ORDER BY v.scheduled_on
     LIMIT _visit_count
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, _v.id, _subscription_id,
            'Prepaid service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD'),
            COALESCE(_price, 0));
    _total := _total + COALESCE(_price, 0);
    _n := _n + 1;
    _min := LEAST(COALESCE(_min, _v.scheduled_on), _v.scheduled_on);
    _max := GREATEST(COALESCE(_max, _v.scheduled_on), _v.scheduled_on);
  END LOOP;

  IF _n = 0 THEN
    DELETE FROM public.invoices WHERE id = _invoice_id;
    RAISE EXCEPTION 'No upcoming scheduled visits to prepay';
  END IF;

  UPDATE public.invoices
     SET subtotal_cents = _total, total_cents = _total,
         period_start = _min, period_end = _max, updated_at = now()
   WHERE id = _invoice_id;

  RETURN _invoice_id;
END; $function$
;
CREATE OR REPLACE FUNCTION public.void_invoice(_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _status public.invoice_status;
BEGIN
  SELECT organization_id, status INTO _org, _status FROM public.invoices WHERE id = _invoice_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status = 'paid' THEN
    RAISE EXCEPTION 'Cannot void a paid invoice';
  END IF;
  UPDATE public.invoices
     SET status = 'void', voided_at = now(), updated_at = now()
   WHERE id = _invoice_id;
END;
$function$
;


-- ========================= SECTION B (finding #4) ===========================
-- Client portal authentication (QA finding #4).
--
-- Before: /portal/{uuid} was a bare, permanently-valid URL — anyone holding it
-- reached payment-method entry, autopay, invoices, and property/schedule
-- details with no auth. Every portal_* RPC was granted to `anon`, so the token
-- in the URL was the only gate.
--
-- After: the token identifies WHICH client the portal is for, but unlocking it
-- requires a one-time code sent to the phone/email on file, which mints a
-- short-lived (30-day) session. All portal_* RPCs are revoked from anon and
-- run only through the server (service_role) after a session check.
--
-- Paired rollback: supabase/rollback/20260708210000_portal-authentication.down.sql
-- Written convergently; safe to re-apply.

-- ── 1. Session + OTP tables ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.portal_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- SHA-256 of the opaque cookie value; the raw secret is never stored.
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip inet,
  user_agent text
);
CREATE INDEX IF NOT EXISTS portal_sessions_client_idx ON public.portal_sessions(client_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON public.portal_sessions(expires_at);
ALTER TABLE public.portal_sessions ENABLE ROW LEVEL SECURITY;
-- No policies: only service_role (bypasses RLS) touches this table. anon/authenticated get nothing.
GRANT ALL ON public.portal_sessions TO service_role;

CREATE TABLE IF NOT EXISTS public.portal_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('sms', 'email')),
  destination_hint text,           -- masked, e.g. "•••• 4821" — safe to show
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  request_ip inet
);
CREATE INDEX IF NOT EXISTS portal_otps_client_idx ON public.portal_otps(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_otps_ip_idx ON public.portal_otps(request_ip, created_at DESC);
ALTER TABLE public.portal_otps ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.portal_otps TO service_role;

-- ── 2. Revoke anon access to every portal_* RPC ──────────────────────────────
-- These were the entire attack surface: callable by anyone with the token.
-- The server now calls them via service_role after verifying a session.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'portal\_%'
  LOOP
    -- PUBLIC is critical: Postgres grants EXECUTE to PUBLIC by default on every
    -- function, and anon inherits through it. Revoking only anon leaves the
    -- hole open.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated;', r.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role;', r.sig);
  END LOOP;
END $$;

-- ── 3. Contact-on-file lookup for OTP delivery (service_role only) ───────────
-- Returns the real phone/email plus a masked hint. SECURITY DEFINER so the
-- server can resolve a token→contact without a broad grant; never exposed to anon.
CREATE OR REPLACE FUNCTION public.portal_resolve_contact(_token uuid)
RETURNS TABLE(client_id uuid, organization_id uuid, display_name text,
              primary_phone text, primary_email text, org_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id, c.organization_id, c.display_name, c.primary_phone, c.primary_email, o.name
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true
$$;
REVOKE ALL ON FUNCTION public.portal_resolve_contact(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_resolve_contact(uuid) TO service_role;

-- ── 4. Regenerate a client's portal token (invalidate the old link) ──────────
-- Owner/office action: rotates the token AND revokes every live session, so a
-- leaked link + any device it minted are both cut off at once.
CREATE OR REPLACE FUNCTION public.regenerate_portal_token(_client_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _new uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  -- Inline owner/office_manager check (equivalent to has_permission
  -- 'manage_settings') so this migration is self-contained and does not depend
  -- on the finding-#1 migration having been applied first.
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = auth.uid() AND organization_id = _org
       AND role IN ('owner', 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  _new := gen_random_uuid();
  UPDATE public.clients SET portal_token = _new WHERE id = _client_id;
  UPDATE public.portal_sessions
     SET revoked_at = now()
   WHERE client_id = _client_id AND revoked_at IS NULL;
  RETURN _new;
END;
$$;
REVOKE ALL ON FUNCTION public.regenerate_portal_token(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.regenerate_portal_token(uuid) TO authenticated, service_role;
