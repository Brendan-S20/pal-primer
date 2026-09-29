-- The expense rules, proved against a real Postgres rather than read off the
-- migration's text. Run by tests/a-tech-sees-only-their-own-expenses.test.ts,
-- which passes the migration's path as :migration.
--
-- Everything happens inside one transaction that is ROLLED BACK at the end,
-- the migration included, so this can be pointed at a shared local stack
-- without leaving a table, a bucket or a row behind. Each check prints
-- "ok: ..." or raises "PROOF FAILED [...]", and ON_ERROR_STOP turns the first
-- failure into a non-zero exit.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

\i :migration

-- ── Fixture: two tenants. A has an owner, two techs and a dispatcher; B has
--    an owner and a tech. ────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('e1000000-0000-4000-8000-00000000a001', 'owner-a@expenses.proof.invalid'),
  ('e1000000-0000-4000-8000-00000000a002', 'tech1-a@expenses.proof.invalid'),
  ('e1000000-0000-4000-8000-00000000a003', 'tech2-a@expenses.proof.invalid'),
  ('e1000000-0000-4000-8000-00000000a004', 'dispatch-a@expenses.proof.invalid'),
  ('e1000000-0000-4000-8000-00000000b001', 'owner-b@expenses.proof.invalid'),
  ('e1000000-0000-4000-8000-00000000b002', 'tech-b@expenses.proof.invalid');

INSERT INTO public.organizations (id, name, timezone) VALUES
  ('e0000000-0000-4000-8000-0000000000aa', 'Expense Proof A', 'America/Chicago'),
  ('e0000000-0000-4000-8000-0000000000bb', 'Expense Proof B', 'America/Chicago');

INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('e1000000-0000-4000-8000-00000000a001', 'e0000000-0000-4000-8000-0000000000aa', 'owner'),
  ('e1000000-0000-4000-8000-00000000a002', 'e0000000-0000-4000-8000-0000000000aa', 'tech'),
  ('e1000000-0000-4000-8000-00000000a003', 'e0000000-0000-4000-8000-0000000000aa', 'tech'),
  ('e1000000-0000-4000-8000-00000000a004', 'e0000000-0000-4000-8000-0000000000aa', 'dispatcher'),
  ('e1000000-0000-4000-8000-00000000b001', 'e0000000-0000-4000-8000-0000000000bb', 'owner'),
  ('e1000000-0000-4000-8000-00000000b002', 'e0000000-0000-4000-8000-0000000000bb', 'tech');

INSERT INTO public.staff (id, organization_id, user_id, role, display_name) VALUES
  ('e2000000-0000-4000-8000-0000000000a0', 'e0000000-0000-4000-8000-0000000000aa',
   'e1000000-0000-4000-8000-00000000a001', 'owner', 'Proof Owner A'),
  ('e2000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000aa',
   'e1000000-0000-4000-8000-00000000a002', 'tech', 'Proof Tech One'),
  ('e2000000-0000-4000-8000-0000000000a2', 'e0000000-0000-4000-8000-0000000000aa',
   'e1000000-0000-4000-8000-00000000a003', 'tech', 'Proof Tech Two'),
  ('e2000000-0000-4000-8000-0000000000ad', 'e0000000-0000-4000-8000-0000000000aa',
   'e1000000-0000-4000-8000-00000000a004', 'dispatcher', 'Proof Dispatcher'),
  ('e2000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000bb',
   'e1000000-0000-4000-8000-00000000b002', 'tech', 'Proof Tech B');
SET LOCAL app.allow_protected_org_write = '';

-- Expenses written as postgres (no JWT): one per tech in A, one that is
-- nobody's in A, one in B.
INSERT INTO public.expenses (id, organization_id, staff_id, spent_on, category, amount_cents, vendor) VALUES
  ('e3000000-0000-4000-8000-0000000000a1', 'e0000000-0000-4000-8000-0000000000aa',
   'e2000000-0000-4000-8000-0000000000a1', '2026-03-14', 'fuel', 4567, 'Shell'),
  ('e3000000-0000-4000-8000-0000000000a2', 'e0000000-0000-4000-8000-0000000000aa',
   'e2000000-0000-4000-8000-0000000000a2', '2026-03-15', 'disposal', 2500, 'County transfer station'),
  ('e3000000-0000-4000-8000-0000000000a3', 'e0000000-0000-4000-8000-0000000000aa',
   NULL, '2026-03-16', 'supplies', 1999, 'Bag supplier'),
  ('e3000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000bb',
   'e2000000-0000-4000-8000-0000000000b1', '2026-03-14', 'fuel', 3000, 'BP');

