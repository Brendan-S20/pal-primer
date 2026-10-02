-- Sales tax, proved against a real Postgres rather than read off the
-- migration's text. Run by tests/the-billing-run-charges-the-organizations-rate.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a column or a row behind. Each check prints "ok: ..." or
-- raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first failure into
-- a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- T: a business that charges 8.25%, with a taxed client (A) and an exempt one
--    (E), and a prepaid client (P).
-- Z: a business that never set a rate -- every business, today.
-- F: a franchise parent, with T as its location, collecting T's card money.
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a7000000-0000-4000-8000-00000000a001', 'owner-t@tax.proof.invalid');

INSERT INTO public.organizations (id, name, timezone, sales_tax_rate_bps, sales_tax_label) VALUES
  ('0f000000-0000-4000-8000-0000000000f1', 'Tax Proof Franchise', 'America/Chicago', 0, 'Sales tax'),
  ('07000000-0000-4000-8000-0000000000a1', 'Tax Proof Taxed', 'America/Chicago', 825, 'County service tax'),
  ('07000000-0000-4000-8000-0000000000b1', 'Tax Proof Zero', 'America/Chicago', 0, 'Sales tax');
UPDATE public.organizations
   SET parent_organization_id = '0f000000-0000-4000-8000-0000000000f1',
       franchise_royalty_percent = 10
 WHERE id = '07000000-0000-4000-8000-0000000000a1';

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a7000000-0000-4000-8000-00000000a001', '07000000-0000-4000-8000-0000000000a1', 'owner');

INSERT INTO public.clients (id, organization_id, account_type, display_name, tax_exempt) VALUES
  ('c7000000-0000-4000-8000-0000000000a1', '07000000-0000-4000-8000-0000000000a1', 'residential', 'Tax Proof A', false),
  ('c7000000-0000-4000-8000-0000000000e1', '07000000-0000-4000-8000-0000000000a1', 'residential', 'Tax Proof Exempt', true),
  ('c7000000-0000-4000-8000-0000000000c1', '07000000-0000-4000-8000-0000000000a1', 'residential', 'Tax Proof Prepaid', false),
  ('c7000000-0000-4000-8000-0000000000b1', '07000000-0000-4000-8000-0000000000b1', 'residential', 'Tax Proof Zero', false);
UPDATE public.clients SET portal_token = '7a000000-0000-4000-8000-0000000000c1'
 WHERE id = 'c7000000-0000-4000-8000-0000000000c1';
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code)
SELECT ('d7000000-0000-4000-8000-0000000000' || s)::uuid, o::uuid, c::uuid, '1 Proof Lane', 'Chicago', '60601'
  FROM (VALUES
    ('a1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000a1'),
    ('e1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000e1'),
    ('c1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000c1'),
    ('b1', '07000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000b1')
  ) AS t(s, o, c);

-- Three $33.33 visits apiece: a subtotal of $99.99, whose 8.25% is 824.9175
-- cents. Taxed once on the whole it is 825; taxed per line it would be
-- 275 x 3 = 825 as well, so a fourth line of $0.07 is added below to make the
-- two rules disagree: whole 10,006 x 8.25% = 825.495 -> 825, per line
-- 275+275+275+1 = 826.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, billing_cadence)
SELECT ('e7000000-0000-4000-8000-0000000000' || s)::uuid, o::uuid, c::uuid, ('d7000000-0000-4000-8000-0000000000' || s)::uuid,
       'residential', 'weekly', 3333, 1, cad::public.billing_cadence
  FROM (VALUES
    ('a1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000a1', 'postpaid'),
    ('e1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000e1', 'postpaid'),
    ('c1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000c1', 'prepaid'),
    ('b1', '07000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000b1', 'postpaid')
  ) AS t(s, o, c, cad);

INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, scheduled_on, status)
SELECT o::uuid, ('e7000000-0000-4000-8000-0000000000' || s)::uuid, c::uuid, ('d7000000-0000-4000-8000-0000000000' || s)::uuid,
       current_date - n, st::public.visit_status
  FROM (VALUES
    ('a1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000a1', 'completed'),
    ('e1', '07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000e1', 'completed'),
    ('b1', '07000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000b1', 'completed')
  ) AS t(s, o, c, st)
  CROSS JOIN generate_series(1, 3) n;

