-- No seeded money is dated after now, proved in a real Postgres. Run by
-- tests/the-demo-was-paid-next-week.test.ts with :migration (this change)
-- and :route (20260930010000, which this one is spliced on top of; applied
-- first so a stack that predates it still proves the body CI builds).
--
-- On days 1 to 4 of a month the pre-fix seed fails this: it pays the last
-- closed period's invoices on period_end + 4. On other days the pre-fix seed
-- still fails it on the CURRENT period's invoice, which it issued on
-- period_end + 1 -- next month. ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

BEGIN;

-- Both seed proofs replace seed_demo_org inside their transaction and then
-- seed. Run side by side (vitest runs files in parallel) they deadlocked in
-- CI on 2026-10-01. One lock, held to the end of the transaction, puts them
-- in a queue.
SELECT pg_advisory_xact_lock(hashtext('houndstack.proof.seed_demo_org'));

\i :route
\i :migration

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000e001', 'owner@future.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000e1', 'Future Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000e001', '0a000000-0000-4000-8000-0000000000e1', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (organization_id, user_id, display_name, role, active,
                          is_field_tech, is_field_tech_overridden)
VALUES ('0a000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-00000000e001',
        'Owner Operator', 'owner', true, true, true);

SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000e001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.seed_demo_org('0a000000-0000-4000-8000-0000000000e1') IS NOT NULL AS seeded \gset
RESET ROLE;

DO $$
DECLARE _inv int; _pay int; _unpaid int; _paid int;
BEGIN
  SELECT count(*) FILTER (WHERE status <> 'draft'),
         count(*) FILTER (WHERE issued_at > now() OR paid_at > now() OR sent_at > now()
                            OR created_at > now()),
         count(*) FILTER (WHERE status = 'paid')
    INTO _inv, _unpaid, _paid
    FROM public.invoices WHERE organization_id = '0a000000-0000-4000-8000-0000000000e1';
  IF _inv = 0 OR _paid = 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: % invoices, % paid', _inv, _paid;
  END IF;
  IF _unpaid > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [invoices]: % seeded invoices are dated after now', _unpaid;
  END IF;
  SELECT count(*) INTO _pay FROM public.payments
   WHERE organization_id = '0a000000-0000-4000-8000-0000000000e1'
     AND (paid_at > now() OR created_at > now());
  IF _pay > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [payments]: % seeded payments are dated after now', _pay;
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoices
              WHERE organization_id = '0a000000-0000-4000-8000-0000000000e1'
                AND status = 'paid' AND paid_at < issued_at) THEN
    RAISE EXCEPTION 'PROOF FAILED [order]: a seeded invoice was paid before it was issued';
  END IF;
  RAISE NOTICE 'ok: % seeded invoices (% paid), nothing dated after now, nothing paid before it was issued', _inv, _paid;
END $$;

ROLLBACK;
\echo ALL SEED-DATE PROOFS PASSED
