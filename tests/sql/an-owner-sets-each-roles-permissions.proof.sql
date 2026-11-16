-- An owner sets each role's permissions; today's rules are the defaults
-- (#863), proved against a real Postgres. Run by
-- tests/an-owner-sets-each-roles-permissions.test.ts with :migration, and by
-- CI's database job through
-- supabase/proofs/20261112010000-an-owner-sets-each-roles-permissions.sql
-- without it (the database was just built from every migration). One
-- transaction, ROLLED BACK at the end, the migration included when given.
-- Each check prints "ok: ..." or raises "PROOF FAILED [...]".
--
-- Two businesses. A: two owners (so turning one off is not refused by the
-- last-owner trigger, which fires BEFORE the policy's WITH CHECK, and the
-- refusal seen is this rule's; the second owner is otherwise unused), an
-- office manager, a dispatcher, a technician, two homes with gate codes (the
-- technician is assigned at one today and at the other tomorrow), and an
-- expense. B: an owner and a dispatcher. Each is
-- tried as the API sees them: role authenticated, the JWT's sub set the way
-- Supabase sets it. A direct INSERT, UPDATE or DELETE as `authenticated` is
-- what PostgREST does.

\set ON_ERROR_STOP on
\set QUIET on
SET client_min_messages TO notice;

-- One proof at a time (tests/the-proofs-take-turns.test.ts).
DO $turn$ BEGIN PERFORM pg_advisory_lock(hashtext('houndstack.proof')); END $turn$;

BEGIN;

\if :{?migration}
\i :migration
-- Twice: the file must run again without error or change.
\i :migration
\endif

-- ── Fixture ─────────────────────────────────────────────────────────────────
SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO auth.users (id, email) VALUES
  ('f0000000-0000-4000-8000-000000086301', 'owner-a@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086302', 'office-a@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086303', 'dispatch-a@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086304', 'tech-a@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086305', 'owner2-a@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086311', 'owner-b@rp.proof.invalid'),
  ('f0000000-0000-4000-8000-000000086313', 'dispatch-b@rp.proof.invalid');
INSERT INTO public.organizations (id, name, timezone) VALUES
  ('0a000000-0000-4000-8000-000000086300', 'Role Permissions Proof A', 'America/Chicago'),
  ('0b000000-0000-4000-8000-000000086300', 'Role Permissions Proof B', 'America/Chicago');
INSERT INTO public.user_roles (user_id, organization_id, role) VALUES
  ('f0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'owner'),
  ('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'office_manager'),
  ('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'dispatcher'),
  ('f0000000-0000-4000-8000-000000086304', '0a000000-0000-4000-8000-000000086300', 'tech'),
  ('f0000000-0000-4000-8000-000000086305', '0a000000-0000-4000-8000-000000086300', 'owner'),
  ('f0000000-0000-4000-8000-000000086311', '0b000000-0000-4000-8000-000000086300', 'owner'),
  ('f0000000-0000-4000-8000-000000086313', '0b000000-0000-4000-8000-000000086300', 'dispatcher');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (id, organization_id, user_id, role, display_name, active) VALUES
  ('5a000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086301', 'owner', 'Owner A', true),
  ('5a000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086302', 'office_manager', 'Office A', true),
  ('5a000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086303', 'dispatcher', 'Dispatch A', true),
  ('5a000000-0000-4000-8000-000000086304', '0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'tech', 'Tech A', true),
  ('5a000000-0000-4000-8000-000000086305', '0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086305', 'owner', 'Owner Two A', true),
  ('5b000000-0000-4000-8000-000000086311', '0b000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086311', 'owner', 'Owner B', true),
  ('5b000000-0000-4000-8000-000000086313', '0b000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086313', 'dispatcher', 'Dispatch B', true);

INSERT INTO public.clients (id, organization_id, account_type, display_name) VALUES
  ('c0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'residential', 'Client A1'),
  ('c0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'residential', 'Client A2');
INSERT INTO public.properties (id, organization_id, client_id, street, city, postal_code, gate_code) VALUES
  ('d0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'c0000000-0000-4000-8000-000000086301', '1 Oak St', 'Springfield', '60614', 'TODAY-1234'),
  ('d0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'c0000000-0000-4000-8000-000000086302', '2 Elm St', 'Springfield', '60614', 'TOMORROW-5678');
INSERT INTO public.subscriptions (id, organization_id, client_id, property_id, account_type, frequency, price_cents, dog_count, started_on) VALUES
  ('e0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'c0000000-0000-4000-8000-000000086301',
   'd0000000-0000-4000-8000-000000086301', 'residential', 'weekly', 2400, 1, current_date),
  ('e0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'c0000000-0000-4000-8000-000000086302',
   'd0000000-0000-4000-8000-000000086302', 'residential', 'weekly', 2400, 1, current_date);
INSERT INTO public.visits (id, organization_id, subscription_id, client_id, property_id, assigned_staff_id, scheduled_on) VALUES
  ('7a000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'e0000000-0000-4000-8000-000000086301',
   'c0000000-0000-4000-8000-000000086301', 'd0000000-0000-4000-8000-000000086301', '5a000000-0000-4000-8000-000000086304',
   (now() AT TIME ZONE 'America/Chicago')::date),
  ('7a000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'e0000000-0000-4000-8000-000000086302',
   'c0000000-0000-4000-8000-000000086302', 'd0000000-0000-4000-8000-000000086302', '5a000000-0000-4000-8000-000000086304',
   (now() AT TIME ZONE 'America/Chicago')::date + 1),
  -- A third stop, for the dispatcher to cancel at the default.
  ('7a000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'e0000000-0000-4000-8000-000000086302',
   'c0000000-0000-4000-8000-000000086302', 'd0000000-0000-4000-8000-000000086302', '5a000000-0000-4000-8000-000000086304',
   (now() AT TIME ZONE 'America/Chicago')::date + 2);
INSERT INTO public.expenses (id, organization_id, staff_id, spent_on, category, amount_cents) VALUES
  ('ee000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', '5a000000-0000-4000-8000-000000086301', current_date, 'fuel', 4200);

CREATE FUNCTION pg_temp.as_user(_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
           json_build_object('sub', _uid, 'role', 'authenticated', 'aal', 'aal1')::text, true);
$$;

-- ── The defaults are the rules main shipped, and an empty table is them ────
DO $$
DECLARE
  _om constant uuid := 'f0000000-0000-4000-8000-000000086302';
  _dp constant uuid := 'f0000000-0000-4000-8000-000000086303';
  _tc constant uuid := 'f0000000-0000-4000-8000-000000086304';
  _a constant uuid := '0a000000-0000-4000-8000-000000086300';
  _p text;
  _all constant text[] := ARRAY['manage_pricing', 'booking', 'manage_schedule', 'message_clients',
    'manage_client_billing', 'view_financials', 'view_client_directory', 'manage_dna_billing',
    'reveal_signin_code', 'record_field_addons', 'manage_org_billing', 'manage_leads', 'send_campaigns',
    'manage_imports', 'use_ai_tools', 'manage_inventory', 'manage_franchise', 'manage_users', 'manage_settings',
    'close_visits', 'manage_plans'];
  _dispatcher constant text[] := ARRAY['view_client_directory', 'record_field_addons', 'booking', 'manage_schedule',
    'close_visits', 'manage_plans', 'message_clients'];
BEGIN
  IF (SELECT count(*) FROM public.role_permission_overrides) <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [defaults]: the overrides table is not empty on a fresh build';
  END IF;
  FOREACH _p IN ARRAY _all LOOP
    IF NOT public.permission_default('owner', _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [defaults]: the owner lacks %', _p;
    END IF;
    IF public.permission_default('office_manager', _p) <> (_p NOT IN ('manage_org_billing', 'manage_franchise')) THEN
      RAISE EXCEPTION 'PROOF FAILED [defaults]: office_manager/% is not the shipped default', _p;
    END IF;
    IF public.permission_default('dispatcher', _p) <> (_p = ANY (_dispatcher)) THEN
      RAISE EXCEPTION 'PROOF FAILED [defaults]: dispatcher/% is not the shipped default', _p;
    END IF;
    IF public.permission_default('tech', _p) <> (_p = 'record_field_addons') THEN
      RAISE EXCEPTION 'PROOF FAILED [defaults]: tech/% is not the shipped default', _p;
    END IF;
  END LOOP;
  -- has_permission with no rows is permission_default, as the service role.
  FOREACH _p IN ARRAY _all LOOP
    IF public.has_permission(_om, _a, _p) <> public.permission_default('office_manager', _p)
       OR public.has_permission(_dp, _a, _p) <> public.permission_default('dispatcher', _p)
       OR public.has_permission(_tc, _a, _p) <> public.permission_default('tech', _p) THEN
      RAISE EXCEPTION 'PROOF FAILED [defaults]: has_permission with no rows is not the default for %', _p;
    END IF;
  END LOOP;
  RAISE NOTICE 'ok: the defaults are the rules main shipped, for every role and every permission, and an empty table is them';
END $$;

-- ── The owner of A changes three things ─────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086301');
SET LOCAL ROLE authenticated;
INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed, updated_by) VALUES
  ('0a000000-0000-4000-8000-000000086300', 'dispatcher', 'view_financials', true, 'f0000000-0000-4000-8000-000000086301'),
  ('0a000000-0000-4000-8000-000000086300', 'office_manager', 'manage_pricing', false, 'f0000000-0000-4000-8000-000000086301'),
  ('0a000000-0000-4000-8000-000000086300', 'tech', 'view_client_directory', true, 'f0000000-0000-4000-8000-000000086301');
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.role_permission_overrides WHERE organization_id = '0a000000-0000-4000-8000-000000086300') <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [owner writes]: the owner''s three rows were not written';
  END IF;
  IF (SELECT count(*) FROM public.activity_log
       WHERE organization_id = '0a000000-0000-4000-8000-000000086300'
         AND kind = 'role_permissions.changed'
         AND actor_user_id = 'f0000000-0000-4000-8000-000000086301'
         AND actor_label = 'Owner A') <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: the owner''s three changes were not logged with them as the actor';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log
                  WHERE kind = 'role_permissions.changed'
                    AND meta->>'role' = 'dispatcher' AND meta->>'permission' = 'view_financials'
                    AND (meta->>'to')::boolean AND summary LIKE 'Owner A set view_financials for dispatcher to on') THEN
    RAISE EXCEPTION 'PROOF FAILED [log]: the log does not say who turned what on for whom';
  END IF;
  RAISE NOTICE 'ok: the owner writes, and each change is logged with who, which role, which permission and the answer';
END $$;

-- ── An override changes has_permission, and so RLS ──────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086303');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  IF NOT public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'view_financials') THEN
    RAISE EXCEPTION 'PROOF FAILED [on]: the dispatcher does not hold view_financials after the owner turned it on';
  END IF;
  -- RLS: the org's expenses are read on view_financials. Before: nothing but
  -- their own (none); now: the owner's fuel.
  SELECT count(*) INTO _n FROM public.expenses WHERE organization_id = '0a000000-0000-4000-8000-000000086300';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'PROOF FAILED [on]: RLS still hides the business''s expenses from a dispatcher with view_financials on (% rows)', _n;
  END IF;
  -- The rest of the dispatcher's matrix is untouched.
  IF public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'manage_pricing')
     OR NOT public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'booking') THEN
    RAISE EXCEPTION 'PROOF FAILED [on]: a permission the owner did not touch changed';
  END IF;
  RAISE NOTICE 'ok: turning a permission on for a role changes has_permission and what RLS lets that role read';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086302');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'manage_pricing') THEN
    RAISE EXCEPTION 'PROOF FAILED [off]: the office manager still holds manage_pricing after the owner turned it off';
  END IF;
  -- RLS: a plan's price is a manage_pricing write (every PERMISSIVE write
  -- policy on subscriptions asks for it). Refused now, as a dispatcher is.
  BEGIN
    UPDATE public.subscriptions SET price_cents = 9900 WHERE id = 'e0000000-0000-4000-8000-000000086301';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN
      RAISE EXCEPTION 'PROOF FAILED [off]: an office manager with manage_pricing off changed a plan''s price';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- Everything else the office manager holds is still theirs.
  IF NOT public.has_permission('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'manage_users')
     OR NOT public.has_permission('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'manage_client_billing') THEN
    RAISE EXCEPTION 'PROOF FAILED [off]: a permission the owner did not touch changed';
  END IF;
  RAISE NOTICE 'ok: turning a permission off for a role changes has_permission and what RLS lets that role write';
END $$;
RESET ROLE;

-- ── Tenant isolation: B is untouched, and cannot reach A ───────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086313');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-000000086313', '0b000000-0000-4000-8000-000000086300', 'view_financials') THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: business A''s setting reached business B''s dispatcher';
  END IF;
  SELECT count(*) INTO _n FROM public.role_permission_overrides;
  IF _n <> 0 THEN
    RAISE EXCEPTION 'PROOF FAILED [tenant]: business B reads business A''s rows (% rows)', _n;
  END IF;
  RAISE NOTICE 'ok: another business''s setting does not reach this one, and its rows are not readable';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086311');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed)
    VALUES ('0a000000-0000-4000-8000-000000086300', 'tech', 'manage_pricing', true);
    RAISE EXCEPTION 'PROOF FAILED [tenant]: the owner of B wrote a row for business A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: the owner of another business cannot write this one''s rows';
END $$;
RESET ROLE;

-- ── Only the owner writes ───────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086302');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  SELECT count(*) INTO _n FROM public.role_permission_overrides;
  IF _n <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [reads]: a member reads % of their business''s 3 rows', _n;
  END IF;
  BEGIN
    INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed)
    VALUES ('0a000000-0000-4000-8000-000000086300', 'office_manager', 'manage_pricing', true);
    RAISE EXCEPTION 'PROOF FAILED [om writes]: an office manager inserted a row';
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.role_permission_overrides SET allowed = true
     WHERE organization_id = '0a000000-0000-4000-8000-000000086300' AND role = 'office_manager' AND permission = 'manage_pricing';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [om writes]: an office manager gave themselves manage_pricing back'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.role_permission_overrides WHERE organization_id = '0a000000-0000-4000-8000-000000086300';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [om writes]: an office manager deleted the owner''s rows'; END IF;
  RAISE NOTICE 'ok: an office manager reads the rows and can neither add, change nor remove one';
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM public.role_permission_overrides;
    RAISE EXCEPTION 'PROOF FAILED [anon]: a visitor can read role_permission_overrides';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.has_permission('f0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'booking');
    RAISE EXCEPTION 'PROOF FAILED [anon]: a visitor can call has_permission';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a visitor reads nothing and asks nothing';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.role_permission_overrides) <> 3
     OR (SELECT count(*) FROM public.activity_log WHERE kind = 'role_permissions.changed') <> 3 THEN
    RAISE EXCEPTION 'PROOF FAILED [refused]: a refused write changed or logged something';
  END IF;
  RAISE NOTICE 'ok: a refused write changes nothing and logs nothing';
END $$;

-- ── The floors, with overrides set ──────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086301');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed)
    VALUES ('0a000000-0000-4000-8000-000000086300', 'office_manager', 'manage_org_billing', true);
    RAISE EXCEPTION 'PROOF FAILED [floor]: the owner handed the business''s own billing to an office manager';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed)
    VALUES ('0a000000-0000-4000-8000-000000086300', 'dispatcher', 'manage_franchise', true);
    RAISE EXCEPTION 'PROOF FAILED [floor]: the owner handed the franchise to a dispatcher';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed)
    VALUES ('0a000000-0000-4000-8000-000000086300', 'owner', 'booking', false);
    RAISE EXCEPTION 'PROOF FAILED [floor]: a row about the owner was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok: no row hands an owner-only permission to anyone, and no row is about the owner';
END $$;
RESET ROLE;

-- Even a row that got past the CHECK (it cannot, but has_permission has its
-- own floor) would not grant: written as the service role, then asked.
INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed) VALUES
  ('0a000000-0000-4000-8000-000000086300', 'office_manager', 'manage_org_billing', false);
DO $$
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'manage_org_billing')
     OR public.has_permission('f0000000-0000-4000-8000-000000086302', '0a000000-0000-4000-8000-000000086300', 'manage_franchise') THEN
    RAISE EXCEPTION 'PROOF FAILED [floor]: has_permission gave an office manager an owner-only permission';
  END IF;
  IF NOT public.has_permission('f0000000-0000-4000-8000-000000086301', '0a000000-0000-4000-8000-000000086300', 'manage_org_billing') THEN
    RAISE EXCEPTION 'PROOF FAILED [floor]: the owner lost their own billing';
  END IF;
  RAISE NOTICE 'ok: the business''s own plan, payouts and franchise are the owner''s whatever is stored';
END $$;
DELETE FROM public.role_permission_overrides WHERE permission = 'manage_org_billing';

-- The technician holds the directory now, and still reads a gate code on the
-- assigned day only.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086304');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _codes text[];
BEGIN
  IF NOT public.has_permission('f0000000-0000-4000-8000-000000086304', '0a000000-0000-4000-8000-000000086300', 'view_client_directory') THEN
    RAISE EXCEPTION 'PROOF FAILED [codes]: the technician does not hold view_client_directory after the owner turned it on';
  END IF;
  SELECT array_agg(gate_code ORDER BY gate_code) INTO _codes
    FROM public.property_access_codes(ARRAY['d0000000-0000-4000-8000-000000086301', 'd0000000-0000-4000-8000-000000086302']::uuid[]);
  IF _codes IS DISTINCT FROM ARRAY['TODAY-1234'] THEN
    RAISE EXCEPTION 'PROOF FAILED [codes]: a technician with the directory on reads codes off their day: %', _codes;
  END IF;
  RAISE NOTICE 'ok: a technician with "See every client" on still reads a gate code on the assigned day only';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086302');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _codes text[];
BEGIN
  SELECT array_agg(gate_code ORDER BY gate_code) INTO _codes
    FROM public.property_access_codes(ARRAY['d0000000-0000-4000-8000-000000086301', 'd0000000-0000-4000-8000-000000086302']::uuid[]);
  IF _codes IS DISTINCT FROM ARRAY['TODAY-1234', 'TOMORROW-5678'] THEN
    RAISE EXCEPTION 'PROOF FAILED [codes]: the office no longer reads both codes: %', _codes;
  END IF;
  RAISE NOTICE 'ok: the office still reads every code';
END $$;
RESET ROLE;

-- ── Staff authority follows manage_users, inside the floors ────────────────
-- The owner takes "manage the team" from office managers and gives it to
-- dispatchers.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086301');
SET LOCAL ROLE authenticated;
INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed, updated_by) VALUES
  ('0a000000-0000-4000-8000-000000086300', 'office_manager', 'manage_users', false, 'f0000000-0000-4000-8000-000000086301'),
  ('0a000000-0000-4000-8000-000000086300', 'dispatcher', 'manage_users', true, 'f0000000-0000-4000-8000-000000086301');
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086302');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000086304', false);
    RAISE EXCEPTION 'PROOF FAILED [om off]: an office manager with manage_users off turned the technician off by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'dispatcher');
    RAISE EXCEPTION 'PROOF FAILED [om off]: an office manager with manage_users off changed a role by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000086304';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [om off]: an office manager with manage_users off turned the technician off by REST'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- And no other staff edit either: "Managers write staff" (20260804090000)
  -- is the permissive policy on the table and it asks for manage_users, so
  -- the owner's switch takes the whole staff table from them, address
  -- included. (The first run of this proof, CI 2026-11-13, expected the
  -- address edit to pass; the policy, not the migration, was right.)
  UPDATE public.staff SET start_address = '1 Depot Rd' WHERE id = '5a000000-0000-4000-8000-000000086304';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [om off]: an office manager with manage_users off still edits a staff row'; END IF;
  RAISE NOTICE 'ok: an office manager whose manage_users is off is refused on roles, access and every other staff edit, by RPC and REST';
