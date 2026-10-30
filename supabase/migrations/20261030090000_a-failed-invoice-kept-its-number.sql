-- A failed manual invoice kept its number (#606).
--
-- insertManualInvoice wrote the invoice, then its lines, then claimed each
-- add-on, as separate requests. invoices_assign_number() takes the number
-- from the org's counter on INSERT, and that request committed on its own.
-- When a line failed, the code deleted the invoice, but the counter had
-- already moved: every failed save skipped a number (INV-1041, then 1043).
--
-- The line that failed most was a mix of "Full groom x1" and "Add-on x2":
-- one bulk insert of rows with different keys, which PostgREST sends with
-- the union of the columns and NULL where a row had none, so the x1 row
-- wrote quantity NULL into a NOT NULL column. The app now sends quantity on
-- every row; this function also defaults it to 1.
--
-- create_manual_invoice writes the invoice, every line, every add-on claim
-- and the "visit already billed elsewhere" check in one transaction. If any
-- of it raises, all of it rolls back, the counter update with it, so a failed
-- save uses no number.
--
-- SECURITY INVOKER: the caller's own RLS applies to every row, exactly as it
-- did when the same rows went through PostgREST one request at a time.
--
-- Replays into an empty database: one function, its grants, and a check of
-- what this file creates.

CREATE OR REPLACE FUNCTION public.create_manual_invoice(_invoice jsonb, _lines jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_inv public.invoices%ROWTYPE;
  v_id uuid;
  v_line jsonb;
  v_li public.invoice_line_items%ROWTYPE;
  v_line_id uuid;
  v_addon uuid;
  v_visits uuid[] := '{}';
  v_other integer;
BEGIN
  IF jsonb_typeof(_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'An invoice needs at least one line.';
  END IF;

  v_inv := jsonb_populate_record(NULL::public.invoices, _invoice);
  -- The number comes from invoices_assign_number(), whatever is sent.
  INSERT INTO public.invoices (
    organization_id, client_id, kind, status, subtotal_cents, tax_rate_bps,
    tax_cents, tax_label, total_cents, period_start, period_end, issued_at,
    due_on, notes
  ) VALUES (
    v_inv.organization_id, v_inv.client_id, v_inv.kind, v_inv.status,
    v_inv.subtotal_cents, v_inv.tax_rate_bps, v_inv.tax_cents, v_inv.tax_label,
    v_inv.total_cents, v_inv.period_start, v_inv.period_end, v_inv.issued_at,
    v_inv.due_on, v_inv.notes
  )
  RETURNING id INTO v_id;

  FOR v_line IN SELECT value FROM jsonb_array_elements(_lines) WITH ORDINALITY ORDER BY ordinality
  LOOP
    v_li := jsonb_populate_record(NULL::public.invoice_line_items, v_line);
    INSERT INTO public.invoice_line_items (
      invoice_id, description, amount_cents, visit_id, quantity, unit_amount_cents
    ) VALUES (
      v_id, v_li.description, v_li.amount_cents, v_li.visit_id,
      COALESCE(v_li.quantity, 1), v_li.unit_amount_cents
    )
    RETURNING id INTO v_line_id;

    IF v_li.visit_id IS NOT NULL THEN
      v_visits := v_visits || v_li.visit_id;
    END IF;

    -- One add-on, one line, claimed the way the billing run claims it: only
    -- while it is still pending, so the run and this invoice cannot both bill it.
    v_addon := NULLIF(v_line->>'addon_charge_id', '')::uuid;
    IF v_addon IS NOT NULL THEN
      UPDATE public.addon_charges
         SET status = 'invoiced', invoice_line_item_id = v_line_id, updated_at = now()
       WHERE id = v_addon
         AND client_id = v_inv.client_id
         AND status = 'pending';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'An add-on on this invoice has already been billed.';
      END IF;
    END IF;
  END LOOP;

  -- The billing run could have reached the same visit between the app's
  -- check and this insert.
  IF array_length(v_visits, 1) > 0 THEN
    SELECT i.number INTO v_other
      FROM public.invoice_line_items li
      JOIN public.invoices i ON i.id = li.invoice_id
     WHERE li.visit_id = ANY (v_visits)
       AND i.id <> v_id
       AND i.status <> 'void'
     LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'A visit on this invoice was just billed on invoice INV-%.', v_other;
    END IF;
  END IF;

  RETURN v_id;
END
$fn$;

REVOKE ALL ON FUNCTION public.create_manual_invoice(jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_manual_invoice(jsonb, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_manual_invoice(jsonb, jsonb) IS
  'A hand-made invoice, its lines and its add-on claims in one transaction, so a failed save takes no invoice number. SECURITY INVOKER: the caller''s RLS applies.';

DO $check$
DECLARE
  v_fn oid := 'public.create_manual_invoice(jsonb, jsonb)'::regprocedure;
BEGIN
  IF (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'create_manual_invoice must be SECURITY INVOKER';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute create_manual_invoice';
  END IF;
  IF NOT has_function_privilege('authenticated', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute create_manual_invoice';
  END IF;
END
$check$;
