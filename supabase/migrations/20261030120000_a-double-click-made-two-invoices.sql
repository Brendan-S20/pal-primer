-- A double click made two invoices (#607).
--
-- The New invoice dialog called createManualInvoice once per click, and
-- nothing on the server could tell a second click, or a retry after the
-- first response was lost, from a new invoice. Each one took a number and
-- each one was emailed.
--
-- The dialog now mints one key each time it is opened and sends it with
-- every attempt. This file stores it on the invoice, makes it unique per
-- organization, and makes create_manual_invoice hand back the invoice that
-- key already made instead of making another.
--
-- A unique constraint and not only a lookup: two requests in flight at once
-- both find nothing, and only the constraint stops the second insert. The
-- loser's insert is undone inside its own block, so it takes no number, and
-- it returns the winner's id.
--
-- Every other path (the billing run, invoicing a visit or a quote) sends no
-- key. NULLs are distinct, so they are unaffected.
--
-- Replays into an empty database: one column, one constraint, one function,
-- and assertions about what this file establishes.

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS creation_key uuid;

COMMENT ON COLUMN public.invoices.creation_key IS
  'Minted once per New invoice dialog and sent with every attempt, so a double click or a retry returns this invoice instead of making another (#607).';

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_creation_key_unique UNIQUE (organization_id, creation_key);

CREATE OR REPLACE FUNCTION public.create_manual_invoice(_invoice jsonb, _lines jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _inv public.invoices%ROWTYPE;
  _id uuid;
  _line jsonb;
  _line_id uuid;
  _addon uuid;
  _other text;
  _constraint text;
BEGIN
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line.';
  END IF;

  _inv := jsonb_populate_record(NULL::public.invoices, _invoice);

  -- This key already made an invoice: that one is the answer.
  IF _inv.creation_key IS NOT NULL THEN
    SELECT id INTO _id FROM public.invoices
     WHERE organization_id = _inv.organization_id
       AND creation_key = _inv.creation_key;
    IF FOUND THEN
      RETURN _id;
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.invoices (
      organization_id, client_id, kind, status, subtotal_cents, tax_rate_bps,
      tax_cents, tax_label, total_cents, period_start, period_end, issued_at,
      due_on, notes, creation_key
    ) VALUES (
      _inv.organization_id, _inv.client_id, _inv.kind, _inv.status,
      _inv.subtotal_cents, _inv.tax_rate_bps, _inv.tax_cents, _inv.tax_label,
      _inv.total_cents, _inv.period_start, _inv.period_end, _inv.issued_at,
      _inv.due_on, _inv.notes, _inv.creation_key
    )
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    -- Another request with the same key committed first. This block's insert,
    -- and the number it took, are already undone.
    GET STACKED DIAGNOSTICS _constraint = CONSTRAINT_NAME;
    IF _constraint IS DISTINCT FROM 'invoices_creation_key_unique' THEN
      RAISE;
    END IF;
    SELECT id INTO _id FROM public.invoices
     WHERE organization_id = _inv.organization_id
       AND creation_key = _inv.creation_key;
    RETURN _id;
  END;

  FOR _line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    INSERT INTO public.invoice_line_items (
      invoice_id, description, amount_cents, quantity, unit_amount_cents, visit_id
    ) VALUES (
      _id,
      _line->>'description',
      (_line->>'amount_cents')::integer,
      COALESCE((_line->>'quantity')::numeric, 1),
      (_line->>'unit_amount_cents')::integer,
      (_line->>'visit_id')::uuid
    )
    RETURNING id INTO _line_id;

    -- One add-on, one line, claimed the way the billing run claims it: only
    -- while it is still pending, so the run and this invoice cannot both
    -- bill it.
    _addon := (_line->>'addon_charge_id')::uuid;
    IF _addon IS NOT NULL THEN
      UPDATE public.addon_charges
         SET status = 'invoiced', invoice_line_item_id = _line_id, updated_at = now()
       WHERE id = _addon
         AND client_id = _inv.client_id
         AND status = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'An add-on on this invoice has already been billed.';
      END IF;
    END IF;
  END LOOP;

  -- The billing run could have reached one of these visits between the app's
  -- check and this insert.
  -- Labelled the way invoiceNumberLabel labels it.
  SELECT COALESCE('INV-' || i.number, '#' || left(i.id::text, 8)) INTO _other
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE li.visit_id IN (
           SELECT (l->>'visit_id')::uuid FROM jsonb_array_elements(_lines) l
            WHERE l->>'visit_id' IS NOT NULL)
     AND i.id <> _id
     AND i.status <> 'void'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'A visit on this invoice was just billed on invoice %.', _other;
  END IF;

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_manual_invoice(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_invoice(jsonb, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_manual_invoice(jsonb, jsonb) IS
  'A hand-made invoice, its lines and its add-on claims in one transaction, so a failed save takes no invoice number (#606). A creation_key that already made an invoice returns that invoice (#607). Runs as the caller.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'invoices_creation_key_unique'
       AND conrelid = 'public.invoices'::regclass
       AND contype = 'u'
  ) THEN
    RAISE EXCEPTION 'invoices.creation_key is not unique per organization';
  END IF;
  IF (SELECT prosecdef FROM pg_proc
       WHERE oid = 'public.create_manual_invoice(jsonb, jsonb)'::regprocedure) THEN
    RAISE EXCEPTION 'create_manual_invoice must run as the caller, under their row level security';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.create_manual_invoice(jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot call create_manual_invoice';
  END IF;
  IF has_function_privilege('anon', 'public.create_manual_invoice(jsonb, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call create_manual_invoice';
  END IF;
END
$check$;
