-- A groom that leaves completed stops billing the add-ons its completion
-- charged. Follows 20261023130000.
--
-- visits_groom_plan_addons (20261024100300) charges a groom plan's add-ons
-- when the visit becomes completed, as addon_charges rows noted 'Booked with
-- the groom'. office_mark_visit_missed runs on a completed visit, so a groom
-- marked missed after it was done kept those charges and the client was
-- billed for teeth brushing on a groom that did not happen. The same held for
-- a completed groom reopened to scheduled, skipped or canceled.
--
-- 1. visits_groom_plan_addons_void: when a visit leaves completed, each of
--    its 'Booked with the groom' charges is undone the way void_addon_charge
--    undoes one:
--      pending           voided
--      paid_from_credit  voided, and the debit is handed back to the client's
--                        credit as a 'refund' entry (void_addon_charge's
--                        credit pattern)
--      invoiced          left alone. It is a line on an invoice, and
--                        void_addon_charge refuses those ("void the invoice
--                        instead"). Section 2 stops the office getting here.
--    Completing the groom again charges it again (the charge trigger skips
--    only charges that are not voided), so there is still one live charge
--    per add-on.
--
-- 2. visit_completion_billing_blocker also refuses a status change while one
--    of the visit's add-on charges is on an invoice that is not void, with
--    the sentence it already uses for the visit's own line. That is what
--    this code already does for a billed visit: the office voids or removes
--    the invoice line first (and, for a paid invoice, refunds the client),
--    then changes the visit. Every office path that takes a visit out of
--    completed asks this function (office_mark_visit_missed, the reopen in
--    20261012140000, the training cancel in 20261023130000).
--
-- Replays into an empty database: two functions replaced or created and one
-- trigger. The check block asserts only what this file creates.

-- ── 1. Leaving completed voids the completion's add-on charges ───────────

CREATE OR REPLACE FUNCTION public.tg_visits_groom_plan_addons_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _c record;
BEGIN
  FOR _c IN
    SELECT c.id, c.status, c.amount_cents, c.credit_ledger_id, c.description
      FROM public.addon_charges c
     WHERE c.visit_id = NEW.id
       AND c.organization_id = NEW.organization_id
       AND c.note = 'Booked with the groom'
       AND c.status IN ('pending', 'paid_from_credit')
     FOR UPDATE
  LOOP
    IF _c.status = 'paid_from_credit' AND _c.credit_ledger_id IS NOT NULL AND _c.amount_cents > 0 THEN
      INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
      VALUES (NEW.organization_id, NEW.client_id, _c.amount_cents, 'refund',
              'Void add-on: ' || _c.description);
    END IF;
    UPDATE public.addon_charges SET status = 'voided', updated_at = now() WHERE id = _c.id;
  END LOOP;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_groom_plan_addons_void() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_groom_plan_addons_void ON public.visits;
CREATE TRIGGER visits_groom_plan_addons_void
  AFTER UPDATE OF status ON public.visits
  FOR EACH ROW
  WHEN (OLD.status = 'completed' AND NEW.status IS DISTINCT FROM OLD.status)
  EXECUTE FUNCTION public.tg_visits_groom_plan_addons_void();

-- ── 2. An invoiced add-on blocks the status change, like an invoiced visit ─

CREATE OR REPLACE FUNCTION public.visit_completion_billing_blocker(_visit_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _invoice text;
BEGIN
  SELECT COALESCE(i.number::text, left(i.id::text, 8))
    INTO _invoice
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE li.visit_id = _visit_id
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF _invoice IS NOT NULL THEN
    RETURN 'This visit is already on invoice ' || _invoice ||
      '. Void or remove that invoice line before changing the visit status.';
  END IF;

  -- An add-on charged with this visit (a groom's 'Booked with the groom'
  -- charges) that is on a live invoice.
  SELECT COALESCE(i.number::text, left(i.id::text, 8))
    INTO _invoice
    FROM public.addon_charges c
    JOIN public.invoice_line_items li ON li.id = c.invoice_line_item_id
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE c.visit_id = _visit_id
     AND c.status = 'invoiced'
     AND i.status <> 'void'
   ORDER BY i.created_at DESC
   LIMIT 1;

  IF _invoice IS NOT NULL THEN
    RETURN 'An add-on on this visit is already on invoice ' || _invoice ||
      '. Void or remove that invoice line before changing the visit status.';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.credit_ledger cl
     WHERE cl.visit_id = _visit_id
       AND cl.kind = 'visit_debit'
  ) THEN
    RETURN 'This prepaid visit has already debited the client credit balance. Reverse that billing entry before changing the visit status.';
  END IF;

  RETURN NULL;
END;
$function$;

-- As 20261012140000 left it: never callable with the publishable key.
REVOKE ALL ON FUNCTION public.visit_completion_billing_blocker(uuid) FROM PUBLIC, anon;

-- ── What this file establishes, checked from any starting state ──────────

DO $check$
DECLARE _src text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.visits'::regclass AND tgname = 'visits_groom_plan_addons_void'
       AND tgenabled = 'O' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'visits_groom_plan_addons_void is missing or disabled';
  END IF;
  IF has_function_privilege('anon', 'public.tg_visits_groom_plan_addons_void()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_visits_groom_plan_addons_void()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_visits_groom_plan_addons_void is callable with a client key';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.visit_completion_billing_blocker(uuid)'::regprocedure;
  IF _src IS NULL OR strpos(_src, 'FROM public.addon_charges c') = 0 THEN
    RAISE EXCEPTION 'visit_completion_billing_blocker does not check the visit''s invoiced add-ons';
  END IF;
  IF has_function_privilege('anon', 'public.visit_completion_billing_blocker(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'visit_completion_billing_blocker is callable with the publishable key';
  END IF;
END
$check$;