-- The prepaid client's upcoming visits, which a top-up buys.
INSERT INTO public.visits (organization_id, subscription_id, client_id, property_id, scheduled_on, status)
SELECT '07000000-0000-4000-8000-0000000000a1', 'e7000000-0000-4000-8000-0000000000c1',
       'c7000000-0000-4000-8000-0000000000c1', 'd7000000-0000-4000-8000-0000000000c1',
       current_date + n, 'scheduled'
  FROM generate_series(1, 3) n;

-- A $0.07 add-on on A and on Z, so a per-line rule and a whole-invoice rule
-- give different answers on the same invoice.
INSERT INTO public.addon_charges (organization_id, client_id, description, unit_price_cents, amount_cents, quantity, occurred_on, status)
VALUES
  ('07000000-0000-4000-8000-0000000000a1', 'c7000000-0000-4000-8000-0000000000a1', 'Bag of treats', 7, 7, 1, current_date - 1, 'pending'),
  ('07000000-0000-4000-8000-0000000000b1', 'c7000000-0000-4000-8000-0000000000b1', 'Bag of treats', 7, 7, 1, current_date - 1, 'pending');

CREATE TEMP TABLE proof_inv (who text PRIMARY KEY, id uuid);
INSERT INTO proof_inv VALUES
  ('A', public.admin_generate_invoice_for_client('c7000000-0000-4000-8000-0000000000a1', current_date)),
  ('E', public.admin_generate_invoice_for_client('c7000000-0000-4000-8000-0000000000e1', current_date)),
  ('Z', public.admin_generate_invoice_for_client('c7000000-0000-4000-8000-0000000000b1', current_date));

-- ── The billing run charges the org's rate, once, on the whole subtotal ────
DO $$
DECLARE _i record;
BEGIN
  SELECT i.* INTO _i FROM public.invoices i JOIN proof_inv p ON p.id = i.id WHERE p.who = 'A';
  IF _i.id IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [billing run]: no invoice was generated for the taxed client';
  END IF;
  IF _i.subtotal_cents <> 10006 THEN
    RAISE EXCEPTION 'PROOF FAILED [billing run]: subtotal % is not 3 x 3,333 + 7', _i.subtotal_cents;
  END IF;
  IF _i.tax_rate_bps <> 825 OR _i.tax_cents <> 825 OR _i.total_cents <> 10831 THEN
    RAISE EXCEPTION 'PROOF FAILED [billing run]: rate %, tax %, total %; want 825, 825 (whole invoice, half away from zero), 10,831',
      _i.tax_rate_bps, _i.tax_cents, _i.total_cents;
  END IF;
  IF _i.tax_label IS DISTINCT FROM 'County service tax' THEN
    RAISE EXCEPTION 'PROOF FAILED [billing run]: the label % was not snapshotted', _i.tax_label;
  END IF;
  RAISE NOTICE 'ok: the billing run taxes the whole subtotal once at the org''s rate (10,006 -> 825 -> 10,831)';
END $$;

-- ── A tax-exempt client pays none ──────────────────────────────────────────
DO $$
DECLARE _i record;
BEGIN
  SELECT i.* INTO _i FROM public.invoices i JOIN proof_inv p ON p.id = i.id WHERE p.who = 'E';
  IF _i.subtotal_cents <> 9999 OR _i.tax_rate_bps <> 0 OR _i.tax_cents <> 0
     OR _i.total_cents <> 9999 OR _i.tax_label IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [exempt]: subtotal %, rate %, tax %, total %, label %',
      _i.subtotal_cents, _i.tax_rate_bps, _i.tax_cents, _i.total_cents, _i.tax_label;
  END IF;
  RAISE NOTICE 'ok: an exempt client''s invoice carries rate 0 and no tax';
END $$;

