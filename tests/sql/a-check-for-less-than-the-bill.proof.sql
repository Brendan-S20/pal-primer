-- A check for less than the bill: what 20261015120000 changes, proved against
-- a real Postgres. Run by tests/a-check-for-less-than-the-bill.test.ts, which
-- passes :migration, the file under proof. Every earlier migration is assumed
-- applied (a local stack built from main).
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

-- ── A tenant, and one invoice paid before the migration (for the backfill) ─

SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a6000000-0000-4000-8000-00000000b001', 'olivia@partial.proof.invalid'),
  ('a6000000-0000-4000-8000-00000000b005', 'sam@partial.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a600000-0000-4000-8000-0000000000bb', 'Partial Proof A', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a6000000-0000-4000-8000-00000000b001', '0a600000-0000-4000-8000-0000000000bb', 'owner'),
  ('a6000000-0000-4000-8000-00000000b005', '0a600000-0000-4000-8000-0000000000bb', 'tech');
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c6000000-0000-4000-8000-0000000000b1', '0a600000-0000-4000-8000-0000000000bb', 'residential', 'Partial Customer'),
  ('c6000000-0000-4000-8000-0000000000b2', '0a600000-0000-4000-8000-0000000000bb', 'residential', 'Field Customer');
-- 16..: invoices. b0 was paid in full before the migration existed.
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
  ('16000000-0000-4000-8000-0000000000b0', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b1', current_date - 60, 5000, 'paid', now() - interval '60 days');
INSERT INTO public.payments (invoice_id, organization_id, amount_cents, currency, status, paid_at, method) VALUES
  ('16000000-0000-4000-8000-0000000000b0', '0a600000-0000-4000-8000-0000000000bb', 5000, 'usd',
   'succeeded', now() - interval '55 days', 'check');
-- An old updated_at, set with touch_invoices held off (it would write now()),
-- so a backfill that moved it is visible.
ALTER TABLE public.invoices DISABLE TRIGGER touch_invoices;
UPDATE public.invoices SET updated_at = '2026-01-01T00:00:00Z' WHERE id = '16000000-0000-4000-8000-0000000000b0';
ALTER TABLE public.invoices ENABLE TRIGGER touch_invoices;

-- ── The migration ───────────────────────────────────────────────────────────

\i :migration

DO $$
BEGIN
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000b0') <> 5000 THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: a paid invoice did not learn what was paid on it';
  END IF;
  IF (SELECT updated_at FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000b0') <> '2026-01-01T00:00:00Z' THEN
    RAISE EXCEPTION 'PROOF FAILED [backfill]: the backfill moved updated_at';
  END IF;
  RAISE NOTICE 'ok: the backfill reads the ledger and leaves updated_at alone';
END $$;

-- Open invoices for the rest, made after the migration.
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
  -- a: $80, paid in two parts
  ('16000000-0000-4000-8000-0000000000a1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b1', current_date - 20, 8000, 'open', now() - interval '20 days'),
  -- c (older) and d (newer): $40 each, for the field collection
  ('16000000-0000-4000-8000-0000000000c1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b2', current_date - 40, 4000, 'open', now() - interval '40 days'),
  ('16000000-0000-4000-8000-0000000000d1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b2', current_date - 10, 4000, 'open', now() - interval '10 days'),
  -- e: $50, partly paid, then credit covers the rest and no more
  ('16000000-0000-4000-8000-0000000000e1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b1', current_date - 5, 5000, 'open', now() - interval '5 days');

-- ── Less than the balance: recorded, and the invoice stays open ────────────

SELECT set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _r jsonb; _err text;
BEGIN
  _r := public.record_invoice_payment('16000000-0000-4000-8000-0000000000a1', 6000, 'check', '1042');
  IF (_r->>'paid')::boolean OR (_r->>'balance_cents')::int <> 2000 OR (_r->>'amount_paid_cents')::int <> 6000 THEN
    RAISE EXCEPTION 'PROOF FAILED [partial]: $60 against $80 answered %', _r;
  END IF;
  IF (SELECT status FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000a1') <> 'open'
     OR (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000a1') <> 6000 THEN
    RAISE EXCEPTION 'PROOF FAILED [partial]: the invoice is not open with $60 paid';
  END IF;

  -- More than the balance is refused, in words the dialog can show.
  BEGIN
    PERFORM public.record_invoice_payment('16000000-0000-4000-8000-0000000000a1', 2500, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [overpay]: $25 against $20 owed was recorded';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    IF _err NOT LIKE 'That is more than the $20.00 still owed on this invoice%' THEN
      RAISE EXCEPTION 'PROOF FAILED [overpay]: refused, but said "%"', _err;
    END IF;
  END;
  BEGIN
    PERFORM public.record_invoice_payment('16000000-0000-4000-8000-0000000000a1', 0, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [zero]: a $0 payment was recorded against money owed';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- The rest: paid.
  _r := public.record_invoice_payment('16000000-0000-4000-8000-0000000000a1', 2000, 'cash');
  IF NOT (_r->>'paid')::boolean OR (_r->>'balance_cents')::int <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [settle]: the last $20 answered %', _r;
  END IF;
  IF (SELECT status FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000a1') <> 'paid'
     OR (SELECT paid_at FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000a1') IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [settle]: the invoice did not become paid when payments reached the total';
  END IF;
  BEGIN
    PERFORM public.record_invoice_payment('16000000-0000-4000-8000-0000000000a1', 100, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [closed]: a payment was recorded on a paid invoice';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- Nobody but the sync writes the column.
  UPDATE public.invoices SET amount_paid_cents = 1 WHERE id = '16000000-0000-4000-8000-0000000000a1';
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000a1') <> 8000 THEN
    RAISE EXCEPTION 'PROOF FAILED [guard]: a billing role rewrote amount_paid_cents';
  END IF;
  RAISE NOTICE 'ok: $60 of $80 stays open, $25 more is refused, the last $20 pays it, and the column cannot be written';
END $$;
RESET ROLE;

-- A tech manages no billing.
SELECT set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000b005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.record_invoice_payment('16000000-0000-4000-8000-0000000000e1', 100, 'cash');
    RAISE EXCEPTION 'PROOF FAILED [authz]: a tech recorded a payment';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a tech cannot record a payment';
END $$;
RESET ROLE;

-- ── Every writer moves it: the Stripe webhook inserts, a refund flips ──────

-- The service role, as the webhook and the nightly job run.
SELECT set_config('request.jwt.claims', '{}', true);

DO $$
DECLARE _pid uuid;
BEGIN
  INSERT INTO public.payments (invoice_id, organization_id, amount_cents, currency, status, paid_at, stripe_payment_intent_id)
  VALUES ('16000000-0000-4000-8000-0000000000e1', '0a600000-0000-4000-8000-0000000000bb', 1000, 'usd',
          'succeeded', now(), 'pi_partial_proof_1')
  RETURNING id INTO _pid;
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000e1') <> 1000 THEN
    RAISE EXCEPTION 'PROOF FAILED [sync]: an inserted payment did not move amount_paid_cents';
  END IF;
  UPDATE public.payments SET status = 'refunded' WHERE id = _pid;
  IF (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000e1') <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [sync]: a refunded payment still counts as paid';
  END IF;
  UPDATE public.payments SET status = 'succeeded' WHERE id = _pid;
  RAISE NOTICE 'ok: amount_paid_cents follows the ledger through an insert and a refund';
END $$;

-- ── Credit covers what is left, not the whole bill ──────────────────────────

DO $$
DECLARE _r jsonb;
BEGIN
  PERFORM public.post_credit_entry('0a600000-0000-4000-8000-0000000000bb', 'c6000000-0000-4000-8000-0000000000b1',
                                   9000, 'adjustment', NULL, NULL, 'proof credit');
  _r := public.apply_credit_to_invoice('16000000-0000-4000-8000-0000000000e1');
  IF (_r->>'applied_cents')::int <> 4000 OR _r->>'invoice_status' <> 'paid' THEN
    RAISE EXCEPTION 'PROOF FAILED [credit]: $10 paid of $50, credit applied %', _r;
  END IF;
  IF (SELECT credit_balance_cents FROM public.clients WHERE id = 'c6000000-0000-4000-8000-0000000000b1') <> 5000 THEN
    RAISE EXCEPTION 'PROOF FAILED [credit]: the client was charged credit for money already paid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.credit_ledger
                  WHERE invoice_id = '16000000-0000-4000-8000-0000000000e1' AND note LIKE 'Applied to invoice INV-%') THEN
    RAISE EXCEPTION 'PROOF FAILED [credit]: the ledger note does not name the invoice by number';
  END IF;
  RAISE NOTICE 'ok: credit pays only the balance left after a partial payment';
END $$;

-- ── A field collection: oldest first, the last one partly ───────────────────

INSERT INTO public.field_collections (id, organization_id, client_id, amount_cents, method, collected_at) VALUES
  ('fc600000-0000-4000-8000-0000000000b1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b2', 6000, 'cash', now() - interval '1 hour'),
  ('fc600000-0000-4000-8000-0000000000b2', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b2', 1000, 'cash', now() - interval '1 hour');

SELECT set_config('request.jwt.claims', '{"sub":"a6000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _r jsonb;
BEGIN
  -- Ticked newest first on purpose: the order the money goes is the
  -- invoices' age, not the order of the ticks.
  _r := public.confirm_field_collection('fc600000-0000-4000-8000-0000000000b1',
          ARRAY['16000000-0000-4000-8000-0000000000d1', '16000000-0000-4000-8000-0000000000c1']::uuid[]);
  IF (_r->>'applied_cents')::int <> 6000 OR jsonb_array_length(_r->'allocations') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [field]: $60 against $40 + $40 answered %', _r;
  END IF;
  IF (SELECT status FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000c1') <> 'paid' THEN
    RAISE EXCEPTION 'PROOF FAILED [field]: the older invoice was not paid first';
  END IF;
  IF (SELECT status FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000d1') <> 'open'
     OR (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000d1') <> 2000 THEN
    RAISE EXCEPTION 'PROOF FAILED [field]: the newer invoice did not take the $20 left, partly paid';
  END IF;
  IF (SELECT status FROM public.field_collections WHERE id = 'fc600000-0000-4000-8000-0000000000b1') <> 'confirmed' THEN
    RAISE EXCEPTION 'PROOF FAILED [field]: the collection was not confirmed';
  END IF;
  IF (SELECT count(*) FROM public.payments
       WHERE raw_event->>'field_collection_id' = 'fc600000-0000-4000-8000-0000000000b1') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [field]: the confirmation did not record its two payments';
  END IF;
  RAISE NOTICE 'ok: $60 of cash pays the older $40 and $20 of the newer one, which stays open';
END $$;
RESET ROLE;

-- A ticked invoice the money never reaches is refused, and nothing is written.
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
  ('16000000-0000-4000-8000-0000000000f1', '0a600000-0000-4000-8000-0000000000bb',
   'c6000000-0000-4000-8000-0000000000b2', current_date - 1, 3000, 'open', now() - interval '1 day');
SET ROLE authenticated;
DO $$
DECLARE _err text; _f1 text;
BEGIN
  SELECT 'INV-' || number INTO _f1 FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000f1';
  BEGIN
    PERFORM public.confirm_field_collection('fc600000-0000-4000-8000-0000000000b2',
              ARRAY['16000000-0000-4000-8000-0000000000d1', '16000000-0000-4000-8000-0000000000f1']::uuid[]);
    RAISE EXCEPTION 'PROOF FAILED [starved]: $10 was confirmed against $20 and $30 owed';
  EXCEPTION WHEN invalid_parameter_value THEN
    GET STACKED DIAGNOSTICS _err = MESSAGE_TEXT;
    -- The $10 goes to d1 (older), so f1 is the one it cannot reach.
    IF _err IS DISTINCT FROM '$10.00 was collected, which does not reach ' || _f1 || '. Untick ' || _f1
                             || ' and confirm again to apply the cash to the older invoices.' THEN
      RAISE EXCEPTION 'PROOF FAILED [starved]: refused, but said "%"', _err;
    END IF;
  END;
  IF (SELECT status FROM public.field_collections WHERE id = 'fc600000-0000-4000-8000-0000000000b2') <> 'awaiting_confirmation'
     OR (SELECT amount_paid_cents FROM public.invoices WHERE id = '16000000-0000-4000-8000-0000000000d1') <> 2000 THEN
    RAISE EXCEPTION 'PROOF FAILED [starved]: a refused confirmation wrote something';
  END IF;
  RAISE NOTICE 'ok: a ticked invoice the cash cannot reach is refused and nothing is applied';
END $$;
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL PARTIAL PAYMENT PROOFS PASSED'; END $$;

ROLLBACK;
