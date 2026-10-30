-- A failed manual invoice kept its number (#606).
--
-- insertManualInvoice wrote the invoice, then its lines, then claimed its
-- add-ons, each as its own request. The invoice's number is taken from the
-- organization's counter by invoices_assign_number() the moment the invoice
-- row is inserted, so when a later step failed the code deleted the invoice
-- but the counter had already moved: every failed save skipped a number
-- (INV-1041, then INV-1043), which is the gap an accountant asks about.
--
-- The failure that made this common was a NOT NULL on
-- invoice_line_items.quantity. The lines went in as one bulk insert, and a
-- bulk insert writes every column any row names; a row that did not name
-- quantity got NULL rather than the default 1. So "Full groom x1 + Add-on x2"
-- failed every time. The app now sends quantity on every row, and this file
-- makes the whole save one transaction so that any failure, that one or the
-- next, hands the number back.
--
-- create_manual_invoice(_invoice, _lines) inserts the invoice, every line,
-- and claims every add-on, then checks no visit on it was billed elsewhere in
-- the meantime. Any RAISE rolls back the invoice, its lines, the add-on claims
-- and the counter together.
--
-- SECURITY INVOKER: the caller's own row level security decides what it may
-- write, exactly as it did for the separate requests this replaces. Only the
-- counter is written past RLS, by the existing SECURITY DEFINER trigger.
--
-- Replays into an empty database: one function, its grants, and assertions
-- about what this file establishes.

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
  _other integer;
BEGIN
  IF jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line.';
  END IF;

  _inv := jsonb_populate_record(NULL::public.invoices, _invoice);

  INSERT INTO public.invoices (
    organization_id, client_id, kind, status, subtotal_cents, tax_rate_bps,
    tax_cents, tax_label, total_cents, period_start, period_end, issued_at,
    due_on, notes
  ) VALUES (
    _inv.organization_id, _inv.client_id, _inv.kind, _inv.status,
    _inv.subtotal_cents, _inv.tax_rate_bps, _inv.tax_cents, _inv.tax_label,
    _inv.total_cents, _inv.period_start, _inv.period_end, _inv.issued_at,
    _inv.due_on, _inv.notes
  )
  RETURNING id INTO _id;

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
  SELECT i.number INTO _other
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE li.visit_id IN (
           SELECT (l->>'visit_id')::uuid FROM jsonb_array_elements(_lines) l
            WHERE l->>'visit_id' IS NOT NULL)
     AND i.id <> _id
     AND i.status <> 'void'
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'A visit on this invoice was just billed on invoice INV-%.', _other;
  END IF;

  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.create_manual_invoice(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_invoice(jsonb, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_manual_invoice(jsonb, jsonb) IS
  'A hand-made invoice, its lines and its add-on claims in one transaction, so a failed save takes no invoice number. Runs as the caller (#606).';

DO $check$
BEGIN
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