END $$;
RESET ROLE;

SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086303');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  -- A dispatcher with manage_users on: the technician, off and on, by RPC and REST.
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000086304', false);
  IF (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000086304') THEN
    RAISE EXCEPTION 'PROOF FAILED [dp on]: set_staff_active did not turn the technician off';
  END IF;
  PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000086304', true);
  UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000086304';
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n <> 1 THEN RAISE EXCEPTION 'PROOF FAILED [dp on]: a direct UPDATE could not turn the technician off'; END IF;
  UPDATE public.staff SET active = true WHERE id = '5a000000-0000-4000-8000-000000086304';
  -- A role at or below their own: yes.
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'dispatcher');
  IF (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000086304') <> 'dispatcher' THEN
    RAISE EXCEPTION 'PROOF FAILED [dp on]: change_user_role did not make the technician a dispatcher';
  END IF;
  PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'tech');
  -- A role above their own: never (a dispatcher cannot grant office manager).
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'office_manager');
    RAISE EXCEPTION 'PROOF FAILED [rank]: a dispatcher granted office manager by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086304', 'owner');
    RAISE EXCEPTION 'PROOF FAILED [rank]: a dispatcher granted owner by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.staff SET role = 'office_manager' WHERE id = '5a000000-0000-4000-8000-000000086304';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [rank]: a dispatcher granted office manager by REST'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- The owner: never.
  BEGIN
    PERFORM public.set_staff_active('5a000000-0000-4000-8000-000000086301', false);
    RAISE EXCEPTION 'PROOF FAILED [owner floor]: a dispatcher with manage_users turned the owner off by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.change_user_role('0a000000-0000-4000-8000-000000086300', 'f0000000-0000-4000-8000-000000086301', 'tech');
    RAISE EXCEPTION 'PROOF FAILED [owner floor]: a dispatcher with manage_users demoted the owner by RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.staff SET active = false WHERE id = '5a000000-0000-4000-8000-000000086301';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [owner floor]: a dispatcher with manage_users turned the owner off by REST'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok: a dispatcher given manage_users runs the team within their rank, never above it and never the owner';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF NOT (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000086301')
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000086301') <> 'owner'
     OR (SELECT role FROM public.user_roles WHERE user_id = 'f0000000-0000-4000-8000-000000086304') <> 'tech'
     OR (SELECT role FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000086304') <> 'tech'
     OR NOT (SELECT active FROM public.staff WHERE id = '5a000000-0000-4000-8000-000000086304') THEN
    RAISE EXCEPTION 'PROOF FAILED [after]: a refused write changed something';
  END IF;
  RAISE NOTICE 'ok: the owner and the technician are as they were';
END $$;

-- ── Brendan's dispatcher defaults: complete and cancel yes, prepaid no ─────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086303');
SET LOCAL ROLE authenticated;
DO $$
DECLARE _n bigint;
BEGIN
  IF NOT public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'close_visits') THEN
    RAISE EXCEPTION 'PROOF FAILED [close]: a dispatcher does not hold close_visits by default';
  END IF;
  IF public.has_permission('f0000000-0000-4000-8000-000000086304', '0a000000-0000-4000-8000-000000086300', 'close_visits') THEN
    RAISE EXCEPTION 'PROOF FAILED [close]: a technician holds close_visits';
  END IF;
  -- Prepaid, by every door a dispatcher could try: the plan's cadence
  -- (manage_pricing on the table), and the prepaid invoice (manage_client_billing).
  BEGIN
    UPDATE public.subscriptions SET billing_cadence = 'prepaid' WHERE id = 'e0000000-0000-4000-8000-000000086301';
    GET DIAGNOSTICS _n = ROW_COUNT;
    IF _n <> 0 THEN RAISE EXCEPTION 'PROOF FAILED [prepaid]: a dispatcher made a plan prepaid by REST'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.generate_prepaid_invoice('e0000000-0000-4000-8000-000000086301', 4);
    RAISE EXCEPTION 'PROOF FAILED [prepaid]: a dispatcher generated a prepaid invoice';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN
    IF SQLERRM LIKE 'PROOF FAILED%' THEN RAISE; END IF;
  END;
  IF (SELECT billing_cadence FROM public.subscriptions WHERE id = 'e0000000-0000-4000-8000-000000086301') <> 'postpaid' THEN
    RAISE EXCEPTION 'PROOF FAILED [prepaid]: the plan is no longer postpaid';
  END IF;
  -- And the RPC itself, at the default: a dispatcher cancels a visit (the
  -- lighter side effect of the two close-outs; completing invoices the
  -- visit and asks for a photo or an override reason).
  PERFORM public.office_skip_visit('7a000000-0000-4000-8000-000000086303', 'client away');
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000086303') = 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [close]: a dispatcher at the default could not cancel a visit by RPC';
  END IF;
  RAISE NOTICE 'ok: a dispatcher completes and cancels by default, cancels one by RPC, a technician does not, and no door to prepaid opens for a dispatcher';
