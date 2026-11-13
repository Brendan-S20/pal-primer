-- #908: a refund amount can arrive before the payment status changes.
-- Count the amount kept in either settled state, as the dated AR reader does.
BEGIN;

CREATE OR REPLACE FUNCTION public.invoice_paid_cents(_invoice_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT GREATEST(COALESCE(sum(
           CASE
             -- Older refunded payments without an amount were reversed whole.
             WHEN p.status = 'refunded' AND COALESCE(p.refunded_cents, 0) = 0 THEN 0
             ELSE GREATEST(p.amount_cents - COALESCE(p.refunded_cents, 0), 0)
           END), 0), 0)::integer
    FROM public.payments p
   WHERE (p.invoice_id = _invoice_id
          OR p.invoice_id IN (SELECT d.id FROM public.invoices d
                               WHERE d.deposit_for_invoice_id = _invoice_id))
     AND p.status IN ('succeeded', 'refunded');
$function$;

REVOKE ALL ON FUNCTION public.invoice_paid_cents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.invoice_paid_cents(uuid) TO service_role;

-- Repair only the affected invoice caches and any linked stay's cache.
-- Keep updated_at: AR uses it as the write-off date of an uncollectible bill.
DO $repair$
DECLARE
  _invoice_id uuid;
  _touch_mode "char";
BEGIN
  SELECT tgenabled INTO _touch_mode
    FROM pg_trigger
   WHERE tgrelid = 'public.invoices'::regclass AND tgname = 'touch_invoices';
  IF _touch_mode IS NULL THEN
    RAISE EXCEPTION 'Expected invoices.touch_invoices before repairing paid amounts';
  END IF;
  ALTER TABLE public.invoices DISABLE TRIGGER touch_invoices;

  FOR _invoice_id IN
    SELECT p.invoice_id FROM public.payments p
     WHERE p.status = 'succeeded' AND p.refunded_cents > 0 AND p.invoice_id IS NOT NULL
    UNION
    SELECT d.deposit_for_invoice_id
      FROM public.payments p JOIN public.invoices d ON d.id = p.invoice_id
     WHERE p.status = 'succeeded' AND p.refunded_cents > 0
       AND d.deposit_for_invoice_id IS NOT NULL
  LOOP
    PERFORM public.sync_invoice_amount_paid(_invoice_id);
  END LOOP;

  CASE _touch_mode
    WHEN 'O' THEN ALTER TABLE public.invoices ENABLE TRIGGER touch_invoices;
    WHEN 'A' THEN ALTER TABLE public.invoices ENABLE ALWAYS TRIGGER touch_invoices;
    WHEN 'R' THEN ALTER TABLE public.invoices ENABLE REPLICA TRIGGER touch_invoices;
    ELSE NULL;
  END CASE;
END;
$repair$;

COMMIT;
