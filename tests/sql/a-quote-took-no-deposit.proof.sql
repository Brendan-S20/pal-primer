-- A quote's deposit, proved against a real Postgres. Run by
-- tests/a-quote-took-no-deposit.test.ts, which passes the migration as
-- :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000d501', 'owner@deposit.proof.invalid');
-- A business that charges sales tax, so "a deposit is not taxed" is tested
-- against a rate that would otherwise apply.
INSERT INTO public.organizations (id, name, timezone, sales_tax_rate_bps) VALUES
  ('0a000000-0000-4000-8000-0000000000d5', 'Deposit Proof', 'America/Chicago', 825);
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000d501', '0a000000-0000-4000-8000-0000000000d5', 'owner');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-0000000000d5', '0a000000-0000-4000-8000-0000000000d5', 'residential', 'Deposit Client'),
  ('c0000000-0000-4000-8000-0000000000d6', '0a000000-0000-4000-8000-0000000000d5', 'residential', 'Converted Prospect');

-- Q1 to a client, Q2 to a prospect, Q3 with no deposit.
INSERT INTO public.quotes (id, organization_id, client_id, prospect_name, title, deposit_cents) VALUES
  ('90000000-0000-4000-8000-0000000000d1', '0a000000-0000-4000-8000-0000000000d5',
   'c0000000-0000-4000-8000-0000000000d5', NULL, 'Client quote', 5000),
  ('90000000-0000-4000-8000-0000000000d2', '0a000000-0000-4000-8000-0000000000d5',
   NULL, 'A Prospect', 'Prospect quote', 7500),
  ('90000000-0000-4000-8000-0000000000d3', '0a000000-0000-4000-8000-0000000000d5',
   'c0000000-0000-4000-8000-0000000000d5', NULL, 'No deposit', NULL);
INSERT INTO public.quote_line_items (quote_id, description, quantity, unit_amount_cents, amount_cents, recurring)
SELECT id, 'Initial cleanup', 1, 12000, 12000, false FROM public.quotes
 WHERE id::text LIKE '90000000-0000-4000-8000-0000000000d%';
UPDATE public.quotes SET status = 'sent', sent_at = now()
 WHERE id::text LIKE '90000000-0000-4000-8000-0000000000d%';

DO $$
BEGIN
  BEGIN
    UPDATE public.quotes SET deposit_cents = 1 WHERE id = '90000000-0000-4000-8000-0000000000d1';
    RAISE EXCEPTION 'PROOF FAILED [frozen]: a sent quote''s deposit changed';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  END;
  IF public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d1') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [before accept]: a deposit was invoiced before the customer accepted';
  END IF;
  RAISE NOTICE 'ok: the deposit is part of what was sent, and nothing is billed before acceptance';
END $$;

UPDATE public.quotes SET status = 'accepted', accepted_at = now(), accepted_name = 'Pat Customer'
 WHERE id::text LIKE '90000000-0000-4000-8000-0000000000d%';

DO $$
DECLARE _a uuid; _b uuid; _inv record; _n int;
BEGIN
  _a := public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d1');
  _b := public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d1');
  IF _a IS NULL OR _a <> _b THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: % then %', _a, _b;
  END IF;
  SELECT count(*) INTO _n FROM public.invoices WHERE client_id = 'c0000000-0000-4000-8000-0000000000d5';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [once]: % invoices for the client', _n;
  END IF;
  SELECT * INTO _inv FROM public.invoices WHERE id = _a;
  IF _inv.kind <> 'prepaid_topup' OR _inv.status <> 'open' OR _inv.total_cents <> 5000
     OR _inv.subtotal_cents <> 5000 OR _inv.tax_cents <> 0 OR _inv.number IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [invoice]: kind % status % subtotal % tax % total % number %',
      _inv.kind, _inv.status, _inv.subtotal_cents, _inv.tax_cents, _inv.total_cents, _inv.number;
  END IF;
  IF (SELECT deposit_invoice_id FROM public.quotes WHERE id = '90000000-0000-4000-8000-0000000000d1') <> _a THEN
    RAISE EXCEPTION 'PROOF FAILED [link]: the quote does not point at its deposit invoice';
  END IF;
  IF public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d3') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [no deposit]: a quote with no deposit got a deposit invoice';
  END IF;
  RAISE NOTICE 'ok: one untaxed $50.00 top-up invoice, however many times it is asked for';