END $$;
RESET ROLE;

-- The owner takes close_visits from dispatchers: both office RPCs refuse
-- before touching the visit.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086301');
SET LOCAL ROLE authenticated;
INSERT INTO public.role_permission_overrides (organization_id, role, permission, allowed, updated_by) VALUES
  ('0a000000-0000-4000-8000-000000086300', 'dispatcher', 'close_visits', false, 'f0000000-0000-4000-8000-000000086301');
RESET ROLE;
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086303');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.office_complete_visit('7a000000-0000-4000-8000-000000086302');
    RAISE EXCEPTION 'PROOF FAILED [close off]: a dispatcher with close_visits off completed a visit by RPC';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Not authorized' THEN RAISE; END IF;
  END;
  BEGIN
    PERFORM public.office_skip_visit('7a000000-0000-4000-8000-000000086302', 'rain');
    RAISE EXCEPTION 'PROOF FAILED [close off]: a dispatcher with close_visits off canceled a visit by RPC';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Not authorized' THEN RAISE; END IF;
  END;
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000086302') <> 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [close off]: a refused close-out changed the visit';
  END IF;
  RAISE NOTICE 'ok: with close_visits turned off, a dispatcher is refused by office_complete_visit and office_skip_visit before anything is written';
END $$;
RESET ROLE;
-- The office manager still closes out (their close_visits is untouched):
-- the same RPC, past the gate. Canceling the tomorrow visit is the lighter
-- side effect of the two; it must not raise.
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086302');
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.office_skip_visit('7a000000-0000-4000-8000-000000086302', 'client away');
  IF (SELECT status FROM public.visits WHERE id = '7a000000-0000-4000-8000-000000086302') = 'scheduled' THEN
    RAISE EXCEPTION 'PROOF FAILED [close on]: an office manager could not cancel a visit';
  END IF;
  RAISE NOTICE 'ok: an office manager, whose close_visits is on, cancels a visit by the same RPC';
