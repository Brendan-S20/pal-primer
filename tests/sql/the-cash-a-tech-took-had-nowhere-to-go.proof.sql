-- The field-collection rules, proved against a real Postgres rather than read
-- off the migration's text. Run by
-- tests/a-tech-records-cash-and-the-office-applies-it.test.ts, which passes
-- the migration's path as :migration and the one that gave payments a method
-- as :methods (it is re-applied here because a local stack can predate it;
-- it is idempotent, so on a fully migrated database it changes nothing).
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a column or a row behind. Each group prints
-- "ok: ..." only when every check in it passed, or raises "PROOF FAILED
-- [...]", and ON_ERROR_STOP turns the first failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\i :methods
\i :migration

-- ── Fixture ─────────────────────────────────────────────────────────────────
-- Org A: Olivia (owner), Mo (office manager, has muted field_collection),
-- Max (office manager), Dee (dispatcher), Sam (tech) and Priya (tech).
-- Org B: Bea (owner), Omar (tech).
-- Client A1 owes $25 + $15 = $40 on two open invoices, has a paid one, and
-- last paid in cash. Client A2 owes $5 and is somebody else. The invoices the
-- office must NOT be able to pick are all smaller than the collection, so
-- each refusal below is its own rule and not the amount check in disguise.
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('a2000000-0000-4000-8000-00000000a001', 'olivia-a@cash.proof.invalid'),
  ('a2000000-0000-4000-8000-00000000a002', 'mo-a@cash.proof.invalid'),
  ('a2000000-0000-4000-8000-00000000a003', 'max-a@cash.proof.invalid'),
  ('a2000000-0000-4000-8000-00000000a004', 'dee-a@cash.proof.invalid'),
  ('a2000000-0000-4000-8000-00000000a005', 'sam-a@cash.proof.invalid'),
  ('a2000000-0000-4000-8000-00000000a006', 'priya-a@cash.proof.invalid'),
  ('b2000000-0000-4000-8000-00000000b001', 'bea-b@cash.proof.invalid'),
  ('b2000000-0000-4000-8000-00000000b002', 'omar-b@cash.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a200000-0000-4000-8000-0000000000aa', 'Cash Proof A', 'America/Chicago'),
  ('0b200000-0000-4000-8000-0000000000bb', 'Cash Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a2000000-0000-4000-8000-00000000a001', '0a200000-0000-4000-8000-0000000000aa', 'owner'),
  ('a2000000-0000-4000-8000-00000000a002', '0a200000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('a2000000-0000-4000-8000-00000000a003', '0a200000-0000-4000-8000-0000000000aa', 'office_manager'),
  ('a2000000-0000-4000-8000-00000000a004', '0a200000-0000-4000-8000-0000000000aa', 'dispatcher'),
  ('a2000000-0000-4000-8000-00000000a005', '0a200000-0000-4000-8000-0000000000aa', 'tech'),
  ('a2000000-0000-4000-8000-00000000a006', '0a200000-0000-4000-8000-0000000000aa', 'tech'),
  ('b2000000-0000-4000-8000-00000000b001', '0b200000-0000-4000-8000-0000000000bb', 'owner'),
  ('b2000000-0000-4000-8000-00000000b002', '0b200000-0000-4000-8000-0000000000bb', 'tech');

INSERT INTO public.app_notification_prefs (user_id, muted_types) VALUES
  ('a2000000-0000-4000-8000-00000000a002', ARRAY['field_collection']);

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('5c000000-0000-4000-8000-000000000005', '0a200000-0000-4000-8000-0000000000aa',
   'a2000000-0000-4000-8000-00000000a005', 'tech', 'Sam Rivera'),
  ('5c000000-0000-4000-8000-000000000006', '0a200000-0000-4000-8000-0000000000aa',
   'a2000000-0000-4000-8000-00000000a006', 'tech', 'Priya Patel'),
  ('5d000000-0000-4000-8000-000000000002', '0b200000-0000-4000-8000-0000000000bb',
   'b2000000-0000-4000-8000-00000000b002', 'tech', 'Omar Okafor');

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-0000000000aa', 'residential', 'Cash Customer A1'),
  ('c2000000-0000-4000-8000-0000000000a2', '0a200000-0000-4000-8000-0000000000aa', 'residential', 'Other Customer A2'),
  ('c2000000-0000-4000-8000-0000000000b1', '0b200000-0000-4000-8000-0000000000bb', 'residential', 'Customer B1');

INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code) VALUES
  ('e2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a1', '412 Elm St', 'Chicago', '60614'),
  ('e2000000-0000-4000-8000-0000000000a2', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a2', '9 Ash St', 'Chicago', '60614'),
  ('e2000000-0000-4000-8000-0000000000b1', '0b200000-0000-4000-8000-0000000000bb',
   'c2000000-0000-4000-8000-0000000000b1', '9 Oak Ave', 'Chicago', '60657');

INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count) VALUES
  ('d2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 3),
  -- One visit per subscription per day, so the other same-day stops on this
  -- customer's yard each ride their own.
  ('d2000000-0000-4000-8000-0000000000a3', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 3),
  ('d2000000-0000-4000-8000-0000000000a4', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 3),
  ('d2000000-0000-4000-8000-0000000000a5', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', 'residential', 'weekly', 2500, 3),
  ('d2000000-0000-4000-8000-0000000000a2', '0a200000-0000-4000-8000-0000000000aa',
   'c2000000-0000-4000-8000-0000000000a2', 'e2000000-0000-4000-8000-0000000000a2', 'residential', 'weekly', 3000, 1),
  ('d2000000-0000-4000-8000-0000000000b1', '0b200000-0000-4000-8000-0000000000bb',
   'c2000000-0000-4000-8000-0000000000b1', 'e2000000-0000-4000-8000-0000000000b1', 'residential', 'weekly', 2400, 2);

-- Today in Chicago, the org's day, not the server's.
CREATE TEMP TABLE proof_day ON COMMIT DROP AS
  SELECT (now() AT TIME ZONE 'America/Chicago')::date AS today;
GRANT SELECT ON proof_day TO authenticated, anon;

-- A1: Sam's, today.             A2: Priya's, today, same client.
-- A3: nobody's, today.          A4: Sam's, ten days ago.
-- A5: Sam's, tomorrow.          A6: Sam's, today, canceled.
-- A7: Sam's, today, client A2.  B1: Omar's, today, org B.
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, assigned_staff_id, scheduled_on, status)
SELECT x.id::uuid, x.org::uuid, x.sub::uuid, x.client::uuid, x.prop::uuid, x.staff::uuid, d.today + x.offs, x.status::public.visit_status
  FROM proof_day d, (VALUES
  ('f2000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a1',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', '5c000000-0000-4000-8000-000000000005', 0, 'in_progress'),
  ('f2000000-0000-4000-8000-0000000000a2', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a3',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', '5c000000-0000-4000-8000-000000000006', 0, 'scheduled'),
  ('f2000000-0000-4000-8000-0000000000a3', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a4',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', NULL, 0, 'scheduled'),
  ('f2000000-0000-4000-8000-0000000000a4', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a1',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', '5c000000-0000-4000-8000-000000000005', -10, 'completed'),
  ('f2000000-0000-4000-8000-0000000000a5', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a1',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', '5c000000-0000-4000-8000-000000000005', 1, 'scheduled'),
  ('f2000000-0000-4000-8000-0000000000a6', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a5',
   'c2000000-0000-4000-8000-0000000000a1', 'e2000000-0000-4000-8000-0000000000a1', '5c000000-0000-4000-8000-000000000005', 0, 'canceled'),
  ('f2000000-0000-4000-8000-0000000000a7', '0a200000-0000-4000-8000-0000000000aa', 'd2000000-0000-4000-8000-0000000000a2',
   'c2000000-0000-4000-8000-0000000000a2', 'e2000000-0000-4000-8000-0000000000a2', '5c000000-0000-4000-8000-000000000005', 0, 'scheduled'),
  ('f2000000-0000-4000-8000-0000000000b1', '0b200000-0000-4000-8000-0000000000bb', 'd2000000-0000-4000-8000-0000000000b1',
   'c2000000-0000-4000-8000-0000000000b1', 'e2000000-0000-4000-8000-0000000000b1', '5d000000-0000-4000-8000-000000000002', 0, 'scheduled')
  ) AS x(id, org, sub, client, prop, staff, offs, status);

INSERT INTO public.invoices (id, organization_id, client_id, period_end, total_cents, status) VALUES
  ('12000000-0000-4000-8000-0000000000a1', '0a200000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000a1', current_date - 30, 2500, 'open'),
  ('12000000-0000-4000-8000-0000000000a2', '0a200000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000a1', current_date - 2, 1500, 'open'),
  ('12000000-0000-4000-8000-0000000000a3', '0a200000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000a1', current_date - 60, 500, 'paid'),
  ('12000000-0000-4000-8000-0000000000a9', '0a200000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000a2', current_date - 2, 500, 'open'),
  ('12000000-0000-4000-8000-0000000000b1', '0b200000-0000-4000-8000-0000000000bb', 'c2000000-0000-4000-8000-0000000000b1', current_date - 2, 500, 'open');
INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, paid_at, method) VALUES
  ('0a200000-0000-4000-8000-0000000000aa', '12000000-0000-4000-8000-0000000000a3', 500, 'succeeded', now() - interval '40 days', 'cash');
SET LOCAL app.allow_protected_org_write = '';

-- ── Sam records on his own visit, once ──────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _id uuid; _again uuid; _third uuid; _n int; _row record;
BEGIN
  _id := public.record_field_collection('f2000000-0000-4000-8000-0000000000a1', 1500, 'check', ' 1042 ',
                                        '99000000-0000-4000-8000-000000000001', now() - interval '20 minutes');
  IF _id IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [record]: no id came back'; END IF;
  SELECT * INTO _row FROM public.field_collections WHERE id = _id;
  IF _row.id IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [own read]: Sam cannot read the collection he recorded'; END IF;
  IF _row.status <> 'awaiting_confirmation' OR _row.reference <> '1042' OR _row.amount_cents <> 1500
     OR _row.collected_by_staff_id <> '5c000000-0000-4000-8000-000000000005'
     OR _row.collected_at > now() - interval '19 minutes' THEN
    RAISE EXCEPTION 'PROOF FAILED [record]: stored %', row_to_json(_row);
  END IF;

  -- A double tap with no key: same visit, amount and method, seconds apart.
  _third := public.record_field_collection('f2000000-0000-4000-8000-0000000000a1', 1500, 'check', NULL, NULL);
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _third <> _id OR _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [double tap]: % rows, ids % %', _n, _id, _third;
  END IF;
END $$;
RESET ROLE;

-- An hour on, past the double-tap window, so only the key can recognise it:
-- the replay of a request that landed long ago, from a queue that sat in a
-- pocket.
UPDATE public.field_collections SET created_at = now() - interval '1 hour';
SET ROLE authenticated;
DO $$
DECLARE _id uuid := (SELECT id FROM public.field_collections); _again uuid; _n int;
BEGIN
  _again := public.record_field_collection('f2000000-0000-4000-8000-0000000000a1', 1500, 'check', '1042',
                                           '99000000-0000-4000-8000-000000000001');
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _again IS DISTINCT FROM _id OR _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [key]: % rows, ids % %', _n, _id, _again;
  END IF;
  RAISE NOTICE 'ok: the assigned tech records a collection on his own visit, and a replay or a double tap is the same one';
END $$;
RESET ROLE;

-- Who was told.
DO $$
DECLARE _who uuid[];
BEGIN
  SELECT array_agg(recipient_user_id ORDER BY recipient_user_id) INTO _who
    FROM public.app_notifications WHERE type = 'field_collection'
     AND organization_id = '0a200000-0000-4000-8000-0000000000aa';
  IF _who IS DISTINCT FROM ARRAY['a2000000-0000-4000-8000-00000000a001', 'a2000000-0000-4000-8000-00000000a003']::uuid[] THEN
    RAISE EXCEPTION 'PROOF FAILED [notify]: told %, expected the owner and the unmuted office manager, once each', _who;
  END IF;
  IF EXISTS (SELECT 1 FROM public.app_notifications WHERE type = 'field_collection'
              AND title NOT LIKE 'Sam Rivera collected $15.00 (check #1042)') THEN
    RAISE EXCEPTION 'PROOF FAILED [notify]: the notification does not say who, how much and how';
  END IF;
  RAISE NOTICE 'ok: the owner and office managers are told once, and a muted office manager is not';
END $$;

-- ── Sam is refused everywhere else ──────────────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _case record; _n int;
BEGIN
  FOR _case IN SELECT * FROM (VALUES
    ('another tech''s visit', 'f2000000-0000-4000-8000-0000000000a2'::uuid, 500, 'cash'),
    ('an unassigned visit',   'f2000000-0000-4000-8000-0000000000a3'::uuid, 500, 'cash'),
    ('ten days ago',          'f2000000-0000-4000-8000-0000000000a4'::uuid, 500, 'cash'),
    ('tomorrow',              'f2000000-0000-4000-8000-0000000000a5'::uuid, 500, 'cash'),
    ('a canceled visit',      'f2000000-0000-4000-8000-0000000000a6'::uuid, 500, 'cash'),
    ('another org',           'f2000000-0000-4000-8000-0000000000b1'::uuid, 500, 'cash'),
    ('no such visit',         'f2000000-0000-4000-8000-0000000000ff'::uuid, 500, 'cash'),
    ('zero',                  'f2000000-0000-4000-8000-0000000000a1'::uuid, 0, 'cash'),
    ('negative',              'f2000000-0000-4000-8000-0000000000a1'::uuid, -100, 'cash'),
    -- $40 owed, $15 already waiting: $25.01 is a cent too many.
    ('more than is owed',     'f2000000-0000-4000-8000-0000000000a1'::uuid, 2501, 'cash'),
    ('venmo',                 'f2000000-0000-4000-8000-0000000000a1'::uuid, 500, 'venmo')
  ) AS t(label, visit, amount, method)
  LOOP
    _err := NULL;
    BEGIN
      PERFORM public.record_field_collection(_case.visit, _case.amount, _case.method);
    EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
    END;
    IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [refuse]: Sam recorded on %', _case.label; END IF;
  END LOOP;

  -- The remaining $25.00 exactly is fine, with the key reused on another
  -- visit refused.
  _err := NULL;
  BEGIN
    PERFORM public.record_field_collection('f2000000-0000-4000-8000-0000000000a7', 500, 'cash', NULL,
                                           '99000000-0000-4000-8000-000000000001');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [key]: a key from one visit answered for another'; END IF;
  -- With a phone clock three days fast, which is not believed.
  PERFORM public.record_field_collection('f2000000-0000-4000-8000-0000000000a1', 2500, 'cash', NULL, NULL,
                                         now() + interval '3 days');
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _n <> 2 THEN RAISE EXCEPTION 'PROOF FAILED [bound]: % rows after the exact remainder', _n; END IF;
  IF (SELECT collected_at FROM public.field_collections WHERE amount_cents = 2500) > now() THEN
    RAISE EXCEPTION 'PROOF FAILED [clock]: a collection was dated in the future from the phone''s clock';
  END IF;
  RAISE NOTICE 'ok: not another tech''s, unassigned, out of the window, canceled, another org''s, zero, over the balance or not cash/check';
END $$;

-- Sam cannot reach the money by any other door.
DO $$
DECLARE _err text; _n int;
BEGIN
  UPDATE public.invoices SET status = 'paid' WHERE client_id = 'c2000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [invoices]: Sam marked % invoices paid', _n; END IF;
  BEGIN
    INSERT INTO public.payments (organization_id, invoice_id, amount_cents, status, method)
    VALUES ('0a200000-0000-4000-8000-0000000000aa', '12000000-0000-4000-8000-0000000000a1', 2500, 'succeeded', 'cash');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [payments]: Sam inserted a payment'; END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.field_collections (organization_id, client_id, amount_cents, method, status, decided_at)
    VALUES ('0a200000-0000-4000-8000-0000000000aa', 'c2000000-0000-4000-8000-0000000000a1', 100, 'cash', 'confirmed', now());
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [table insert]: Sam wrote field_collections directly'; END IF;
  _err := NULL;
  BEGIN
    UPDATE public.field_collections SET status = 'rejected', decided_at = now();
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [table update]: Sam updated field_collections directly'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.confirm_field_collection(
      (SELECT id FROM public.field_collections WHERE amount_cents = 1500),
      ARRAY['12000000-0000-4000-8000-0000000000a2']::uuid[]);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [confirm]: Sam confirmed his own collection'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.reject_field_collection((SELECT id FROM public.field_collections WHERE amount_cents = 1500));
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [reject]: Sam rejected a collection'; END IF;
  SELECT count(*) INTO _n FROM public.invoices WHERE status = 'paid';
  RAISE NOTICE 'ok: a tech cannot mark an invoice paid, insert a payment, write the table, or confirm or reject';
