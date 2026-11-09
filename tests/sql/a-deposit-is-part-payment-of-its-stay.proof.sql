-- A deposit is part payment of its stay (#653 part 2, decision D3), and cash
-- or a check can be given back with a reason, proved against a real
-- Postgres. Run by tests/a-deposit-is-part-payment-of-its-stay.test.ts with
-- :card (20261102150000), :migration (20261102160000), :franchise
-- (20261102160500) and :refunds (20261102161000). One transaction, ROLLED
-- BACK at the end, the migrations included. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]".

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :card
\i :migration
\i :franchise
\i :refunds

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000653b01', 'owner@deposit.proof.invalid'),
  ('f0000000-0000-4000-8000-000000653b02', 'sitter@deposit.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000653b00', 'Deposit Proof A', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000653b01', '0a000000-0000-4000-8000-000000653b00', 'owner'),
  ('f0000000-0000-4000-8000-000000653b02', '0a000000-0000-4000-8000-000000653b00', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000653b01', '0a000000-0000-4000-8000-000000653b00',
   'f0000000-0000-4000-8000-000000653b01', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-000000653b02', '0a000000-0000-4000-8000-000000653b00',
   'f0000000-0000-4000-8000-000000653b02', 'tech', 'Sitter A', true);
INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-000000653b01', '0a000000-0000-4000-8000-000000653b00', 'residential', 'Deposit Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d0000000-0000-4000-8000-000000653b01', '0a000000-0000-4000-8000-000000653b00',
   'c0000000-0000-4000-8000-000000653b01', '2 Elm St', 'Chicago', '60614');
INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents) VALUES
  ('5e000000-0000-4000-8000-000000653b01', '0a000000-0000-4000-8000-000000653b00',
   'Proof overnight', 'pet_sitting', 'night', 10000);

CREATE TEMP TABLE proof_day AS SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;

-- Stays: A tonight (night 2), B in December, C and D for the void and
-- whole-price cases, E starting tomorrow for the late cancel.
INSERT INTO public.stays (id, organization_id, client_id, property_id, service_id, starts_on, ends_on, kind,
                          assigned_staff_id, status, deposit_cents)
SELECT x.id::uuid, '0a000000-0000-4000-8000-000000653b00', 'c0000000-0000-4000-8000-000000653b01',
       'd0000000-0000-4000-8000-000000653b01', '5e000000-0000-4000-8000-000000653b01',
       p.today + x.s, p.today + x.e, 'overnight', '5a000000-0000-4000-8000-000000653b02', 'confirmed', x.dep
  FROM proof_day p, (VALUES
    ('57000000-0000-4000-8000-000000653b0a', -1, 2, 15000),
    ('57000000-0000-4000-8000-000000653b0b', 30, 35, 15000),
    ('57000000-0000-4000-8000-000000653b0c', 40, 43, 10000),
    ('57000000-0000-4000-8000-000000653b0d', 50, 51, 10000),
    ('57000000-0000-4000-8000-000000653b0e', 1, 3, 5000)
  ) AS x(id, s, e, dep);

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id, stay_id)
SELECT 'e0000000-0000-4000-8000-000000653b0a', '0a000000-0000-4000-8000-000000653b00',
       'c0000000-0000-4000-8000-000000653b01', 'd0000000-0000-4000-8000-000000653b01', 'residential',
       'weekly', 10000, 1, p.today - 1, '5e000000-0000-4000-8000-000000653b01',
       '57000000-0000-4000-8000-000000653b0a'
  FROM proof_day p;
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id)
SELECT '71000000-0000-4000-8000-000000653b0a', '0a000000-0000-4000-8000-000000653b00',
       'e0000000-0000-4000-8000-000000653b0a', 'c0000000-0000-4000-8000-000000653b01',
       'd0000000-0000-4000-8000-000000653b01', p.today, '5a000000-0000-4000-8000-000000653b02'
  FROM proof_day p;