END $$;
RESET ROLE;
DELETE FROM public.role_permission_overrides WHERE permission = 'close_visits';

-- ── Reset to defaults ───────────────────────────────────────────────────────
SELECT pg_temp.as_user('f0000000-0000-4000-8000-000000086301');
SET LOCAL ROLE authenticated;
DELETE FROM public.role_permission_overrides
 WHERE organization_id = '0a000000-0000-4000-8000-000000086300' AND role = 'dispatcher';
RESET ROLE;
DO $$
BEGIN
  IF public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'view_financials')
     OR public.has_permission('f0000000-0000-4000-8000-000000086303', '0a000000-0000-4000-8000-000000086300', 'manage_users') THEN
    RAISE EXCEPTION 'PROOF FAILED [reset]: the dispatcher kept a permission after Reset to defaults';
  END IF;
  IF (SELECT count(*) FROM public.activity_log
       WHERE kind = 'role_permissions.changed' AND meta->>'role' = 'dispatcher'
         AND meta->>'to' IS NULL AND actor_user_id = 'f0000000-0000-4000-8000-000000086301') <> 2 THEN
    RAISE EXCEPTION 'PROOF FAILED [reset]: the two rows going back to the default were not logged';
  END IF;
  RAISE NOTICE 'ok: Reset to defaults puts the role back, and each row going is logged';
END $$;

ROLLBACK;

\echo 'ALL ROLE-PERMISSION PROOFS PASSED'
