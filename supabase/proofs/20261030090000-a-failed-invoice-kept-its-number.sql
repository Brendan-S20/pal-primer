-- Proof for #606: a manual invoice is saved whole or not at all, so a failed
-- save takes no invoice number.
--
-- create_manual_invoice (20261030090000) inserts the invoice, its lines and its
-- add-on claims in one transaction. The invoice's number is taken from the
-- org's counter when the invoice row goes in, so it is the transaction that
-- hands the number back when a later step fails.
--
--   1. "Full groom x1 + Add-on x2" saves, $85.00, with the counter's number.
--   2. A save that fails on a line moves no counter and leaves no invoice.
--   3. A save that fails on an add-on claim moves no counter and leaves the
--      add-on it claimed first pending.
--   4. The next good save takes the very next number.
--   5. Mutation: the sequence this replaced (insert the invoice, a line fails,
--      delete the invoice) DOES move the counter. If it does not, the checks
--      above prove nothing and this raises INCONCLUSIVE.
--
-- Everything is inside one transaction that ends in ROLLBACK. Run against a
-- freshly reset local database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261030090000-a-failed-invoice-kept-its-number.sql

\set ON_ERROR_STOP on
SET client_min_messages TO notice;
BEGIN;

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a606000-0000-4000-8000-0000000000aa', 'Invoice Number Proof', 'UTC');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6060000-0000-4000-8000-0000000000a1', '0a606000-0000-4000-8000-0000000000aa', 'residential', 'Number Proof Client');
INSERT INTO public.addon_charges (id, organization_id, client_id, description, unit_price_cents, amount_cents, status) VALUES
  ('ad606000-0000-4000-8000-0000000000a1', '0a606000-0000-4000-8000-0000000000aa',
   'c6060000-0000-4000-8000-0000000000a1', 'Nail trim', 1500, 1500, 'pending'),
  ('ad606000-0000-4000-8000-0000000000a2', '0a606000-0000-4000-8000-0000000000aa',
   'c6060000-0000-4000-8000-0000000000a1', 'Teeth', 900, 900, 'invoiced');

CREATE TEMP TABLE proof_inv (k text PRIMARY KEY, v jsonb);
INSERT INTO proof_inv VALUES ('head', jsonb_build_object(
  'organization_id', '0a606000-0000-4000-8000-0000000000aa',
  'client_id', 'c6060000-0000-4000-8000-0000000000a1',
  'kind', 'postpaid', 'status', 'open',
  'subtotal_cents', 8500, 'tax_rate_bps', 0, 'tax_cents', 0, 'tax_label', 'Sales tax',
  'total_cents', 8500, 'period_start', current_date, 'period_end', current_date,
  'issued_at', now(), 'due_on', current_date + 15, 'notes', 'Manual invoice'));

-- ── Full groom x1 + Add-on x2 saves, with the right total ──────────────────
DO $$
DECLARE _before int; _id uuid; _n int; _lines int; _sum int; _qty numeric[];
BEGIN
  SELECT next_invoice_number INTO _before FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa';
  _id := public.create_manual_invoice(
    (SELECT v FROM proof_inv WHERE k = 'head'),
    '[{"description":"Full groom","amount_cents":6500,"quantity":1,"unit_amount_cents":null,"visit_id":null,"addon_charge_id":null},
      {"description":"Add-on","amount_cents":2000,"quantity":2,"unit_amount_cents":1000,"visit_id":null,"addon_charge_id":null}]'::jsonb);
  SELECT number INTO _n FROM public.invoices WHERE id = _id;
  SELECT count(*), sum(amount_cents), array_agg(quantity ORDER BY quantity)
    INTO _lines, _sum, _qty FROM public.invoice_line_items WHERE invoice_id = _id;
  IF _lines <> 2 OR _sum <> 8500 OR _qty <> ARRAY[1, 2]::numeric[] THEN
    RAISE EXCEPTION 'PROOF FAILED [mixed]: % lines, % cents, quantities %', _lines, _sum, _qty;
  END IF;
  IF (SELECT total_cents FROM public.invoices WHERE id = _id) <> 8500 THEN
    RAISE EXCEPTION 'PROOF FAILED [mixed]: the invoice total is not 8500';
  END IF;
  IF _n <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [mixed]: took number % when the counter was at %', _n, _before;
  END IF;
  RAISE NOTICE 'ok: a qty-1 line beside a qty-2 line saves, for $85.00, as INV-%', _n;
END $$;