-- ── The rate snapshot ───────────────────────────────────────────────────────
-- The client's rate and amount are not believed: 12.3 mi at the org's 72.50
-- is 891.75, which rounds half away from zero to 892.
INSERT INTO public.expenses (id, organization_id, staff_id, spent_on, category, amount_cents,
                             miles, mileage_rate_cents)
VALUES ('e3000000-0000-4000-8000-00000000c001', 'e0000000-0000-4000-8000-0000000000aa',
        'e2000000-0000-4000-8000-0000000000a1', '2026-03-17', 'mileage', 1, 12.3, 1);

DO $$
DECLARE _r record; _err text;
BEGIN
  SELECT amount_cents, mileage_rate_cents, miles INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  IF _r.mileage_rate_cents <> 72.50 OR _r.amount_cents <> 892 THEN
    RAISE EXCEPTION 'PROOF FAILED [mileage price]: 12.3 mi stored as % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;

  -- The org changes its rate. The logged trip does not move...
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET mileage_rate_cents = 80
   WHERE id = 'e0000000-0000-4000-8000-0000000000aa';
  PERFORM set_config('app.allow_protected_org_write', '', true);
  SELECT amount_cents, mileage_rate_cents INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  IF _r.mileage_rate_cents <> 72.50 OR _r.amount_cents <> 892 THEN
    RAISE EXCEPTION 'PROOF FAILED [snapshot]: an org rate change repriced a logged trip to % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;

  -- ...editing its miles prices them at ITS rate, not today's...
  UPDATE public.expenses SET miles = 10 WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  SELECT amount_cents, mileage_rate_cents INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  IF _r.mileage_rate_cents <> 72.50 OR _r.amount_cents <> 725 THEN
    RAISE EXCEPTION 'PROOF FAILED [snapshot on edit]: 10 mi re-priced as % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;

  -- ...and nobody can write a different rate onto it.
  UPDATE public.expenses SET mileage_rate_cents = 99, amount_cents = 5
   WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  SELECT amount_cents, mileage_rate_cents INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c001';
  IF _r.mileage_rate_cents <> 72.50 OR _r.amount_cents <> 725 THEN
    RAISE EXCEPTION 'PROOF FAILED [forged rate]: stored % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;

  -- A new trip takes the new rate.
  INSERT INTO public.expenses (id, organization_id, staff_id, spent_on, category, amount_cents, miles)
  VALUES ('e3000000-0000-4000-8000-00000000c002', 'e0000000-0000-4000-8000-0000000000aa',
          'e2000000-0000-4000-8000-0000000000a1', '2026-03-18', 'mileage', 1, 10);
  SELECT amount_cents, mileage_rate_cents INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c002';
  IF _r.mileage_rate_cents <> 80 OR _r.amount_cents <> 800 THEN
    RAISE EXCEPTION 'PROOF FAILED [new rate]: 10 mi stored as % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;

  -- A row that becomes mileage takes today's rate; one that stops being
  -- mileage sheds its miles and rate.
  UPDATE public.expenses SET category = 'mileage', miles = 5
   WHERE id = 'e3000000-0000-4000-8000-0000000000a3';
  SELECT amount_cents, mileage_rate_cents INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-0000000000a3';
  IF _r.mileage_rate_cents <> 80 OR _r.amount_cents <> 400 THEN
    RAISE EXCEPTION 'PROOF FAILED [became mileage]: % at %', _r.amount_cents, _r.mileage_rate_cents;
  END IF;
  UPDATE public.expenses SET category = 'supplies', amount_cents = 1999
   WHERE id = 'e3000000-0000-4000-8000-0000000000a3';
  SELECT amount_cents, mileage_rate_cents, miles INTO _r
    FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-0000000000a3';
  IF _r.miles IS NOT NULL OR _r.mileage_rate_cents IS NOT NULL OR _r.amount_cents <> 1999 THEN
    RAISE EXCEPTION 'PROOF FAILED [stopped being mileage]: %', row_to_json(_r);
  END IF;

  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000aa', NULL, '2026-03-18', 'mileage', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%needs the miles%' THEN
    RAISE EXCEPTION 'PROOF FAILED [mileage without miles]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: mileage is priced by the database at the rate stored on the row, and a rate change reprices nothing';