-- Each stay's invoice and deposit, written the way invoice_stay writes them,
-- then attached to the stay the way invoice_stay attaches them.
INSERT INTO public.invoices (id, organization_id, client_id, kind, period_end, subtotal_cents, total_cents, status, issued_at, due_on, notes)
SELECT x.id::uuid, '0a000000-0000-4000-8000-000000653b00', 'c0000000-0000-4000-8000-000000653b01',
       x.kind::public.invoice_kind, current_date, x.total, x.total, 'open', now(), current_date + 30, x.note
  FROM (VALUES
    ('16000000-0000-4000-8000-000000653b0a', 'postpaid', 35000, 'Stay: Proof overnight'),
    ('16000000-0000-4000-8000-000000653d0a', 'prepaid_topup', 15000, 'Deposit for Proof overnight. Paid, it is credited to your account and comes off your stay invoice.'),
    ('16000000-0000-4000-8000-000000653b0b', 'postpaid', 50000, 'Stay: Proof overnight'),
    ('16000000-0000-4000-8000-000000653d0b', 'prepaid_topup', 15000, 'Deposit for Proof overnight. Paid, it is credited to your account and comes off your stay invoice.'),
    ('16000000-0000-4000-8000-000000653b0c', 'postpaid', 30000, 'Stay: Proof overnight'),
    ('16000000-0000-4000-8000-000000653d0c', 'prepaid_topup', 10000, 'Deposit'),
    ('16000000-0000-4000-8000-000000653b0d', 'postpaid', 10000, 'Stay: Proof overnight'),
    ('16000000-0000-4000-8000-000000653d0d', 'prepaid_topup', 10000, 'Deposit'),
    ('16000000-0000-4000-8000-000000653b0e', 'postpaid', 20000, 'Stay: Proof overnight'),
    ('16000000-0000-4000-8000-000000653d0e', 'prepaid_topup', 5000, 'Deposit')
  ) AS x(id, kind, total, note);
INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
SELECT id, 'Line', total_cents FROM public.invoices WHERE organization_id = '0a000000-0000-4000-8000-000000653b00';

UPDATE public.stays st
   SET invoice_id = ('16000000-0000-4000-8000-000000653b0' || right(st.id::text, 1))::uuid,
       deposit_invoice_id = ('16000000-0000-4000-8000-000000653d0' || right(st.id::text, 1))::uuid
 WHERE st.organization_id = '0a000000-0000-4000-8000-000000653b00';

-- Pays an invoice the way markInvoicePaidFromStripe does: the status first,
-- then the payment row.
CREATE FUNCTION pg_temp.stripe_pays(_inv uuid, _cents integer, _pi text) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE _id uuid;
BEGIN
  UPDATE public.invoices SET status = 'paid', paid_at = now() WHERE id = _inv AND status <> 'paid';
  INSERT INTO public.payments (invoice_id, organization_id, amount_cents, currency, status, paid_at, stripe_payment_intent_id)
  VALUES (_inv, '0a000000-0000-4000-8000-000000653b00', _cents, 'usd', 'succeeded', now(), _pi)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE FUNCTION pg_temp.inv(_id uuid) RETURNS public.invoices
LANGUAGE sql AS $$ SELECT * FROM public.invoices WHERE id = _id $$;

CREATE FUNCTION pg_temp.credit() RETURNS bigint
LANGUAGE sql AS $$ SELECT COALESCE(sum(delta_cents), 0) FROM public.credit_ledger
                    WHERE client_id = 'c0000000-0000-4000-8000-000000653b01' $$;

-- Open AR as src/lib/ar.ts now sums it: open invoices, linked deposits left out.
CREATE FUNCTION pg_temp.open_total() RETURNS bigint
LANGUAGE sql AS $$
  SELECT COALESCE(sum(GREATEST(total_cents - credit_applied_cents - amount_paid_cents, 0)), 0)
    FROM public.invoices
   WHERE client_id = 'c0000000-0000-4000-8000-000000653b01' AND status = 'open'
     AND deposit_for_invoice_id IS NULL $$;

