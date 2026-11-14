-- A refunded invoice can be voided (#674): what 20261111010000 changes, proved
-- against a real Postgres. Run by tests/a-void-after-a-full-refund-moves-no-money.test.ts,
-- which passes :migration, the file under proof. Every earlier migration is
-- assumed applied (a local stack built from main).
--
-- One transaction, ROLLED BACK at the end, migration included, so this can be
-- pointed at a shared local stack without leaving anything behind. Each group
-- prints "ok: ..." only when every check in it passed, or raises
-- "PROOF FAILED [...]"; ON_ERROR_STOP makes the first failure the exit code.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- ── A tenant, one visit, and three paid invoices with money on them ─────────

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a6740000-0000-4000-8000-000000000001', 'owner@void.proof.invalid'),
  ('a6740000-0000-4000-8000-000000000005', 'tech@void.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a674000-0000-4000-8000-000000000000', 'Void Proof A', 'America/New_York');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a6740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000', 'owner'),
  ('a6740000-0000-4000-8000-000000000005', '0a674000-0000-4000-8000-000000000000', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000', 'residential', 'Refunded Customer');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d6740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000',
   'c6740000-0000-4000-8000-000000000001', '9 Elm St', 'Detroit', '48201');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on)
VALUES ('e6740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000',
        'c6740000-0000-4000-8000-000000000001', 'd6740000-0000-4000-8000-000000000001', 'residential',
        'weekly', 6000, 1, current_date - 30);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, status)
VALUES ('76740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000',
        'e6740000-0000-4000-8000-000000000001', 'c6740000-0000-4000-8000-000000000001',
        'd6740000-0000-4000-8000-000000000001', current_date - 20, 'completed');

-- 1: paid in full, refunded in full (INV-1069's shape: paid / 0 / 6000).
-- 2: paid in full, $20 of $60 refunded.
-- 3: paid, nothing refunded.
-- 4: open, never paid.
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at, paid_at) VALUES
  ('16740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000',
   'c6740000-0000-4000-8000-000000000001', current_date - 20, 6000, 'paid', now() - interval '20 days', now() - interval '19 days'),
  ('16740000-0000-4000-8000-000000000002', '0a674000-0000-4000-8000-000000000000',
   'c6740000-0000-4000-8000-000000000001', current_date - 10, 6000, 'paid', now() - interval '10 days', now() - interval '9 days'),
  ('16740000-0000-4000-8000-000000000003', '0a674000-0000-4000-8000-000000000000',
   'c6740000-0000-4000-8000-000000000001', current_date - 5, 6000, 'paid', now() - interval '5 days', now() - interval '4 days'),
  ('16740000-0000-4000-8000-000000000004', '0a674000-0000-4000-8000-000000000000',
   'c6740000-0000-4000-8000-000000000001', current_date - 1, 6000, 'open', now() - interval '1 day', NULL);
-- The first invoice billed the visit, as the run or "Invoice this visit" would.
INSERT INTO public.invoice_line_items (invoice_id, visit_id, description, amount_cents) VALUES
  ('16740000-0000-4000-8000-000000000001', '76740000-0000-4000-8000-000000000001', 'Service on a day', 6000);
-- Card payments, as the webhook writes them: method stays null.
INSERT INTO public.payments (id, invoice_id, organization_id, amount_cents, currency, status, paid_at, stripe_payment_intent_id, refunded_cents) VALUES
  ('96740000-0000-4000-8000-000000000001', '16740000-0000-4000-8000-000000000001', '0a674000-0000-4000-8000-000000000000',
   6000, 'usd', 'refunded', now() - interval '19 days', 'pi_void_proof_1', 6000),
  ('96740000-0000-4000-8000-000000000002', '16740000-0000-4000-8000-000000000002', '0a674000-0000-4000-8000-000000000000',
   6000, 'usd', 'refunded', now() - interval '9 days', 'pi_void_proof_2', 2000),
  ('96740000-0000-4000-8000-000000000003', '16740000-0000-4000-8000-000000000003', '0a674000-0000-4000-8000-000000000000',
   6000, 'usd', 'succeeded', now() - interval '4 days', 'pi_void_proof_3', 0);

