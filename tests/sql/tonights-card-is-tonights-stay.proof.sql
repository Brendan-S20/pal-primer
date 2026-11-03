-- Tonight's card is tonight's stay (#653, R2-11), proved against a real
-- Postgres. Run by tests/tonights-card-is-tonights-stay.test.ts with
-- :migration. One transaction, ROLLED BACK at the end, the migration
-- included. Each check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- The audit case: night 2 of a stay whose invoice has $200 left on it, and a
-- December stay already invoiced ($500) with its deposit invoice ($150, part
-- of the $500) still open. The card said $850. It should say $200.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000653a01', 'owner@stay.proof.invalid'),
  ('f0000000-0000-4000-8000-000000653a02', 'sitter@stay.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000653a00', 'Stay Proof A', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00', 'owner'),
  ('f0000000-0000-4000-8000-000000653a02', '0a000000-0000-4000-8000-000000653a00', 'tech');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000653a02', '0a000000-0000-4000-8000-000000653a00',
   'f0000000-0000-4000-8000-000000653a02', 'tech', 'Sitter A', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00', 'residential', 'Stay Client');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('d0000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00',
   'c0000000-0000-4000-8000-000000653a01', '1 Elm St', 'Chicago', '60614');
INSERT INTO public.services (id, organization_id, name, service_line, price_unit, base_price_cents) VALUES
  ('5e000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00',
   'Proof overnight', 'pet_sitting', 'night', 10000);

CREATE TEMP TABLE proof_day AS
SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;

-- Tonight's stay (started yesterday) and December's (a month out).
INSERT INTO public.stays (id, organization_id, client_id, property_id, service_id, starts_on, ends_on, kind,
                          assigned_staff_id, status, deposit_cents)
SELECT x.id::uuid, '0a000000-0000-4000-8000-000000653a00', 'c0000000-0000-4000-8000-000000653a01',
       'd0000000-0000-4000-8000-000000653a01', '5e000000-0000-4000-8000-000000653a01',
       p.today + x.s, p.today + x.e, 'overnight', '5a000000-0000-4000-8000-000000653a02', 'confirmed', x.dep
  FROM proof_day p, (VALUES
    ('57000000-0000-4000-8000-000000653a01', -1, 2, NULL::integer),
    ('57000000-0000-4000-8000-000000653a02', 30, 35, 15000)
  ) AS x(id, s, e, dep);

-- Tonight's stay's plan, and an ordinary plan for the same client.
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency,
                                  price_cents, dog_count, started_on, service_id, stay_id)
SELECT x.id::uuid, '0a000000-0000-4000-8000-000000653a00', 'c0000000-0000-4000-8000-000000653a01',
       'd0000000-0000-4000-8000-000000653a01', 'residential', 'weekly', 10000, 1, p.today - 1,
       '5e000000-0000-4000-8000-000000653a01', x.stay::uuid
  FROM proof_day p, (VALUES
    ('e0000000-0000-4000-8000-000000653a01', '57000000-0000-4000-8000-000000653a01'),
    ('e0000000-0000-4000-8000-000000653a02', NULL)
  ) AS x(id, stay);

INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, scheduled_on, assigned_staff_id)
SELECT x.id::uuid, '0a000000-0000-4000-8000-000000653a00', x.sub::uuid, 'c0000000-0000-4000-8000-000000653a01',
       'd0000000-0000-4000-8000-000000653a01', p.today, '5a000000-0000-4000-8000-000000653a02'
  FROM proof_day p, (VALUES
    ('71000000-0000-4000-8000-000000653a01', 'e0000000-0000-4000-8000-000000653a01'),
    ('71000000-0000-4000-8000-000000653a02', 'e0000000-0000-4000-8000-000000653a02')
  ) AS x(id, sub);

-- Open invoices: tonight's stay $200, December's stay $500 and its deposit
-- $150, and an older ordinary invoice of $30.
INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status, issued_at) VALUES
  ('16000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00',
   'c0000000-0000-4000-8000-000000653a01', current_date, 20000, 'open', now()),
  ('16000000-0000-4000-8000-000000653a02', '0a000000-0000-4000-8000-000000653a00',
   'c0000000-0000-4000-8000-000000653a01', current_date + 35, 50000, 'open', now()),
  ('16000000-0000-4000-8000-000000653a03', '0a000000-0000-4000-8000-000000653a00',
   'c0000000-0000-4000-8000-000000653a01', current_date, 15000, 'open', now()),
  ('16000000-0000-4000-8000-000000653a04', '0a000000-0000-4000-8000-000000653a00',
   'c0000000-0000-4000-8000-000000653a01', current_date - 20, 3000, 'open', now() - interval '20 days');
UPDATE public.stays SET invoice_id = '16000000-0000-4000-8000-000000653a01'
 WHERE id = '57000000-0000-4000-8000-000000653a01';
UPDATE public.stays SET invoice_id = '16000000-0000-4000-8000-000000653a02',
                        deposit_invoice_id = '16000000-0000-4000-8000-000000653a03'
 WHERE id = '57000000-0000-4000-8000-000000653a02';

-- ── As the sitter ───────────────────────────────────────────────────────────
DO $jwt$ BEGIN PERFORM set_config('request.jwt.claims',
  '{"sub": "f0000000-0000-4000-8000-000000653a02", "role": "authenticated", "aal": "aal2"}', true); END $jwt$;
SET LOCAL ROLE authenticated;

DO $p$
DECLARE _night bigint; _plain bigint;
BEGIN
  SELECT open_balance_cents INTO _night
    FROM public.my_day_stop_facts(ARRAY['71000000-0000-4000-8000-000000653a01'::uuid]);
  IF _night IS DISTINCT FROM 20000 THEN
    RAISE EXCEPTION 'PROOF FAILED [night]: tonight''s card says % cents, expected 20000 (this stay only)', _night;
  END IF;
  RAISE NOTICE 'ok: a night of a stay shows that stay''s balance ($200, not $850)';

  SELECT open_balance_cents INTO _plain
    FROM public.my_day_stop_facts(ARRAY['71000000-0000-4000-8000-000000653a02'::uuid]);
  IF _plain IS DISTINCT FROM 23000 THEN
    RAISE EXCEPTION 'PROOF FAILED [plain]: an ordinary visit shows % cents, expected 23000 (no December stay, no deposit)', _plain;
  END IF;
  RAISE NOTICE 'ok: an ordinary visit leaves out a stay still to come and every stay deposit';
END
$p$;

-- Paying part of tonight's stay moves tonight's card, and only by that much.
RESET ROLE;
INSERT INTO public.payments (invoice_id, organization_id, amount_cents, currency, status, paid_at, method) VALUES
  ('16000000-0000-4000-8000-000000653a01', '0a000000-0000-4000-8000-000000653a00', 5000, 'usd',
   'succeeded', now(), 'cash');
SET LOCAL ROLE authenticated;
DO $p$
DECLARE _night bigint;
BEGIN
  SELECT open_balance_cents INTO _night
    FROM public.my_day_stop_facts(ARRAY['71000000-0000-4000-8000-000000653a01'::uuid]);
  IF _night IS DISTINCT FROM 15000 THEN
    RAISE EXCEPTION 'PROOF FAILED [paid]: % cents after $50 paid, expected 15000', _night;
  END IF;
  RAISE NOTICE 'ok: the card is the stay invoice''s balance, net of what is paid on it';
END
$p$;

RESET ROLE;
ROLLBACK;

\echo ALL TONIGHTS-STAY PROOFS PASSED