-- ── A save that fails on a line takes no number ────────────────────────────
DO $$
DECLARE _before int; _invoices int;
BEGIN
  SELECT next_invoice_number INTO _before FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa';
  SELECT count(*) INTO _invoices FROM public.invoices WHERE client_id = 'c6060000-0000-4000-8000-0000000000a1';
  BEGIN
    -- 3 x $10 does not total $50: the line's own CHECK refuses it.
    PERFORM public.create_manual_invoice(
      (SELECT v FROM proof_inv WHERE k = 'head'),
      '[{"description":"Full groom","amount_cents":6500},
        {"description":"Bad line","amount_cents":5000,"quantity":3,"unit_amount_cents":1000}]'::jsonb);
    RAISE EXCEPTION 'PROOF FAILED [line]: a line that does not add up was saved';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF (SELECT next_invoice_number FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa') <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [line]: the failed save moved the counter';
  END IF;
  IF (SELECT count(*) FROM public.invoices WHERE client_id = 'c6060000-0000-4000-8000-0000000000a1') <> _invoices THEN
    RAISE EXCEPTION 'PROOF FAILED [line]: the failed save left an invoice behind';
  END IF;
  RAISE NOTICE 'ok: a save that fails on a line leaves the counter and the invoices as they were';
END $$;

-- ── A save that fails on an add-on takes no number, and hands back the claim
DO $$
DECLARE _before int;
BEGIN
  SELECT next_invoice_number INTO _before FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa';
  BEGIN
    PERFORM public.create_manual_invoice(
      (SELECT v FROM proof_inv WHERE k = 'head'),
      '[{"description":"Nail trim","amount_cents":1500,"addon_charge_id":"ad606000-0000-4000-8000-0000000000a1"},
        {"description":"Teeth","amount_cents":900,"addon_charge_id":"ad606000-0000-4000-8000-0000000000a2"}]'::jsonb);
    RAISE EXCEPTION 'PROOF FAILED [addon]: an add-on already billed was billed again';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'An add-on on this invoice has already been billed.%' THEN RAISE; END IF;
  END;
  IF (SELECT next_invoice_number FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa') <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [addon]: the failed save moved the counter';
  END IF;
  IF (SELECT status::text FROM public.addon_charges WHERE id = 'ad606000-0000-4000-8000-0000000000a1') <> 'pending'
     OR (SELECT invoice_line_item_id FROM public.addon_charges WHERE id = 'ad606000-0000-4000-8000-0000000000a1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [addon]: the add-on claimed before the failure was not handed back';
  END IF;
  RAISE NOTICE 'ok: a save that fails on an add-on takes no number and leaves the other add-on pending';
END $$;

-- ── The next save that works takes the very next number ────────────────────
DO $$
DECLARE _first int; _id uuid; _n int;
BEGIN
  SELECT max(number) INTO _first FROM public.invoices WHERE organization_id = '0a606000-0000-4000-8000-0000000000aa';
  _id := public.create_manual_invoice(
    (SELECT v FROM proof_inv WHERE k = 'head'),
    '[{"description":"Nail trim","amount_cents":1500,"addon_charge_id":"ad606000-0000-4000-8000-0000000000a1"}]'::jsonb);
  SELECT number INTO _n FROM public.invoices WHERE id = _id;
  IF _n <> _first + 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [next]: after INV-% the next save was INV-%', _first, _n;
  END IF;
  IF (SELECT status::text FROM public.addon_charges WHERE id = 'ad606000-0000-4000-8000-0000000000a1') <> 'invoiced' THEN
    RAISE EXCEPTION 'PROOF FAILED [next]: the add-on was not claimed';
  END IF;
  RAISE NOTICE 'ok: after two failed saves the next invoice is INV-%, no gap', _n;
END $$;

-- ── Mutation: the sequence this replaced burns a number ────────────────────
SAVEPOINT mutation;
DO $$
DECLARE _before int; _id uuid;
BEGIN
  SELECT next_invoice_number INTO _before FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa';
  INSERT INTO public.invoices (organization_id, client_id, period_end, total_cents, status, issued_at)
  VALUES ('0a606000-0000-4000-8000-0000000000aa', 'c6060000-0000-4000-8000-0000000000a1', current_date, 8500, 'open', now())
  RETURNING id INTO _id;
  BEGIN
    -- What the bulk insert wrote for the row that did not name quantity.
    INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents, quantity)
    VALUES (_id, 'Full groom', 6500, NULL);
    RAISE EXCEPTION 'INCONCLUSIVE: a line with quantity NULL was accepted';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  DELETE FROM public.invoices WHERE id = _id;
  IF (SELECT next_invoice_number FROM public.organizations WHERE id = '0a606000-0000-4000-8000-0000000000aa') <> _before + 1 THEN
    RAISE EXCEPTION 'INCONCLUSIVE: the old insert-then-delete sequence did not move the counter';
  END IF;
  RAISE NOTICE 'ok: mutation: the old sequence fails on quantity NULL and skips a number';
END $$;
ROLLBACK TO SAVEPOINT mutation;

ROLLBACK;