DO $$
BEGIN
  -- The fixture is what the refund trigger (20261102130000) makes of it.
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000001') <> 0
     OR (SELECT amount_refunded_cents FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000001') <> 6000 THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the fully refunded invoice does not read paid 0 / refunded 6000';
  END IF;
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000002') <> 4000
     OR (SELECT amount_refunded_cents FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000002') <> 2000 THEN
    RAISE EXCEPTION 'PROOF FAILED [fixture]: the partly refunded invoice does not read paid 4000 / refunded 2000';
  END IF;
END $$;

-- What the void must not change, taken before.
CREATE TEMP TABLE proof_before AS
  SELECT id, paid_at, amount_paid_cents, amount_refunded_cents, credit_applied_cents, total_cents, issued_at
    FROM public.invoices WHERE organization_id = '0a674000-0000-4000-8000-000000000000';
CREATE TEMP TABLE proof_payments_before AS
  SELECT id, status, amount_cents, refunded_cents, paid_at
    FROM public.payments WHERE organization_id = '0a674000-0000-4000-8000-000000000000';

-- ── The migration, twice: it has to be safe to run again ────────────────────

\i :migration
\i :migration

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'invoice_line_items'
       AND indexname = 'invoice_line_items_visit_unique' AND indexdef LIKE '%released_at IS NULL%') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [twice]: the visit index is not the one rebuilt on released_at';
  END IF;
  RAISE NOTICE 'ok: the migration applies twice and leaves one visit index';
END $$;

-- ── The owner voids the fully refunded invoice: record only ─────────────────

SELECT set_config('request.jwt.claims', '{"sub":"a6740000-0000-4000-8000-000000000001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$ BEGIN PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000001'); END $$;
RESET ROLE;
DO $$
DECLARE _inv public.invoices%ROWTYPE; _b proof_before%ROWTYPE;
BEGIN
  SELECT * INTO _inv FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000001';
  SELECT * INTO _b FROM proof_before WHERE id = '16740000-0000-4000-8000-000000000001';
  IF _inv.status <> 'void' OR _inv.voided_at IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: the invoice is % with voided_at %', _inv.status, _inv.voided_at;
  END IF;
  IF _inv.paid_at IS DISTINCT FROM _b.paid_at
     OR _inv.amount_paid_cents <> _b.amount_paid_cents
     OR _inv.amount_refunded_cents <> _b.amount_refunded_cents
     OR _inv.credit_applied_cents IS DISTINCT FROM _b.credit_applied_cents
     OR _inv.total_cents <> _b.total_cents
     OR _inv.issued_at IS DISTINCT FROM _b.issued_at THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: the void rewrote paid_at, an amount or the issue date';
  END IF;
  IF (SELECT count(*) FROM public.payments p JOIN proof_payments_before b ON b.id = p.id
       WHERE p.status IS DISTINCT FROM b.status OR p.amount_cents <> b.amount_cents
          OR p.refunded_cents <> b.refunded_cents OR p.paid_at IS DISTINCT FROM b.paid_at) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: a payment row changed';
  END IF;
  IF (SELECT count(*) FROM public.credit_ledger WHERE invoice_id = '16740000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: the void posted a credit entry';
  END IF;
  RAISE NOTICE 'ok: a fully refunded invoice becomes void and keeps paid_at and both amounts';
END $$;

-- ── Partly refunded: refused, and nothing written ───────────────────────────

SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'PROOF FAILED [partly]: a partly refunded invoice was voided';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err IS DISTINCT FROM 'Refund the rest first. $40.00 of this invoice is still kept' THEN
      RAISE EXCEPTION 'PROOF FAILED [partly]: refused, but said "%"', _err;
    END IF;
  END;
END $$;
RESET ROLE;
DO $$
BEGIN
  IF (SELECT status FROM public.invoices WHERE id = '16740000-0000-4000-8000-000000000002') <> 'paid'
     OR (SELECT released_at FROM public.invoice_line_items
          WHERE invoice_id = '16740000-0000-4000-8000-000000000002') IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [partly]: the refusal changed the status or released a line';
  END IF;
  RAISE NOTICE 'ok: a partly refunded invoice is told to refund the rest first';
END $$;

-- ── Not refunded, not paid, already void, and the old Void: all as before ───

SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'PROOF FAILED [refused]: a paid, unrefunded invoice was voided';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err NOT LIKE 'This invoice was not refunded%' THEN
      RAISE EXCEPTION 'PROOF FAILED [refused]: paid and unrefunded, but said "%"', _err;
    END IF;
  END;
  BEGIN
    PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000004');
    RAISE EXCEPTION 'PROOF FAILED [refused]: an open invoice was voided by the refund path';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err NOT LIKE 'Only a paid invoice%' THEN
      RAISE EXCEPTION 'PROOF FAILED [refused]: open, but said "%"', _err;
    END IF;
  END;
  BEGIN
    PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PROOF FAILED [refused]: a void invoice was voided again';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err IS DISTINCT FROM 'Invoice is already void' THEN
      RAISE EXCEPTION 'PROOF FAILED [refused]: already void, but said "%"', _err;
    END IF;
  END;
  -- The ordinary Void still refuses a paid invoice, refunded or not.
  BEGIN
    PERFORM public.void_invoice('16740000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'PROOF FAILED [refused]: void_invoice voided a paid invoice';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err IS DISTINCT FROM 'Cannot void a paid invoice' THEN
      RAISE EXCEPTION 'PROOF FAILED [refused]: void_invoice said "%"', _err;
    END IF;
  END;
  RAISE NOTICE 'ok: unrefunded, unpaid and already-void invoices are refused, and void_invoice is unchanged';
END $$;
RESET ROLE;

-- ── A tech may not: the roles that may void are the ones that could ────────

SELECT set_config('request.jwt.claims', '{"sub":"a6740000-0000-4000-8000-000000000005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM public.void_refunded_invoice('16740000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'PROOF FAILED [role]: a tech voided an invoice';
  EXCEPTION WHEN raise_exception THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err LIKE 'PROOF FAILED%' THEN RAISE; END IF;
    IF _err IS DISTINCT FROM 'Not authorized' THEN
      RAISE EXCEPTION 'PROOF FAILED [role]: a tech was refused with "%"', _err;
    END IF;
  END;
  RAISE NOTICE 'ok: a tech is refused the way void_invoice refuses them';
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{}', true);

-- ── The visit can be invoiced again, exactly once ───────────────────────────

DO $$
DECLARE _err text;
BEGIN
  IF (SELECT released_at FROM public.invoice_line_items
       WHERE invoice_id = '16740000-0000-4000-8000-000000000001') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [again]: the voided invoice''s visit line was not released';
  END IF;
  -- The line itself stays: it is what the voided invoice billed, and #859
  -- counts it to key the next invoice.
  IF (SELECT visit_id FROM public.invoice_line_items
       WHERE invoice_id = '16740000-0000-4000-8000-000000000001') <> '76740000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'PROOF FAILED [again]: the released line lost its visit';
  END IF;
  -- The second invoice for the same visit: the line the run or the button
  -- writes, and the guard that stopped it before this migration.
  INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
    ('16740000-0000-4000-8000-000000000005', '0a674000-0000-4000-8000-000000000000',
     'c6740000-0000-4000-8000-000000000001', current_date - 20, 6000, 'open', now());
  INSERT INTO public.invoice_line_items (invoice_id, visit_id, description, amount_cents) VALUES
    ('16740000-0000-4000-8000-000000000005', '76740000-0000-4000-8000-000000000001', 'Service on a day', 6000);
  -- A third is refused by the same guard as before.
  BEGIN
    INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
      ('16740000-0000-4000-8000-000000000006', '0a674000-0000-4000-8000-000000000000',
       'c6740000-0000-4000-8000-000000000001', current_date - 20, 6000, 'open', now());
    INSERT INTO public.invoice_line_items (invoice_id, visit_id, description, amount_cents) VALUES
      ('16740000-0000-4000-8000-000000000006', '76740000-0000-4000-8000-000000000001', 'Service on a day', 6000);
    RAISE EXCEPTION 'PROOF FAILED [again]: the visit was invoiced a third time';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
  IF (SELECT count(*) FROM public.invoice_line_items WHERE visit_id = '76740000-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [again]: expected the released line and one live one';
  END IF;
  RAISE NOTICE 'ok: after the void the visit is invoiced again once, and the guard holds after that';
END $$;

DO $$ BEGIN RAISE NOTICE 'ALL VOID-AFTER-REFUND PROOFS PASSED'; END $$;

ROLLBACK;
