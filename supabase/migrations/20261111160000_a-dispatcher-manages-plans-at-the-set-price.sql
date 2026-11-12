-- A dispatcher manages an existing client's plans at the set price (#728).
--
-- Owner decision, 2026-11-10 2:24 PM ET, verbatim: "Yes, dispatchers can
-- manage plans at the set price". A dispatcher adds, pauses, resumes and ends
-- a recurring plan on a client who already exists. Every plan is at the
-- business's set price for that service; a typed price, a discount or a price
-- change stays with whoever sets prices, and the SERVER refuses it.
--
-- Two things, both additive:
--
--   1. has_permission gains 'manage_plans' for the dispatcher. Owner holds
--      every permission and office_manager every permission but the two it
--      names, so both gain it with no clause of theirs changing. It mirrors
--      ROLE_PERMISSIONS in src/lib/permissions.ts, which
--      tests/permission-parity.test.ts pins against whichever migration
--      defines this function last. The body is 20261108152800's verbatim
--      except for the dispatcher's list.
--
--   2. Who last changed a plan, and when: subscriptions.created_by,
--      last_changed_by and last_changed_at. The server functions that add,
--      pause, resume, end or edit a plan write them in the same statement as
--      the change, so the record cannot be lost the way a best-effort
--      activity entry can. ended_by (20260715090000) stays as it is.
--      Nullable, no default, no backfill: a plan nobody has changed since this
--      file says so honestly rather than inventing an author.
--
-- NO POLICY CHANGES. The subscriptions write policies stay manage_pricing, so
-- a dispatcher still cannot write a plan, or a price, with their own key. The
-- server works the set price out itself and writes the plan as the service
-- role, after checking the client, property and plan are the caller's
-- business's (src/lib/plan-set-price.server.ts), the same split #732 made for
-- a new client's plan. The check below refuses a file that grants the
-- dispatcher any money, price, settings or access permission.
--
-- Replays into an empty database: it adds three nullable columns, replaces
-- one function and checks both. No rows, no tenant, no cron.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS last_changed_by uuid,
  ADD COLUMN IF NOT EXISTS last_changed_at timestamptz;

COMMENT ON COLUMN public.subscriptions.created_by IS
  'The person who added this plan, written by the server when it is added (#728). NULL on plans added before 20261111160000.';
COMMENT ON COLUMN public.subscriptions.last_changed_by IS
  'The person who last added, paused, resumed, ended or edited this plan, written with the change (#728).';
COMMENT ON COLUMN public.subscriptions.last_changed_at IS
  'When last_changed_by made that change (#728).';

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
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons', 'booking', 'manage_schedule', 'message_clients', 'manage_plans'))
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
  'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000). Dispatcher holds booking (20261031140000, #616), manage_schedule and message_clients (20261108152800, #728), and manage_plans (20261111160000, #728).';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn constant regprocedure := 'public.has_permission(uuid, uuid, text)'::regprocedure;
  _src text;
  _p text;
  _n_cols int;
  _n_insert bigint;
  _n_wide bigint;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;
  IF _src NOT LIKE '%''dispatcher'' AND _permission IN (''view_client_directory'', ''record_field_addons'', ''booking'', ''manage_schedule'', ''message_clients'', ''manage_plans'')%' THEN
    RAISE EXCEPTION 'has_permission must grant dispatcher manage_plans';
  END IF;
  -- No price, no money, no settings, no people, not the business's own plan.
  FOREACH _p IN ARRAY ARRAY[
    'manage_pricing', 'manage_client_billing', 'view_financials', 'manage_dna_billing',
    'reveal_signin_code', 'manage_org_billing', 'manage_users', 'manage_settings',
    'manage_franchise', 'send_campaigns', 'manage_imports'
  ] LOOP
    IF _src ~ ('''dispatcher''[^)]*''' || _p || '''') THEN
      RAISE EXCEPTION 'has_permission must not grant dispatcher %', _p;
    END IF;
  END LOOP;
  IF strpos(_src, 'NOT s.active') = 0 OR strpos(_src, 'auth.uid()') = 0 OR strpos(_src, 'mfa_satisfied()') = 0 THEN
    RAISE EXCEPTION 'has_permission lost its caller, second-step or turned-off guard';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute has_permission';
  END IF;

  SELECT count(*) INTO _n_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions'
     AND column_name IN ('created_by', 'last_changed_by', 'last_changed_at');
  IF _n_cols <> 3 THEN
    RAISE EXCEPTION 'subscriptions is missing its plan audit columns (found % of 3)', _n_cols;
  END IF;

  -- The plan write policies are still manage_pricing (20260801090000, split
  -- per command by 20260810120000), untouched here. The RESTRICTIVE
  -- second-step policy only takes access away, so it is not counted (#302).
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