-- ── 1. Linked, and said so ────────────────────────────────────────────────
DO $p$
BEGIN
  IF (SELECT count(*) FROM public.invoices WHERE deposit_for_invoice_id IS NOT NULL
        AND organization_id = '0a000000-0000-4000-8000-000000653b00') <> 5 THEN
    RAISE EXCEPTION 'PROOF FAILED [link]: invoicing a stay did not link its deposit';
  END IF;
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653d0a')).notes NOT LIKE '%part payment of your stay invoice%' THEN
    RAISE EXCEPTION 'PROOF FAILED [link]: the deposit still says it becomes account credit';
  END IF;
  RAISE NOTICE 'ok: invoicing a stay links its deposit, and the deposit says what it is';
END $p$;

-- ── 2. Paying a deposit pays part of the stay, and is not credit ─────────
SELECT pg_temp.stripe_pays('16000000-0000-4000-8000-000000653d0a', 15000, 'pi_proof_653_a') \gset
DO $p$
BEGIN
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0a')).amount_paid_cents <> 15000
     OR (pg_temp.inv('16000000-0000-4000-8000-000000653b0a')).status <> 'open' THEN
    RAISE EXCEPTION 'PROOF FAILED [deposit]: the stay invoice did not count its $150 deposit';
  END IF;
  IF pg_temp.credit() <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [deposit]: a paid deposit was posted as % cents of account credit', pg_temp.credit();
  END IF;
  -- The portal's open total: stay totals less deposits paid. $350 - $150 +
  -- $500 (December's deposit unpaid, part of the $500, not added) + C, D, E.
  IF pg_temp.open_total() <> (35000 - 15000) + 50000 + 30000 + 10000 + 20000 THEN
    RAISE EXCEPTION 'PROOF FAILED [deposit]: open total % is not stay totals less deposits paid', pg_temp.open_total();
  END IF;
  RAISE NOTICE 'ok: a paid deposit comes off its stay invoice, posts no credit, and open AR is stays less deposits paid';
END $p$;

-- ── 3. Tonight's card: this stay, net of its deposit ─────────────────────
DO $jwt$ BEGIN PERFORM set_config('request.jwt.claims',
  '{"sub": "f0000000-0000-4000-8000-000000653b02", "role": "authenticated", "aal": "aal2"}', true); END $jwt$;
SET LOCAL ROLE authenticated;
DO $p$
DECLARE _night bigint;
BEGIN
  SELECT open_balance_cents INTO _night
    FROM public.my_day_stop_facts(ARRAY['71000000-0000-4000-8000-000000653b0a'::uuid]);
  IF _night IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION 'PROOF FAILED [card]: tonight''s card says % cents, expected 20000', _night;
  END IF;
  RAISE NOTICE 'ok: tonight''s card is this stay''s balance net of its deposit ($200)';
END $p$;
RESET ROLE;

-- ── 4. Cash for a deposit, then a bounced check, both from the office ────
DO $jwt$ BEGIN PERFORM set_config('request.jwt.claims',
  '{"sub": "f0000000-0000-4000-8000-000000653b01", "role": "authenticated", "aal": "aal2"}', true); END $jwt$;
SET LOCAL ROLE authenticated;
-- Nobody signed in links a deposit by hand, the office included.
DO $p$
BEGIN
  BEGIN
    UPDATE public.invoices SET deposit_for_invoice_id = NULL WHERE id = '16000000-0000-4000-8000-000000653d0b';
    RAISE EXCEPTION 'PROOF FAILED [guard]: the office moved a deposit link';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a deposit link cannot be set or cleared by the office, only by the booking';
END $p$;
DO $p$
DECLARE _r jsonb; _err text;
BEGIN
  _r := public.record_invoice_payment('16000000-0000-4000-8000-000000653d0b', NULL, 'check', '1042', now(), NULL, NULL);
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0b')).amount_paid_cents <> 15000
     OR (pg_temp.inv('16000000-0000-4000-8000-000000653d0b')).status <> 'paid' THEN
    RAISE EXCEPTION 'PROOF FAILED [check]: a deposit check did not count on December''s stay';
  END IF;

  BEGIN
    PERFORM public.refund_manual_payment((_r->>'payment_id')::uuid, 15000, '  ', true);
    RAISE EXCEPTION 'PROOF FAILED [reason]: a reversal with no reason was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.refund_manual_payment((_r->>'payment_id')::uuid, 15001, 'Check bounced', true);
    RAISE EXCEPTION 'PROOF FAILED [amount]: more than the payment was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  PERFORM public.refund_manual_payment((_r->>'payment_id')::uuid, 15000, 'Check bounced', true);
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0b')).amount_paid_cents <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [bounce]: the stay still counts a bounced deposit check';
  END IF;
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653d0b')).status <> 'open' THEN
    RAISE EXCEPTION 'PROOF FAILED [bounce]: the deposit was not reopened after its check bounced';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.review_items
                  WHERE subject_id = (_r->>'payment_id')::uuid AND kind = 'payment_refunded'
                    AND status = 'resolved' AND reason = 'Reversed: Check bounced'
                    AND (detail->>'revenue_cents')::integer = 15000) THEN
    RAISE EXCEPTION 'PROOF FAILED [bounce]: no dated reversal was filed for the reports';
  END IF;
  BEGIN
    PERFORM public.refund_manual_payment((_r->>'payment_id')::uuid, 100, 'Again', false);
    RAISE EXCEPTION 'PROOF FAILED [twice]: a second refund on one payment was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  IF pg_temp.credit() <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [bounce]: the reversal moved account credit';
  END IF;
  RAISE NOTICE 'ok: a deposit check counts on its stay, and a bounced one comes off with a reason';
