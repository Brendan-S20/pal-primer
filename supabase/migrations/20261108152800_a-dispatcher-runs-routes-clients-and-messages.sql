-- A dispatcher runs routes, clients and messages (#728).
--
-- Owner decision, 2026-11-08, verbatim: "dispatcher role with its own
-- permissions for routes, clients and messaging". #636 (#616) gave the
-- dispatcher 'booking': a one-off, a groom or a visit at the set price. This
-- adds the two capabilities that were still borrowed from somewhere else:
--
--   manage_schedule  move a booked visit to another day from the office. It
--                    asked for manage_client_billing, because it shared a
--                    loader with Complete and Cancel, which can bill. A move
--                    bills nothing and keeps the visit's price.
--   message_clients  text one client. It asked for view_client_directory, a
--                    READ permission standing in for a send.
--
-- A new plan at the set price is 'booking', which the dispatcher already
-- holds; it needs nothing here. See onboardClient.
--
-- Owner holds every permission; office_manager holds every permission but the
-- two it names, so it gains both with no clause of its own changing. The only
-- clause that changes is the dispatcher's. It mirrors ROLE_PERMISSIONS in
-- src/lib/permissions.ts, which tests/permission-parity.test.ts pins against
-- whichever migration defines this function last.
--
-- No policy reads either permission and NO POLICY CHANGES. In particular the
-- subscriptions write policy stays manage_pricing, so a dispatcher still cannot
-- write a plan, or a price, with their own key: their plan at the set price is
-- written by the server after it has worked the price out itself, the same
-- split #636 made for a one-off. Billing, pricing, settings, users and the
-- business's own subscription stay off the dispatcher, and the check below
-- refuses a file that grants any of them.
--
-- The body below is 20261031140000's verbatim except for the dispatcher's
-- list. Replays into an empty database: it replaces one function and checks
-- the function. No rows, no tenant, no cron.

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT ((SELECT auth.uid()) IS NULL OR _user_id IS NOT DISTINCT FROM (SELECT auth.uid()))
     AND public.mfa_satisfied()
     AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _org_id
      AND (
        ur.role = 'owner'
        OR (ur.role = 'office_manager' AND _permission NOT IN ('manage_org_billing', 'manage_franchise'))
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons', 'booking', 'manage_schedule', 'message_clients'))
        OR (ur.role = 'tech' AND _permission = 'record_field_addons')
      )
  )
     AND NOT EXISTS (
    SELECT 1 FROM public.staff s
    WHERE s.organization_id = _org_id AND s.user_id = _user_id AND NOT s.active
  );
$function$;

REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.has_permission(uuid, uuid, text) IS
  'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000). Dispatcher holds booking (20261031140000, #616), manage_schedule and message_clients (20261108152800, #728).';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn constant regprocedure := 'public.has_permission(uuid, uuid, text)'::regprocedure;
  _src text;
  _p text;
  _n_insert bigint;
  _n_wide bigint;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;
  IF _src NOT LIKE '%''dispatcher'' AND _permission IN (''view_client_directory'', ''record_field_addons'', ''booking'', ''manage_schedule'', ''message_clients'')%' THEN
    RAISE EXCEPTION 'has_permission must grant dispatcher manage_schedule and message_clients';
  END IF;
  -- The dispatcher's list gains two operations permissions and nothing else:
  -- no price, no money, no settings, no people, not the business's own plan.
  FOREACH _p IN ARRAY ARRAY[
    'manage_pricing', 'manage_client_billing', 'view_financials', 'manage_dna_billing',
    'reveal_signin_code', 'manage_org_billing', 'manage_users', 'manage_settings',
    'manage_franchise', 'send_campaigns', 'manage_imports'
  ] LOOP
    IF _src ~ ('''dispatcher''[^)]*''' || _p || '''') THEN
      RAISE EXCEPTION 'has_permission must not grant dispatcher %', _p;
    END IF;
  END LOOP;
  -- The turned-off guard and the caller guard survive the rewrite.
  IF strpos(_src, 'NOT s.active') = 0 OR strpos(_src, 'auth.uid()') = 0 OR strpos(_src, 'mfa_satisfied()') = 0 THEN
    RAISE EXCEPTION 'has_permission lost its caller, second-step or turned-off guard';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute has_permission';
  END IF;
  -- The plan write policies are still manage_pricing: established earlier in
  -- this same sequence (20260801090000, split per command by 20260810120000)
  -- and not touched here. Every PERMISSIVE write policy on subscriptions must
  -- ask for it; the RESTRICTIVE second-step policy only takes access away, so
  -- it is not counted (#302).
  SELECT count(*) FILTER (WHERE cmd IN ('INSERT', 'ALL')),
         count(*) FILTER (WHERE strpos(coalesce(qual, '') || coalesce(with_check, ''), 'manage_pricing') = 0)
    INTO _n_insert, _n_wide
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'subscriptions'
     AND permissive = 'PERMISSIVE'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');
  IF _n_insert = 0 THEN
    RAISE EXCEPTION 'subscriptions has no insert policy to check';
  END IF;
  IF _n_wide > 0 THEN
    RAISE EXCEPTION '% subscriptions write polic(ies) no longer require manage_pricing', _n_wide;
  END IF;
END
$post$;