END $$;

-- What his card is told, and only about his own stops.
DO $$
DECLARE _f record; _n int;
BEGIN
  SELECT * INTO _f FROM public.my_day_stop_facts(ARRAY['f2000000-0000-4000-8000-0000000000a1']::uuid[]);
  IF _f.visit_id IS NULL OR _f.dog_count <> 3 OR _f.open_balance_cents <> 4000 OR _f.awaiting_cents <> 4000
     OR NOT _f.pays_cash_check OR _f.autopay THEN
    RAISE EXCEPTION 'PROOF FAILED [facts]: %', row_to_json(_f);
  END IF;
  SELECT count(*) INTO _n FROM public.my_day_stop_facts(ARRAY[
    'f2000000-0000-4000-8000-0000000000a2', 'f2000000-0000-4000-8000-0000000000a3',
    'f2000000-0000-4000-8000-0000000000b1']::uuid[]);
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [facts reach]: Sam was told about % stops that are not his', _n; END IF;
  RAISE NOTICE 'ok: a tech''s card hears the dog count, how the customer pays and what is owed, for his own stops only';
END $$;
RESET ROLE;

-- ── Priya, Omar and anon see nothing of it ──────────────────────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a006","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [colleague]: Priya reads % of Sam''s collections', _n; END IF;
END $$;
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _n int; _err text;
BEGIN
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [other org]: org B''s owner reads % of org A''s', _n; END IF;
  BEGIN
    PERFORM public.confirm_field_collection((SELECT '00000000-0000-4000-8000-000000000000'::uuid));
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [other org]: confirm answered for a missing id'; END IF;
END $$;
RESET ROLE;
-- Org B's owner, handed org A's id, which RLS hides from him: still refused.
DO $$
DECLARE _id uuid := (SELECT id FROM public.field_collections WHERE amount_cents = 1500); _err text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"b2000000-0000-4000-8000-00000000b001","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.confirm_field_collection(_id, '{}');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  RESET ROLE;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [other org]: org B''s owner confirmed org A''s collection'; END IF;
END $$;
SELECT set_config('request.jwt.claims', '{}', true);
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM count(*) FROM public.field_collections;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon read field_collections'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.record_field_collection('f2000000-0000-4000-8000-0000000000a1', 100, 'cash');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon executed record_field_collection'; END IF;
  _err := NULL;
  BEGIN
    PERFORM * FROM public.my_day_stop_facts(ARRAY['f2000000-0000-4000-8000-0000000000a1']::uuid[]);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [anon]: anon executed my_day_stop_facts'; END IF;
  RAISE NOTICE 'ok: another tech, another org and anon can read none of it and decide none of it';
