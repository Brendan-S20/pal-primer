-- Visit reopen and missed are billing safe.
--
-- A completed visit may already have money attached to it in one of two ways:
-- a postpaid or prepaid invoice line item, or a prepaid visit_debit ledger
-- entry. Changing the status after either exists would leave billing history
-- saying the work was billable while the visit says it was not. So the office
-- actions below refuse those rows with a message that names the fix.
--
-- If no billing row exists, invoice generation already does the right thing:
-- it selects visits whose status is completed, or skipped with skip_billable,
-- and have no invoice_line_items row. Reopening or marking missed changes the
-- status away from completed, so the next run will not pick the visit up.

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

REVOKE ALL ON FUNCTION public.visit_completion_billing_blocker(uuid) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.office_reopen_visit(_visit_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _started timestamptz;
  _blocker text;
BEGIN
  SELECT organization_id, status, started_at
    INTO _org, _status, _started
    FROM public.visits
   WHERE id = _visit_id;

  IF _org IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed visits can be reopened';
  END IF;

  _blocker := public.visit_completion_billing_blocker(_visit_id);
  IF _blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', _blocker;
  END IF;

  UPDATE public.visits
     SET status = CASE WHEN _started IS NULL THEN 'scheduled'::public.visit_status ELSE 'in_progress'::public.visit_status END,
         completed_at = NULL,
         completion_source = NULL,
         completion_photo_waived_reason = NULL,
         visit_checklist = NULL,
         price_cents = NULL,
         updated_at = now()
   WHERE id = _visit_id
     AND status = 'completed';
END;
$function$;

CREATE OR REPLACE FUNCTION public.office_mark_visit_missed(_visit_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _blocker text;
BEGIN
  SELECT organization_id, status
    INTO _org, _status
    FROM public.visits
   WHERE id = _visit_id;

  IF _org IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status <> 'completed' THEN
    RAISE EXCEPTION 'Only completed visits can be marked missed';
  END IF;

  _blocker := public.visit_completion_billing_blocker(_visit_id);
  IF _blocker IS NOT NULL THEN
    RAISE EXCEPTION '%', _blocker;
  END IF;

  UPDATE public.visits
     SET status = 'missed',
         started_at = NULL,
         completed_at = NULL,
         completion_source = NULL,
         completion_photo_waived_reason = NULL,
         visit_checklist = NULL,
         price_cents = NULL,
         updated_at = now()
   WHERE id = _visit_id
     AND status = 'completed';
END;
$function$;

REVOKE ALL ON FUNCTION public.office_reopen_visit(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_mark_visit_missed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_reopen_visit(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_mark_visit_missed(uuid) TO authenticated;

DO $verify$
DECLARE
  _src text;
BEGIN
  SELECT pg_get_functiondef('public.office_reopen_visit(uuid)'::regprocedure) INTO _src;
  IF _src NOT LIKE '%visit_completion_billing_blocker%' OR _src NOT LIKE '%price_cents = NULL%' THEN
    RAISE EXCEPTION 'office_reopen_visit is missing the billing guard or completion cleanup';
  END IF;

  SELECT pg_get_functiondef('public.office_mark_visit_missed(uuid)'::regprocedure) INTO _src;
  IF _src NOT LIKE '%visit_completion_billing_blocker%' OR _src NOT LIKE '%status = ''missed''%' THEN
    RAISE EXCEPTION 'office_mark_visit_missed is missing the billing guard or missed status write';
  END IF;
END
$verify$;