END $p$;

-- A Stripe payment is refunded through Stripe, not here.
DO $p$
BEGIN
  BEGIN
    PERFORM public.refund_manual_payment(
      (SELECT id FROM public.payments WHERE stripe_payment_intent_id = 'pi_proof_653_a'), 100, 'Goodwill', false);
    RAISE EXCEPTION 'PROOF FAILED [stripe]: a card payment was refunded as cash';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RAISE NOTICE 'ok: a card payment is refused, so its money goes back through Stripe';
END $p$;

-- ── 5. The rest of a stay, and a whole stay paid with its deposit open ───
DO $p$
BEGIN
  PERFORM public.record_invoice_payment('16000000-0000-4000-8000-000000653b0a', NULL, 'cash', NULL, now(), NULL, NULL);
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0a')).status <> 'paid'
     OR (pg_temp.inv('16000000-0000-4000-8000-000000653b0a')).amount_paid_cents <> 35000 THEN
    RAISE EXCEPTION 'PROOF FAILED [rest]: $200 cash did not settle tonight''s stay';
  END IF;
  IF (SELECT amount_cents FROM public.payments WHERE invoice_id = '16000000-0000-4000-8000-000000653b0a') <> 20000 THEN
    RAISE EXCEPTION 'PROOF FAILED [rest]: the stay was charged more than what was left after its deposit';
  END IF;

  PERFORM public.record_invoice_payment('16000000-0000-4000-8000-000000653b0b', NULL, 'cash', NULL, now(), NULL, NULL);
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653d0b')).status <> 'void' THEN
    RAISE EXCEPTION 'PROOF FAILED [whole]: the deposit still asks for money on a stay paid in full';
  END IF;
  RAISE NOTICE 'ok: a stay is owed only what its deposit left, and a stay paid in full voids its unpaid deposit';
END $p$;

-- ── 6. A voided stay gives a paid deposit back as account credit ─────────
RESET ROLE;
SELECT pg_temp.stripe_pays('16000000-0000-4000-8000-000000653d0c', 10000, 'pi_proof_653_c') \gset
SET LOCAL ROLE authenticated;
DO $p$
BEGIN
  PERFORM public.void_invoice('16000000-0000-4000-8000-000000653b0c');
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653d0c')).deposit_for_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: the deposit is still part of a void invoice';
  END IF;
  IF pg_temp.credit() <> 10000 THEN
    RAISE EXCEPTION 'PROOF FAILED [void]: the client holds % cents of credit, expected 10000', pg_temp.credit();
  END IF;
  RAISE NOTICE 'ok: a voided stay releases its paid deposit to account credit';
