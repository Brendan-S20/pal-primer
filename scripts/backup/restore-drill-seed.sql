-- Seed for the restore drill's self-test (scripts/restore-drill-selftest.sh).
--
-- LOCAL ONLY. Run against a stack `supabase start` built from
-- supabase/migrations, never against a database that holds anyone's data:
-- seed_demo_org deletes the organization's clients, visits and invoices
-- before it writes. The self-test refuses any host that is not loopback
-- before it gets here.
--
-- Every name and address is made up and on the reserved .invalid domain, so
-- a backup of this database holds no customer data and its log can be read
-- by anyone. Safe to run twice: seed_demo_org replaces its own demo rows. COMMITTED, unlike the SQL proofs that seed the same way: the
-- point is a database the backup commands can dump.

\set ON_ERROR_STOP on
\set QUIET on

BEGIN;

INSERT INTO auth.users (id, instance_id, aud, role, email, email_confirmed_at, created_at, updated_at)
VALUES ('d0000000-0000-4000-8000-00000000d001', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'owner@restore-drill.invalid', now(), now(), now())
ON CONFLICT (id) DO NOTHING;

SET LOCAL app.allow_protected_org_write = '1';
INSERT INTO public.organizations (id, name, timezone)
VALUES ('0d000000-0000-4000-8000-0000000000d1', 'Restore Drill Yard', 'America/Detroit')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_roles (user_id, organization_id, role)
SELECT 'd0000000-0000-4000-8000-00000000d001', '0d000000-0000-4000-8000-0000000000d1', 'owner'
WHERE NOT EXISTS (SELECT 1 FROM public.user_roles
                   WHERE user_id = 'd0000000-0000-4000-8000-00000000d001'
                     AND organization_id = '0d000000-0000-4000-8000-0000000000d1');
SET LOCAL app.allow_protected_org_write = '';

INSERT INTO public.staff (organization_id, user_id, display_name, role, active,
                          is_field_tech, is_field_tech_overridden)
SELECT '0d000000-0000-4000-8000-0000000000d1', 'd0000000-0000-4000-8000-00000000d001',
       'Drill Owner', 'owner', true, true, true
WHERE NOT EXISTS (SELECT 1 FROM public.staff
                   WHERE organization_id = '0d000000-0000-4000-8000-0000000000d1'
                     AND user_id = 'd0000000-0000-4000-8000-00000000d001');

SELECT set_config('request.jwt.claims',
  '{"sub":"d0000000-0000-4000-8000-00000000d001","role":"authenticated"}', true) AS claims \gset
SET LOCAL ROLE authenticated;
SELECT public.seed_demo_org('0d000000-0000-4000-8000-0000000000d1') IS NOT NULL AS seeded \gset
RESET ROLE;

COMMIT;