END $$;

-- ── Tenancy of the row itself ───────────────────────────────────────────────
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000aa', 'e2000000-0000-4000-8000-0000000000b1',
            '2026-03-18', 'fuel', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%not in this organization%' THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant staff]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.expenses (organization_id, spent_on, category, amount_cents, receipt_path)
    VALUES ('e0000000-0000-4000-8000-0000000000aa', '2026-03-18', 'fuel', 100,
            'e0000000-0000-4000-8000-0000000000bb/office/x.jpg');
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%expenses_receipt_in_org_folder%' THEN
    RAISE EXCEPTION 'PROOF FAILED [receipt in another org''s folder]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    UPDATE public.expenses SET organization_id = 'e0000000-0000-4000-8000-0000000000bb'
     WHERE id = 'e3000000-0000-4000-8000-0000000000a3';
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%cannot be moved%' THEN
    RAISE EXCEPTION 'PROOF FAILED [moved between orgs]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: an expense cannot name another tenant''s staff, file a receipt in another tenant''s folder, or move tenant';
END $$;

-- ── Tech one ────────────────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _ids uuid[]; _n int; _err text;
BEGIN
  SELECT array_agg(id ORDER BY id) INTO _ids FROM public.expenses;
  IF _ids IS DISTINCT FROM ARRAY[
       'e3000000-0000-4000-8000-0000000000a1', 'e3000000-0000-4000-8000-00000000c001',
       'e3000000-0000-4000-8000-00000000c002']::uuid[] THEN
    RAISE EXCEPTION 'PROOF FAILED [tech reads]: tech one sees %', _ids;
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses
              WHERE id IN ('e3000000-0000-4000-8000-0000000000a2', 'e3000000-0000-4000-8000-0000000000a3',
                           'e3000000-0000-4000-8000-0000000000b1')) THEN
    RAISE EXCEPTION 'PROOF FAILED [tech reads]: tech one sees another tech''s, the office''s or another org''s expense';
  END IF;
  RAISE NOTICE 'ok: a tech reads their own expenses and nobody else''s, in their org or any other';

  -- Their own: yes.
  INSERT INTO public.expenses (id, organization_id, staff_id, spent_on, category, amount_cents)
  VALUES ('e3000000-0000-4000-8000-00000000c003', 'e0000000-0000-4000-8000-0000000000aa',
          'e2000000-0000-4000-8000-0000000000a1', '2026-03-19', 'supplies', 1234);
  UPDATE public.expenses SET amount_cents = 1300 WHERE id = 'e3000000-0000-4000-8000-00000000c003';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [tech edits own]: % rows', _n;
  END IF;
  IF (SELECT created_by FROM public.expenses WHERE id = 'e3000000-0000-4000-8000-00000000c003')
       IS DISTINCT FROM 'e1000000-0000-4000-8000-00000000a002'::uuid THEN
    RAISE EXCEPTION 'PROOF FAILED [created_by]: not the signed-in tech';
  END IF;

  -- Another tech's, the office's, another org's: no.
  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000aa', 'e2000000-0000-4000-8000-0000000000a2',
            '2026-03-19', 'fuel', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech files for another tech]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000aa', NULL, '2026-03-19', 'fuel', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech files for nobody]: %', COALESCE(_err, 'accepted');
  END IF;
  _err := NULL;
  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000bb', 'e2000000-0000-4000-8000-0000000000b1',
            '2026-03-19', 'fuel', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech files in another org]: %', COALESCE(_err, 'accepted');
  END IF;

  UPDATE public.expenses SET amount_cents = 1 WHERE id = 'e3000000-0000-4000-8000-0000000000a2';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tech edits another tech''s]: % rows', _n;
  END IF;
  DELETE FROM public.expenses
   WHERE id IN ('e3000000-0000-4000-8000-0000000000a2', 'e3000000-0000-4000-8000-0000000000b1');
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tech deletes another''s]: % rows', _n;
  END IF;

  _err := NULL;
  BEGIN
    UPDATE public.expenses SET staff_id = 'e2000000-0000-4000-8000-0000000000a2'
     WHERE id = 'e3000000-0000-4000-8000-00000000c003';
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
    RAISE EXCEPTION 'PROOF FAILED [tech hands own row to another tech]: %', COALESCE(_err, 'accepted');
  END IF;
  RAISE NOTICE 'ok: a tech writes their own expenses and cannot write, move or delete anybody else''s';