-- ── At a zero rate nothing changes ─────────────────────────────────────────
DO $$
DECLARE _i record;
BEGIN
  SELECT i.* INTO _i FROM public.invoices i JOIN proof_inv p ON p.id = i.id WHERE p.who = 'Z';
  IF _i.subtotal_cents <> 10006 OR _i.total_cents <> 10006 OR _i.tax_cents <> 0
     OR _i.tax_rate_bps <> 0 OR _i.tax_label IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [zero rate]: subtotal %, total %, tax %, rate %, label %',
      _i.subtotal_cents, _i.total_cents, _i.tax_cents, _i.tax_rate_bps, _i.tax_label;
  END IF;
  RAISE NOTICE 'ok: at a zero rate the invoice is exactly its subtotal, as before';
END $$;

-- ── The rate is a snapshot ─────────────────────────────────────────────────
UPDATE public.organizations SET sales_tax_rate_bps = 1000 WHERE id = '07000000-0000-4000-8000-0000000000a1';
UPDATE public.clients SET tax_exempt = false WHERE id = 'c7000000-0000-4000-8000-0000000000e1';
DO $$
DECLARE _a record; _e record;
BEGIN
  SELECT i.* INTO _a FROM public.invoices i JOIN proof_inv p ON p.id = i.id WHERE p.who = 'A';
  SELECT i.* INTO _e FROM public.invoices i JOIN proof_inv p ON p.id = i.id WHERE p.who = 'E';
  IF _a.tax_rate_bps <> 825 OR _a.tax_cents <> 825 OR _a.total_cents <> 10831
     OR _e.tax_cents <> 0 OR _e.total_cents <> 9999 THEN
    RAISE EXCEPTION 'PROOF FAILED [snapshot]: a settings change re-priced an issued invoice';
  END IF;
  RAISE NOTICE 'ok: a later rate or exemption change does not re-price an issued invoice';
END $$;
UPDATE public.organizations SET sales_tax_rate_bps = 825 WHERE id = '07000000-0000-4000-8000-0000000000a1';

-- ── A payment's tax share is pro rata, and filled for every writer ─────────
-- Two halves of the taxed invoice, collected by the FRANCHISE's account.
INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at, collected_by_organization_id)
SELECT '07000000-0000-4000-8000-0000000000a1', p.id, amt, 'succeeded', now(), '0f000000-0000-4000-8000-0000000000f1'
  FROM proof_inv p CROSS JOIN (VALUES (5415), (5416)) AS a(amt)
 WHERE p.who = 'A';
-- A writer that tries to set the tax share itself is overruled.
INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at, tax_cents)
SELECT '07000000-0000-4000-8000-0000000000b1', p.id, 10006, 'succeeded', now(), 999
  FROM proof_inv p WHERE p.who = 'Z';
DO $$
DECLARE _shares int[]; _z int;
BEGIN
  SELECT array_agg(pay.tax_cents ORDER BY pay.amount_cents) INTO _shares
    FROM public.payments pay JOIN proof_inv p ON p.id = pay.invoice_id WHERE p.who = 'A';
  -- 5,415 x 825 / 10,831 = 412.47 -> 412; 5,416 -> 412.54 -> 413. Sum 825.
  IF _shares <> ARRAY[412, 413] THEN
    RAISE EXCEPTION 'PROOF FAILED [payment share]: % is not [412, 413]', _shares;
  END IF;
  SELECT pay.tax_cents INTO _z FROM public.payments pay JOIN proof_inv p ON p.id = pay.invoice_id WHERE p.who = 'Z';
  IF _z <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [payment share]: a payment on an untaxed invoice carries % of tax', _z;
  END IF;
  RAISE NOTICE 'ok: each payment carries its pro-rata tax share (412 + 413 = 825), and 0 on an untaxed invoice';
END $$;

-- ── The royalty is on revenue; the location's tax goes to the location ─────
SET LOCAL request.jwt.claims = '{"role":"service_role"}';
SELECT public.generate_franchise_settlements('0f000000-0000-4000-8000-0000000000f1',
                                             current_date - 1, current_date + 1) AS n \gset
