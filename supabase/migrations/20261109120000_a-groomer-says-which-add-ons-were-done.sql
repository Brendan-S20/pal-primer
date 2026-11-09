-- A groomer says which booked add-ons were done (#412).
--
-- A groom plan carries its add-ons (subscriptions.groom_addons, 20261024100300)
-- and visits_groom_plan_addons charges every one of them when the groom is
-- completed. That is right for the groom that went as booked and wrong for the
-- one that did not: the dog would not sit for teeth brushing, the client said
-- skip the de-shed today. Until now the groomer had no way to say so, so the
-- client was billed for it and the office found out from the complaint.
-- (The other direction, an add-on done on the day that was not booked, is
-- already the field add-on on My Day: create_addon_charge with source 'field'.)
--
-- 1. visits.groom_addons_not_done: the addon_service ids the groomer marked
--    not done on THIS visit. Empty, the default, means every booked add-on was
--    done, which is what every existing visit already means.
--
-- 2. set_groom_addon_done(visit, add-on, done): the one way the app writes it.
--    The groomer assigned to the visit (is_visit_tech) or the office
--    (can_write_org). Only an add-on that is on this groom's plan, and only
--    while the groom is still scheduled or in progress: once it is completed
--    the charge exists, and taking it off is the office voiding the charge
--    (void_addon_charge), not the groomer changing a list after the fact.
--    Returns the visit's list as it now stands.
--
-- 3. tg_visits_groom_plan_addons, restated from 20261024100300 with one added
--    line: an add-on on the not-done list is skipped. Everything else in the
--    body is as that file wrote it, and the REVOKE is restated with it.
--    The void trigger (20261024100500) is not touched: it voids what the
--    completion charged, and what was never charged is not there to void.
--
-- No new table, so no RLS or MFA policy. The column is on visits, whose
-- existing policies decide who may read it. A tech's direct UPDATE of the
-- column is possible where RLS already lets that tech update the visit, and
-- grants nothing the RPC does not: the same tech may mark the same add-on
-- not done through it.
--
-- Replays into an empty database: adds a column, replaces one trigger
-- function created by 20261024100300, creates one RPC. The check block
-- asserts only what this file establishes. Idempotent.

-- ── 1. What was not done ─────────────────────────────────────────────────

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS groom_addons_not_done uuid[] NOT NULL DEFAULT '{}'::uuid[];

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_groom_addons_not_done_is_short;
ALTER TABLE public.visits ADD CONSTRAINT visits_groom_addons_not_done_is_short
  CHECK (cardinality(groom_addons_not_done) <= 20);

COMMENT ON COLUMN public.visits.groom_addons_not_done IS
  'addon_services ids on this groom''s plan that the groomer marked not done. '
  'visits_groom_plan_addons skips them at completion. Written by set_groom_addon_done.';

-- ── 2. The groomer marks one ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_groom_addon_done(
  _visit_id uuid, _addon_service_id uuid, _done boolean
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _v record;
  _addons jsonb;
  _list uuid[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT v.id, v.organization_id, v.status, v.subscription_id, v.groom_addons_not_done
    INTO _v
    FROM public.visits v
   WHERE v.id = _visit_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  IF NOT (public.is_visit_tech(auth.uid(), _visit_id)
          OR public.can_write_org(auth.uid(), _v.organization_id)) THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _v.status NOT IN ('scheduled', 'in_progress') THEN
    RAISE EXCEPTION 'This groom is finished. Ask the office to take an add-on off the bill.';
  END IF;

  SELECT s.groom_addons INTO _addons
    FROM public.subscriptions s
   WHERE s.id = _v.subscription_id
     AND s.organization_id = _v.organization_id
     AND s.groom_duration_min IS NOT NULL;
  IF _addons IS NULL OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(_addons) e
     WHERE NULLIF(e.value->>'addon_service_id', '')::uuid = _addon_service_id
  ) THEN
    RAISE EXCEPTION 'That add-on is not on this groom.';
  END IF;

  IF _done THEN
    _list := array_remove(_v.groom_addons_not_done, _addon_service_id);
  ELSIF _addon_service_id = ANY(_v.groom_addons_not_done) THEN
    _list := _v.groom_addons_not_done;
  ELSE
    _list := array_append(_v.groom_addons_not_done, _addon_service_id);
  END IF;

  UPDATE public.visits SET groom_addons_not_done = _list WHERE id = _visit_id;
  RETURN _list;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_groom_addon_done(uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_groom_addon_done(uuid, uuid, boolean) TO authenticated;

-- ── 3. Completion charges only what was done ─────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_visits_groom_plan_addons()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _addons jsonb;
  _item jsonb;
  _svc record;
  _qty integer;
  _price integer;
  _amt integer;
  _charge_id uuid;
  _ledger_id uuid;
BEGIN
  SELECT s.groom_addons INTO _addons
    FROM public.subscriptions s
   WHERE s.id = NEW.subscription_id
     AND s.organization_id = NEW.organization_id
     AND s.groom_duration_min IS NOT NULL;
  IF _addons IS NULL OR jsonb_array_length(_addons) = 0 THEN
    RETURN NEW;
  END IF;

  FOR _item IN SELECT value FROM jsonb_array_elements(_addons) LOOP
    SELECT a.id, a.name, a.unit_price_cents INTO _svc
      FROM public.addon_services a
     WHERE a.id = NULLIF(_item->>'addon_service_id', '')::uuid
       AND a.organization_id = NEW.organization_id;
    CONTINUE WHEN NOT FOUND;
    -- The groomer marked it not done on this visit (set_groom_addon_done).
    CONTINUE WHEN _svc.id = ANY(COALESCE(NEW.groom_addons_not_done, '{}'::uuid[]));
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.addon_charges c
       WHERE c.visit_id = NEW.id
         AND c.addon_service_id = _svc.id
         AND c.note = 'Booked with the groom'
         AND c.status <> 'voided'
    );
    _qty := GREATEST(COALESCE((_item->>'quantity')::integer, 1), 1);
    _price := GREATEST(COALESCE((_item->>'unit_price_cents')::integer, _svc.unit_price_cents), 0);
    _amt := _price * _qty;

    INSERT INTO public.addon_charges(
      organization_id, client_id, property_id, addon_service_id, visit_id, description,
      unit_price_cents, quantity, amount_cents, occurred_on, source, note, created_by
    ) VALUES (
      NEW.organization_id, NEW.client_id, NEW.property_id, _svc.id, NEW.id,
      COALESCE(NULLIF(_item->>'name', ''), _svc.name),
      _price, _qty, _amt, NEW.scheduled_on, 'office', 'Booked with the groom', auth.uid()
    ) RETURNING id INTO _charge_id;

    -- The same prepaid handling create_addon_charge applies.
    IF public.client_default_billing_cadence(NEW.client_id) = 'prepaid' AND _amt > 0 THEN
      INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
      VALUES (NEW.organization_id, NEW.client_id, -_amt, 'addon_debit',
              'Add-on: ' || COALESCE(NULLIF(_item->>'name', ''), _svc.name))
      RETURNING id INTO _ledger_id;
      UPDATE public.addon_charges
         SET status = 'paid_from_credit', credit_ledger_id = _ledger_id, updated_at = now()
       WHERE id = _charge_id;
    END IF;
  END LOOP;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_groom_plan_addons() FROM PUBLIC, anon, authenticated;

-- ── Check: what this file establishes ────────────────────────────────────

DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits'
       AND column_name = 'groom_addons_not_done'
  ) THEN
    RAISE EXCEPTION 'visits.groom_addons_not_done is missing';
  END IF;
  IF has_function_privilege('anon', 'public.set_groom_addon_done(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call set_groom_addon_done';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_groom_addon_done(uuid, uuid, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot call set_groom_addon_done';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_visits_groom_plan_addons()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_visits_groom_plan_addons is callable by authenticated';
  END IF;
  IF position('groom_addons_not_done' IN (
       SELECT p.prosrc FROM pg_proc p
        WHERE p.oid = 'public.tg_visits_groom_plan_addons()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'tg_visits_groom_plan_addons does not read groom_addons_not_done';
  END IF;
END
$post$;