END $p$;
RESET ROLE;

-- ── 7. A deposit for the whole price settles the stay ─────────────────────
SELECT pg_temp.stripe_pays('16000000-0000-4000-8000-000000653d0d', 10000, 'pi_proof_653_d') \gset
DO $p$
BEGIN
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0d')).status <> 'paid' THEN
    RAISE EXCEPTION 'PROOF FAILED [settle]: a deposit of the whole price left the stay open';
  END IF;
  RAISE NOTICE 'ok: a deposit of the whole price marks the stay invoice paid';
END $p$;

-- ── 8. A card refund of a deposit comes off the stay, not off credit ─────
SELECT pg_temp.stripe_pays('16000000-0000-4000-8000-000000653d0e', 5000, 'pi_proof_653_e') \gset
DO $p$
DECLARE _before bigint := pg_temp.credit(); _back bigint;
BEGIN
  UPDATE public.payments SET status = 'refunded', refunded_cents = 2000 WHERE stripe_payment_intent_id = 'pi_proof_653_e';
  _back := public.reverse_prepaid_credit_for_payment(
    (SELECT id FROM public.payments WHERE stripe_payment_intent_id = 'pi_proof_653_e'), 2000);
  IF _back <> 0 OR pg_temp.credit() <> _before THEN
    RAISE EXCEPTION 'PROOF FAILED [refund]: refunding a deposit took back credit it never gave';
  END IF;
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653b0e')).amount_paid_cents <> 3000 THEN
    RAISE EXCEPTION 'PROOF FAILED [refund]: stay E counts % cents paid, expected 3000',
      (pg_temp.inv('16000000-0000-4000-8000-000000653b0e')).amount_paid_cents;
  END IF;
  RAISE NOTICE 'ok: a refunded deposit comes off what was paid on its stay';
END $p$;

-- ── 9. A late cancel keeps the deposit as a fee, as it always did ────────
DO $jwt$ BEGIN PERFORM set_config('request.jwt.claims',
  '{"sub": "f0000000-0000-4000-8000-000000653b01", "role": "authenticated", "aal": "aal2"}', true); END $jwt$;
DO $p$
DECLARE _before bigint := pg_temp.credit(); _fee public.invoices%ROWTYPE;
BEGIN
  UPDATE public.stays SET status = 'canceled' WHERE id = '57000000-0000-4000-8000-000000653b0e';
  IF (pg_temp.inv('16000000-0000-4000-8000-000000653d0e')).deposit_for_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [cancel]: a canceled stay kept its deposit linked';
  END IF;
  SELECT * INTO _fee FROM public.invoices
   WHERE client_id = 'c0000000-0000-4000-8000-000000653b01' AND notes LIKE 'Stay canceled less than%';
  IF _fee.id IS NULL OR _fee.total_cents <> 5000 THEN
    RAISE EXCEPTION 'PROOF FAILED [cancel]: no cancellation fee for the deposit';
  END IF;
  -- What was kept of the deposit ($30 of $50, after the $20 refund) went back
  -- to account credit, and the fee was paid from the account's credit, as a
  -- paid deposit's credit paid it before D3 (the $100 from stay C covers the
  -- rest here). Nothing is created or lost on the way.
  IF _fee.status <> 'paid' OR pg_temp.credit() <> _before + 3000 - _fee.credit_applied_cents THEN
    RAISE EXCEPTION 'PROOF FAILED [cancel]: fee % with % cents of credit applied; credit % then %',
      _fee.status, _fee.credit_applied_cents, _before, pg_temp.credit();
  END IF;
  RAISE NOTICE 'ok: a late cancel still keeps a paid deposit as the cancellation fee';
END $p$;

ROLLBACK;

\echo ALL DEPOSIT PROOFS PASSED