RESET request.jwt.claims;
DO $$
DECLARE _s record;
BEGIN
  SELECT * INTO _s FROM public.franchise_royalty_invoices
   WHERE child_organization_id = '07000000-0000-4000-8000-0000000000a1'
     AND period_start = current_date - 1;
  IF _s.id IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [settlement]: no statement was cut';
  END IF;
  -- Revenue 10,831 - 825 = 10,006; royalty 10% = 1,001 (1,000.6 rounded).
  IF _s.revenue_cents <> 10006 OR _s.royalty_cents <> 1001 THEN
    RAISE EXCEPTION 'PROOF FAILED [settlement]: revenue %, royalty %; the tax is in the royalty base',
      _s.revenue_cents, _s.royalty_cents;
  END IF;
  -- The franchise holds 10,831: 10,006 of revenue less 1,001 royalty, plus the
  -- location's 825 of tax, is owed to the location.
  IF _s.sales_tax_collected_by_parent_cents <> 825
     OR _s.direction <> 'franchise_owes_location' OR _s.net_due_cents <> 9830 THEN
    RAISE EXCEPTION 'PROOF FAILED [settlement]: tax held %, direction %, net %; want 825, franchise_owes_location, 9,830',
      _s.sales_tax_collected_by_parent_cents, _s.direction, _s.net_due_cents;
  END IF;
  RAISE NOTICE 'ok: the royalty is on revenue excluding tax, and the franchise passes the tax to the location';
END $$;

-- ── Prepaid: taxed on the way in, credit worth the visits ──────────────────
CREATE TEMP TABLE proof_topup AS
SELECT public.portal_start_prepaid_topup('7a000000-0000-4000-8000-0000000000c1',
                                         'e7000000-0000-4000-8000-0000000000c1', 3) AS id;
DO $$
DECLARE _i record; _credit bigint;
BEGIN
  SELECT i.* INTO _i FROM public.invoices i JOIN proof_topup t ON t.id = i.id;
  -- 3 x 3,333 = 9,999; 8.25% = 824.9175 -> 825; total 10,824.
  IF _i.subtotal_cents <> 9999 OR _i.tax_cents <> 825 OR _i.total_cents <> 10824
     OR _i.period_start IS NULL OR _i.period_end IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [top-up]: subtotal %, tax %, total %, period % to %',
      _i.subtotal_cents, _i.tax_cents, _i.total_cents, _i.period_start, _i.period_end;
  END IF;
  INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at)
  VALUES (_i.organization_id, _i.id, 10824, 'succeeded', now());
  UPDATE public.invoices SET status = 'paid', paid_at = now() WHERE id = _i.id;
  SELECT COALESCE(SUM(delta_cents), 0) INTO _credit FROM public.credit_ledger WHERE invoice_id = _i.id;
  IF _credit <> 9999 THEN
    RAISE EXCEPTION 'PROOF FAILED [top-up]: paying the top-up granted % of credit, not the 9,999 the visits cost', _credit;
  END IF;
  -- A full refund of the 10,824 takes back exactly the 9,999 it granted.
  PERFORM public.reverse_prepaid_credit_for_payment(
    (SELECT id FROM public.payments WHERE invoice_id = _i.id), 10824);
  SELECT COALESCE(SUM(delta_cents), 0) INTO _credit FROM public.credit_ledger WHERE invoice_id = _i.id;
  IF _credit <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [top-up refund]: % of credit left after a full refund', _credit;
  END IF;
  RAISE NOTICE 'ok: a top-up is taxed, grants the pre-tax 9,999 of credit, and a full refund takes back exactly that';
END $$;

-- ── Nobody signed in can re-price an invoice ───────────────────────────────
DO $$
BEGIN
  IF has_function_privilege('authenticated', 'public.set_invoice_totals(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.set_invoice_totals(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROOF FAILED [grants]: set_invoice_totals is callable from a session';
  END IF;
  RAISE NOTICE 'ok: set_invoice_totals is reachable only from inside the generators';
END $$;

\echo ALL SALES TAX PROOFS PASSED
ROLLBACK;