END $$;
RESET ROLE;

-- ── Tech two and the dispatcher ─────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a003","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _ids uuid[];
BEGIN
  SELECT array_agg(id) INTO _ids FROM public.expenses;
  IF _ids IS DISTINCT FROM ARRAY['e3000000-0000-4000-8000-0000000000a2']::uuid[] THEN
    RAISE EXCEPTION 'PROOF FAILED [tech two reads]: %', _ids;
  END IF;
END $$;
RESET ROLE;

SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a004","role":"authenticated"}';
SET ROLE authenticated;
DO $$
BEGIN
  -- A dispatcher is not the office for money: no view_financials, so only
  -- their own, and they have none.
  IF EXISTS (SELECT 1 FROM public.expenses) THEN
    RAISE EXCEPTION 'PROOF FAILED [dispatcher reads]: a dispatcher sees the org''s expenses';
  END IF;
  RAISE NOTICE 'ok: a second tech and a dispatcher each see only their own';
END $$;
RESET ROLE;

-- ── The office ──────────────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _n int; _err text;
BEGIN
  SELECT count(*) INTO _n FROM public.expenses
   WHERE organization_id = 'e0000000-0000-4000-8000-0000000000aa';
  IF _n <> 6 THEN
    RAISE EXCEPTION 'PROOF FAILED [office reads]: owner A sees % of A''s 6 expenses', _n;
  END IF;
  IF EXISTS (SELECT 1 FROM public.expenses WHERE organization_id = 'e0000000-0000-4000-8000-0000000000bb') THEN
    RAISE EXCEPTION 'PROOF FAILED [office reads]: owner A sees org B''s expenses';
  END IF;

  -- For anybody on the team, and for nobody in particular.
  INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
  VALUES ('e0000000-0000-4000-8000-0000000000aa', 'e2000000-0000-4000-8000-0000000000a2',
          '2026-03-20', 'equipment', 25000),
         ('e0000000-0000-4000-8000-0000000000aa', NULL, '2026-03-20', 'other', 100);
  UPDATE public.expenses SET amount_cents = 2600 WHERE id = 'e3000000-0000-4000-8000-0000000000a2';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [office edits]: % rows', _n;
  END IF;

  BEGIN
    INSERT INTO public.expenses (organization_id, staff_id, spent_on, category, amount_cents)
    VALUES ('e0000000-0000-4000-8000-0000000000bb', NULL, '2026-03-20', 'fuel', 100);
  EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
  END;
  IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
    RAISE EXCEPTION 'PROOF FAILED [office writes another org]: %', COALESCE(_err, 'accepted');
  END IF;
  UPDATE public.expenses SET amount_cents = 1 WHERE id = 'e3000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [office edits another org]: % rows', _n;
  END IF;
  RAISE NOTICE 'ok: the office reads and writes every expense in its org and none in another';
END $$;
RESET ROLE;

-- ── anon ────────────────────────────────────────────────────────────────────
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SET ROLE anon;
DO $$
DECLARE _err text;
BEGIN
  BEGIN
    PERFORM 1 FROM public.expenses;
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon can select from expenses';
  END IF;
  _err := NULL;
  BEGIN
    PERFORM public.can_use_expense_receipt('x/y.jpg', false);
  EXCEPTION WHEN insufficient_privilege THEN _err := SQLERRM;
  END;
  IF _err IS NULL THEN
    RAISE EXCEPTION 'PROOF FAILED [anon]: anon can call can_use_expense_receipt';
  END IF;
  RAISE NOTICE 'ok: anon can neither read expenses nor ask the receipt helper anything';
END $$;
RESET ROLE;

