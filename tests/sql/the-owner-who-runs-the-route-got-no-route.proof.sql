-- An owner-operator's demo, proved against a real Postgres. Run by
-- tests/the-owner-who-runs-the-route-got-no-route.test.ts, which passes the
-- migration as :migration.
--
-- One business whose only staff member is the owner, marked as a field tech —
-- the shape tests/e2e/seed.mjs builds and the commonest real customer. Seeded
-- as that owner, every visit must belong to somebody, whatever the hour.
-- ROLLED BACK at the end.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts). A session lock,
-- held until psql disconnects, so it covers every transaction below.
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

-- Both seed proofs replace seed_demo_org inside their transaction and then
-- seed. Run side by side (vitest runs files in parallel) they deadlocked in
-- CI on 2026-10-01. One lock, held to the end of the transaction, puts them
-- in a queue.
SELECT pg_advisory_xact_lock(hashtext('houndstack.proof.seed_demo_org'));

\i :migration

INSERT INTO auth.users (id, email) VALUES
  ('a0000000-0000-4000-8000-00000000f001', 'owner@route.proof.invalid');
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-0000000000f1', 'Route Proof', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('a0000000-0000-4000-8000-00000000f001', '0a000000-0000-4000-8000-0000000000f1', 'owner');
SET LOCAL app.allow_protected_org_write = '';
INSERT INTO public.staff (organization_id, user_id, display_name, role, active,
                          is_field_tech, is_field_tech_overridden)
VALUES ('0a000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-00000000f001',
        'Owner Operator', 'owner', true, true, true);

SELECT set_config('request.jwt.claims',
  '{"sub":"a0000000-0000-4000-8000-00000000f001","role":"authenticated"}', true);
SET LOCAL ROLE authenticated;
SELECT public.seed_demo_org('0a000000-0000-4000-8000-0000000000f1') IS NOT NULL AS seeded \gset
RESET ROLE;

DO $$
DECLARE _total int; _completed int; _unassigned int; _today_unassigned int;
BEGIN
  SELECT count(*),
         count(*) FILTER (WHERE status = 'completed'),
         count(*) FILTER (WHERE assigned_staff_id IS NULL),
         count(*) FILTER (WHERE assigned_staff_id IS NULL
                            AND scheduled_on = (now() AT TIME ZONE 'America/Chicago')::date)
    INTO _total, _completed, _unassigned, _today_unassigned
    FROM public.visits WHERE organization_id = '0a000000-0000-4000-8000-0000000000f1';
  IF _total = 0 OR _completed = 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [seed]: the seed made % visits, % completed', _total, _completed;
  END IF;
  IF _unassigned > 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [assigned]: % of % visits belong to nobody (% of them today)',
      _unassigned, _total, _today_unassigned;
  END IF;
  RAISE NOTICE 'ok: every one of % visits belongs to the owner who runs the route', _total;
END $$;

ROLLBACK;
\echo ALL ROUTE PROOFS PASSED
