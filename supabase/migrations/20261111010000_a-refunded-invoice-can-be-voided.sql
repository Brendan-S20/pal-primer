-- A refunded invoice can be voided (#674).
--
-- #698 and #750 left a refunded invoice at `paid`, with `amount_paid_cents`
-- at 0 and `amount_refunded_cents` saying what went back, and offered no
-- Void: `void_invoice` refuses a paid invoice. On Nov 10 2026 the owner
-- decided "Allow Void after a refund". This adds the function that does it,
-- on these terms:
--
--   - Only an invoice refunded IN FULL: `amount_paid_cents` is 0 and
--     `amount_refunded_cents` is above 0. A partly refunded invoice is
--     refused with "refund the rest first", because voiding it would leave
--     money the business kept tied to an invoice that no longer exists.
--   - Record only. Nothing here touches Stripe, and the app half makes no
--     Stripe call either. `paid_at`, `amount_paid_cents` and
--     `amount_refunded_cents` are left exactly as they were, so the invoice
--     keeps saying it was paid, then refunded, then voided. Credit applied to
--     the invoice is not reversed: the refund already gave the money back.
--   - The visit lines are RELEASED, so the visit can be invoiced again
--     (#605, #859), once.
--
-- ── RELEASING A VISIT LINE ────────────────────────────────────────────────
--
-- `invoice_line_items_visit_unique` allows one line per visit, on any invoice,
-- void or not. The app reads a line on a void invoice as "unbilled"
-- (liveInvoiceFor), so after a void "Invoice this visit" offered the visit
-- and the insert then failed on the index; the completion path (#859) catches
-- that and reports "already invoiced". The line stays, because it is what the
-- voided invoice billed and because #859 counts the void invoices a visit has
-- been on to key the next one. What has to give is the index: it now ignores
-- a line whose `released_at` is set, and `void_refunded_invoice` sets it on
-- the visit lines it voids. One unreleased line per visit is still the rule,
-- so the second invoice succeeds and a third is refused by the same guard as
-- before. The billing run joins on `visit_id` and is unchanged: a released
-- line still keeps the run off the visit, so re-billing is the office's
-- choice, not the nightly job's.
--
-- Safe to run twice: the column is added IF NOT EXISTS, the index is only
-- rebuilt when its predicate does not already name released_at, and the
-- function is CREATE OR REPLACE.

ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS released_at timestamptz;

COMMENT ON COLUMN public.invoice_line_items.released_at IS
  'Set when the invoice was voided after a full refund (#674): the visit this line billed may be invoiced again. The line itself stays as the record of what the voided invoice billed.';

DO $index$
DECLARE _def text;
BEGIN
  SELECT indexdef INTO _def
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'invoice_line_items'
     AND indexname = 'invoice_line_items_visit_unique';
  IF _def IS NULL OR _def NOT LIKE '%released_at IS NULL%' THEN
    DROP INDEX IF EXISTS public.invoice_line_items_visit_unique;
    CREATE UNIQUE INDEX invoice_line_items_visit_unique ON public.invoice_line_items(visit_id)
      WHERE visit_id IS NOT NULL AND released_at IS NULL;
  END IF;
END
$index$;

CREATE OR REPLACE FUNCTION public.void_refunded_invoice(_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _status public.invoice_status;
  _paid integer;
  _refunded integer;
BEGIN
  -- Same key apply_credit_to_invoice and void_invoice take, so a void and a
  -- credit application on one invoice serialize.
  PERFORM pg_advisory_xact_lock(hashtext('credit-apply:' || _invoice_id::text));

  SELECT organization_id, status, COALESCE(amount_paid_cents, 0), COALESCE(amount_refunded_cents, 0)
    INTO _org, _status, _paid, _refunded
    FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF _org IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  -- The same permission void_invoice asks for: the roles that may void stay
  -- as they are (#863 makes them configurable).
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status = 'void' THEN
    RAISE EXCEPTION 'Invoice is already void';
  END IF;
  IF _status <> 'paid' THEN
    RAISE EXCEPTION 'Only a paid invoice that was refunded in full can be voided this way';
  END IF;
  IF _refunded <= 0 THEN
    RAISE EXCEPTION 'This invoice was not refunded. A paid invoice can be voided only after a full refund';
  END IF;
  IF _paid > 0 THEN
    RAISE EXCEPTION 'Refund the rest first. $% of this invoice is still kept',
      to_char(_paid / 100.0, 'FM9999999990.00');
  END IF;

  -- The visit this invoice billed may be invoiced again, once: see the index.
  UPDATE public.invoice_line_items
     SET released_at = now()
   WHERE invoice_id = _invoice_id
     AND visit_id IS NOT NULL
     AND released_at IS NULL;

  -- Status and the void date only. paid_at, amount_paid_cents,
  -- amount_refunded_cents and credit_applied_cents stay as they were.
  UPDATE public.invoices
     SET status = 'void',
         voided_at = now(),
         updated_at = now()
   WHERE id = _invoice_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.void_refunded_invoice(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_refunded_invoice(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.void_refunded_invoice(uuid) IS
  'Voids a paid invoice that was refunded in full (#674). Record only: no money moves, paid_at and the paid and refunded amounts stay, the visit lines are released so the visit can be invoiced again once.';

DO $post$
DECLARE _src text; _def text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_refunded_invoice';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'void_refunded_invoice was not created';
  END IF;
  IF _src NOT LIKE '%Refund the rest first%' THEN
    RAISE EXCEPTION 'void_refunded_invoice does not refuse a partly refunded invoice';
  END IF;
  IF _src LIKE '%amount_paid_cents =%' OR _src LIKE '%amount_refunded_cents =%' OR _src LIKE '%paid_at =%' THEN
    RAISE EXCEPTION 'void_refunded_invoice writes a column it must leave alone';
  END IF;
  SELECT indexdef INTO _def
    FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'invoice_line_items'
     AND indexname = 'invoice_line_items_visit_unique';
  IF _def IS NULL OR _def NOT LIKE '%UNIQUE%' OR _def NOT LIKE '%released_at IS NULL%' THEN
    RAISE EXCEPTION 'invoice_line_items_visit_unique does not ignore a released line: %', _def;
  END IF;
  IF has_function_privilege('anon', 'public.void_refunded_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call void_refunded_invoice';
  END IF;
END
$post$;