-- ── Receipts ────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'expense-receipts' AND NOT public) THEN
    RAISE EXCEPTION 'PROOF FAILED [bucket]: expense-receipts is missing or public';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'storage' AND tablename = 'objects'
         AND COALESCE(qual, '') || COALESCE(with_check, '') LIKE '%expense-receipts%') <> 4 THEN
    RAISE EXCEPTION 'PROOF FAILED [bucket policies]: expected four storage policies for expense-receipts';
  END IF;
END $$;

-- Tech one files into their own folder, and nowhere else.
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _err text; _bad text;
BEGIN
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('expense-receipts',
     'e0000000-0000-4000-8000-0000000000aa/e2000000-0000-4000-8000-0000000000a1/e3000000-0000-4000-8000-00000000c003.jpg');
  FOREACH _bad IN ARRAY ARRAY[
    'e0000000-0000-4000-8000-0000000000aa/e2000000-0000-4000-8000-0000000000a2/x.jpg',
    'e0000000-0000-4000-8000-0000000000aa/office/x.jpg',
    'e0000000-0000-4000-8000-0000000000bb/e2000000-0000-4000-8000-0000000000b1/x.jpg',
    'not-an-org/e2000000-0000-4000-8000-0000000000a1/x.jpg'
  ] LOOP
    _err := NULL;
    BEGIN
      INSERT INTO storage.objects (bucket_id, name) VALUES ('expense-receipts', _bad);
    EXCEPTION WHEN OTHERS THEN _err := SQLERRM;
    END;
    IF _err IS NULL OR _err NOT LIKE '%row-level security%' THEN
      RAISE EXCEPTION 'PROOF FAILED [tech uploads to %]: %', _bad, COALESCE(_err, 'accepted');
    END IF;
  END LOOP;
END $$;
RESET ROLE;

-- The office files a receipt under "office" and attaches it to tech two's
-- expense.
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a001","role":"authenticated"}';
SET ROLE authenticated;
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('expense-receipts', 'e0000000-0000-4000-8000-0000000000aa/office/e3000000-0000-4000-8000-0000000000a2.jpg');
UPDATE public.expenses
   SET receipt_path = 'e0000000-0000-4000-8000-0000000000aa/office/e3000000-0000-4000-8000-0000000000a2.jpg'
 WHERE id = 'e3000000-0000-4000-8000-0000000000a2';
DO $$
BEGIN
  IF (SELECT count(*) FROM storage.objects WHERE bucket_id = 'expense-receipts'
        AND name LIKE 'e0000000-0000-4000-8000-0000000000aa/%') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [office reads receipts]: the owner cannot see both of A''s receipts';
  END IF;
END $$;
RESET ROLE;

-- Tech two reads the receipt on their own expense, not tech one's.
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a003","role":"authenticated"}';
SET ROLE authenticated;
DO $$
DECLARE _names text[];
BEGIN
  SELECT array_agg(name) INTO _names FROM storage.objects WHERE bucket_id = 'expense-receipts'
     AND name LIKE 'e0000000-0000-4000-8000-0000000000aa/%';
  IF _names IS DISTINCT FROM ARRAY['e0000000-0000-4000-8000-0000000000aa/office/e3000000-0000-4000-8000-0000000000a2.jpg'] THEN
    RAISE EXCEPTION 'PROOF FAILED [tech reads receipts]: tech two sees %', _names;
  END IF;
END $$;
RESET ROLE;

-- Tech one does not see the office-filed receipt on tech two's expense, and
-- org B's owner sees nothing of A's.
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000a002","role":"authenticated"}';
SET ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'expense-receipts'
              AND name LIKE '%/office/%') THEN
    RAISE EXCEPTION 'PROOF FAILED [tech reads receipts]: tech one sees a receipt on tech two''s expense';
  END IF;
END $$;
RESET ROLE;
SET LOCAL request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-00000000b001","role":"authenticated"}';
SET ROLE authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'expense-receipts'
              AND name LIKE 'e0000000-0000-4000-8000-0000000000aa/%') THEN
    RAISE EXCEPTION 'PROOF FAILED [cross-tenant receipts]: org B''s owner sees org A''s receipts';
  END IF;
  RAISE NOTICE 'ok: receipts are filed by org and person; a tech reads their own, the office its org''s, nobody another org''s';
END $$;
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL EXPENSE PROOFS PASSED'; END $$;

ROLLBACK;
