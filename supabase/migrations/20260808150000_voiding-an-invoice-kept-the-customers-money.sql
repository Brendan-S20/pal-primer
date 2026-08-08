-- Voiding an invoice destroyed the credit that had been applied to it.
--
-- `apply_credit_to_invoice` does two things together: it posts a NEGATIVE
-- `credit_ledger` entry (the client's balance goes down) and it records the
-- amount on the invoice as `credit_applied_cents`. That pairing is the whole
-- accounting — the ledger says where the money went, the invoice says what it
-- paid for.
--
-- `void_invoice` flipped the status and left the ledger entry standing. The
-- invoice it pointed at no longer exists in any meaningful sense, so the
-- client's money had been debited against nothing, and there was no reversal
-- path anywhere in the product. A $200 invoice with $150 of prepaid credit
-- applied, then voided, is $150 of the customer's own money gone. The confirm
-- dialog said only "can't be undone", which was true in a way nobody reading
-- it would have understood.
--
-- Reach is narrower than it first looks, and worth stating precisely rather
-- than overselling: credit that covers an invoice IN FULL flips it to 'paid',
-- and this function already refuses to void a paid invoice. So the loss only
-- ever hit PARTIAL applications — a client with less credit than the invoice
-- total. That is the common case for anyone topping up, not an edge.
--
-- Nothing to repair: 0 invoices in the database are void with credit applied,
-- and 0 are open with credit applied. Checked before writing this.
--
-- ── THE REVERSAL ──────────────────────────────────────────────────────────
--
-- A positive `invoice_application` entry for the same amount, posted through
-- `post_credit_entry` so the balance trigger maintains the client balance the
-- same way it did on the way out. Same kind, opposite sign: the ledger reads
-- as a matched pair rather than as an unexplained adjustment, and the note
-- names the invoice so the pair can be found later.
--
-- `credit_applied_cents` goes to 0 in the same statement that sets the status.
-- Leaving it would mean the invoice still claimed to have consumed credit it
-- has now given back, and `apply_credit_to_invoice` computes what is open from
-- exactly that column.
--
-- The advisory lock is the same one `apply_credit_to_invoice` takes, keyed on
-- the same invoice id. Without it, an apply and a void racing on one invoice
-- can interleave between the balance read and the write, and the reversal
-- would be computed from a `credit_applied_cents` that is about to change.

DO $pre$
DECLARE _src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_invoice';

  IF _src IS NULL THEN
    RAISE EXCEPTION 'void_invoice does not exist';
  END IF;
  -- If it already reverses credit, someone got here first and this migration
  -- would silently replace their version with this one.
  IF _src LIKE '%credit_applied_cents%' THEN
    RAISE EXCEPTION 'void_invoice already references credit_applied_cents — read it before replacing it';
  END IF;
  -- The version this was written against. A body that no longer refuses paid
  -- invoices is a different function and the reasoning above may not hold.
  IF _src NOT LIKE '%Cannot void a paid invoice%' THEN
    RAISE EXCEPTION 'void_invoice is not the version this migration was written against';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.void_invoice(_invoice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _status public.invoice_status; _client uuid; _applied integer;
BEGIN
  -- Same key apply_credit_to_invoice uses, so the two serialize per invoice.
  PERFORM pg_advisory_xact_lock(hashtext('credit-apply:' || _invoice_id::text));

  SELECT organization_id, status, client_id, COALESCE(credit_applied_cents, 0)
    INTO _org, _status, _client, _applied
    FROM public.invoices WHERE id = _invoice_id FOR UPDATE;
  IF _org IS NULL THEN RAISE EXCEPTION 'Invoice not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status = 'paid' THEN
    RAISE EXCEPTION 'Cannot void a paid invoice';
  END IF;
  IF _status = 'void' THEN
    -- Voiding twice would post the reversal twice and hand back money that
    -- was already handed back. The status check has to come before the entry.
    RAISE EXCEPTION 'Invoice is already void';
  END IF;

  IF _applied > 0 AND _client IS NOT NULL THEN
    PERFORM public.post_credit_entry(
      _org, _client, _applied, 'invoice_application',
      _invoice_id, NULL,
      'Returned from voided invoice #' || left(_invoice_id::text, 8));
  END IF;

  UPDATE public.invoices
     SET status = 'void',
         credit_applied_cents = 0,
         voided_at = now(),
         updated_at = now()
   WHERE id = _invoice_id;
END;
$function$;

DO $post$
DECLARE _src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'void_invoice';
  IF _src NOT LIKE '%Returned from voided invoice%' THEN
    RAISE EXCEPTION 'the replacement did not take';
  END IF;
  IF _src NOT LIKE '%Invoice is already void%' THEN
    RAISE EXCEPTION 'the double-void guard is missing';
  END IF;
END
$post$;