END $$;
RESET ROLE;

-- ── The dispatcher previews the day but cannot decide money ─────────────────
SELECT set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a004","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _err text; _n int;
BEGIN
  SELECT count(*) INTO _n FROM public.my_day_stop_facts(ARRAY['f2000000-0000-4000-8000-0000000000a1']::uuid[]);
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [preview]: the dispatcher''s preview got % rows', _n; END IF;
  SELECT count(*) INTO _n FROM public.field_collections;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [dispatcher read]: the dispatcher reads % collections', _n; END IF;
  BEGIN
    PERFORM public.confirm_field_collection(
      (SELECT '00000000-0000-4000-8000-000000000001'::uuid), '{}');
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [dispatcher]: confirm did not refuse'; END IF;
END $$;
RESET ROLE;
DO $$
DECLARE _id uuid := (SELECT id FROM public.field_collections WHERE amount_cents = 1500); _err text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a004","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.confirm_field_collection(_id, ARRAY['12000000-0000-4000-8000-0000000000a2']::uuid[]);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  RESET ROLE;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [dispatcher]: the dispatcher confirmed a collection'; END IF;
  RAISE NOTICE 'ok: a dispatcher previews the stop''s facts and cannot confirm a collection';
END $$;

-- ── The office confirms, once, against the right invoices ──────────────────
DO $$
DECLARE
  _check uuid := (SELECT id FROM public.field_collections WHERE amount_cents = 1500);
  _cash uuid := (SELECT id FROM public.field_collections WHERE amount_cents = 2500);
  _err text; _case record; _out jsonb; _row record;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a003","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  FOR _case IN SELECT * FROM (VALUES
    ('another customer''s invoice', ARRAY['12000000-0000-4000-8000-0000000000a9']::uuid[], 'open invoices'),
    ('a paid invoice',              ARRAY['12000000-0000-4000-8000-0000000000a3']::uuid[], 'open invoices'),
    ('another org''s invoice',      ARRAY['12000000-0000-4000-8000-0000000000b1']::uuid[], 'open invoices'),
    ('more than was collected',     ARRAY['12000000-0000-4000-8000-0000000000a1']::uuid[], 'more than was collected')
  ) AS t(label, ids, says)
  LOOP
    _err := NULL;
    BEGIN
      PERFORM public.confirm_field_collection(_check, _case.ids);
    EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
    END;
    IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [confirm]: confirmed against %', _case.label; END IF;
    IF position(_case.says IN _err) = 0 THEN
      RAISE EXCEPTION 'PROOF FAILED [confirm]: % was refused for the wrong reason: %', _case.label, _err;
    END IF;
  END LOOP;

  _out := public.confirm_field_collection(_check, ARRAY['12000000-0000-4000-8000-0000000000a2']::uuid[]);
  IF (_out->>'applied_cents')::int <> 1500 OR _out->>'method' <> 'check' OR _out->>'reference' <> '1042'
     OR _out->'invoice_ids' <> '["12000000-0000-4000-8000-0000000000a2"]'::jsonb THEN
    RAISE EXCEPTION 'PROOF FAILED [confirm]: returned %', _out;
  END IF;

  -- Twice is once.
  _err := NULL;
  BEGIN
    PERFORM public.confirm_field_collection(_check, ARRAY['12000000-0000-4000-8000-0000000000a2']::uuid[]);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [once]: the same collection was confirmed twice'; END IF;
  _err := NULL;
  BEGIN
    PERFORM public.reject_field_collection(_check, 'changed my mind');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN RAISE EXCEPTION 'PROOF FAILED [once]: a confirmed collection was rejected after'; END IF;

  -- The cash that settles no whole invoice by itself can be rejected.
  PERFORM public.reject_field_collection(_cash, '  Customer paid by card instead  ');
  RESET ROLE;

  SELECT status, applied_cents, decided_by_user_id INTO _row FROM public.field_collections WHERE id = _check;
  IF _row.status <> 'confirmed' OR _row.applied_cents <> 1500
     OR _row.decided_by_user_id <> 'a2000000-0000-4000-8000-00000000a003' THEN
    RAISE EXCEPTION 'PROOF FAILED [confirm]: stored %', row_to_json(_row);
  END IF;
  SELECT status, decision_note INTO _row FROM public.field_collections WHERE id = _cash;
  IF _row.status <> 'rejected' OR _row.decision_note <> 'Customer paid by card instead' THEN
    RAISE EXCEPTION 'PROOF FAILED [reject]: stored %', row_to_json(_row);
  END IF;
  -- The claim applies no money: that is bulkMarkInvoicesPaid's job, the path
  -- the office's own Record payment takes.
  IF EXISTS (SELECT 1 FROM public.invoices WHERE id = '12000000-0000-4000-8000-0000000000a2' AND status <> 'open')
     OR (SELECT count(*) FROM public.payments WHERE organization_id = '0a200000-0000-4000-8000-0000000000aa') <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [no bypass]: the claim wrote money itself';
  END IF;
  RAISE NOTICE 'ok: the office confirms once, only against this customer''s open invoices that the collection covers, and the claim moves no money itself';
END $$;

-- A rejected or confirmed collection no longer holds the balance.
SELECT set_config('request.jwt.claims', '{"sub":"a2000000-0000-4000-8000-00000000a005","role":"authenticated"}', true);
SET ROLE authenticated;
DO $$
DECLARE _f record;
BEGIN
  SELECT * INTO _f FROM public.my_day_stop_facts(ARRAY['f2000000-0000-4000-8000-0000000000a1']::uuid[]);
  IF _f.awaiting_cents <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [release]: % still waiting after the office decided', _f.awaiting_cents;
  END IF;
  RAISE NOTICE 'ok: once the office decides, nothing is left waiting against the balance';
END $$;
RESET ROLE;

ROLLBACK;

\echo ALL FIELD COLLECTION PROOFS PASSED