END $$;

DO $$
DECLARE _inv uuid;
BEGIN
  IF public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d2') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [prospect]: a prospect was billed with nobody to bill';
  END IF;
  UPDATE public.quotes SET converted_at = now(), converted_client_id = 'c0000000-0000-4000-8000-0000000000d6'
   WHERE id = '90000000-0000-4000-8000-0000000000d2';
  -- Called on its own first: a function that inserts, called inside the query
  -- that reads its row, runs under that query's snapshot and cannot see it.
  _inv := public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d2');
  IF (SELECT total_cents FROM public.invoices
       WHERE id = _inv AND client_id = 'c0000000-0000-4000-8000-0000000000d6') IS DISTINCT FROM 7500 THEN
    RAISE EXCEPTION 'PROOF FAILED [prospect]: the converted client was not billed the deposit';
  END IF;
  RAISE NOTICE 'ok: a prospect''s deposit waits for conversion, then bills the new client';
END $$;

-- Paid: credit. Then an ordinary invoice for the cleanup spends it.
DO $$
DECLARE _dep uuid; _cleanup uuid; _credit bigint; _res jsonb;
BEGIN
  SELECT deposit_invoice_id INTO _dep FROM public.quotes WHERE id = '90000000-0000-4000-8000-0000000000d1';
  UPDATE public.invoices SET status = 'paid', paid_at = now() WHERE id = _dep;
  SELECT COALESCE(sum(delta_cents), 0) INTO _credit FROM public.credit_ledger
   WHERE client_id = 'c0000000-0000-4000-8000-0000000000d5';
  IF _credit <> 5000 THEN
    RAISE EXCEPTION 'PROOF FAILED [credit]: a paid $50.00 deposit left % in credit', _credit;
  END IF;

  INSERT INTO public.invoices (organization_id, client_id, status, kind, issued_at, period_start, period_end)
  VALUES ('0a000000-0000-4000-8000-0000000000d5', 'c0000000-0000-4000-8000-0000000000d5', 'open', 'postpaid',
          now(), current_date, current_date)
  RETURNING id INTO _cleanup;
  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (_cleanup, 'Initial cleanup', 12000);
  PERFORM public.set_invoice_totals(_cleanup, 12000);
  _res := public.apply_credit_to_invoice(_cleanup);
  IF (SELECT credit_applied_cents FROM public.invoices WHERE id = _cleanup) <> 5000 THEN
    RAISE EXCEPTION 'PROOF FAILED [spent]: the cleanup invoice took % of the deposit (%)',
      (SELECT credit_applied_cents FROM public.invoices WHERE id = _cleanup), _res;
  END IF;
  RAISE NOTICE 'ok: a paid deposit becomes credit, and the next invoice spends it';
END $$;

-- The office's role cannot point a quote at some other invoice.
SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000d501","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    UPDATE public.quotes
       SET deposit_invoice_id = (SELECT id FROM public.invoices
                                  WHERE client_id = 'c0000000-0000-4000-8000-0000000000d5'
                                    AND kind = 'postpaid' LIMIT 1)
     WHERE id = '90000000-0000-4000-8000-0000000000d3';
    RAISE EXCEPTION 'PROOF FAILED [by hand]: the office set a deposit invoice itself';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.quote_deposit_invoice('90000000-0000-4000-8000-0000000000d3');
    RAISE EXCEPTION 'PROOF FAILED [grants]: a signed-in user can call quote_deposit_invoice';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'ok: only HoundStack links a deposit invoice'; END $$;

ROLLBACK;
\echo ALL DEPOSIT PROOFS PASSED
