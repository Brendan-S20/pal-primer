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
--   1. The dispatcher holds 'manage_plans'. Owner holds every permission and
--      office_manager every permission but the two it names, so both hold it
--      with no clause of theirs changing. It mirrors ROLE_PERMISSIONS in
--      src/lib/permissions.ts.
--
--   2. Who last changed a plan, and when: subscriptions.created_by,
--      last_changed_by and last_changed_at. The server functions that add,
--      pause, resume, end or edit a plan write them in the same statement as
--      the change, so the record cannot be lost the way a best-effort
--      activity entry can. ended_by (20260715090000) stays as it is.
--      Nullable, no default, no backfill: a plan nobody has changed since this
--      file says so honestly rather than inventing an author.
--
-- WHERE THE GRANT LIVES DEPENDS ON WHAT THE SEQUENCE ALREADY HOLDS
--
--   #905 (20261112010000, #863, an owner sets each role's permissions) moves
--   the role matrix into public.permission_default and makes has_permission
--   read public.role_permission_overrides. It sorts before this file and lands
--   after it, so a replay meets either shape, and this file handles both:
--
--   * role_permission_overrides absent (main before #905): has_permission is
--     still the matrix. It is replaced with 20261108152800's body verbatim
--     except for the dispatcher's list, which gains 'manage_plans'.
--     tests/permission-parity.test.ts reads that definition.
--
--   * role_permission_overrides present (#905 in the sequence): has_permission
--     is NOT touched, because replacing it would drop every business's
--     overrides. The dispatcher's default lives in permission_default, which
--     #905 carries; this file only checks that it holds 'manage_plans' and
--     fails the replay, naming the fix, if it does not.
--
--   The audit columns are added either way.
--
-- NO POLICY CHANGES. The subscriptions write policies stay manage_pricing, so
-- a dispatcher still cannot write a plan, or a price, with their own key. The
-- server works the set price out itself and writes the plan as the service
-- role, after checking the client, property and plan are the caller's
-- business's (src/lib/plan-set-price.server.ts), the same split #732 made for
-- a new client's plan. The checks below refuse a sequence that grants the
-- dispatcher any money, price, settings or access permission.
--
-- Replays into an empty database in either order: three nullable columns,
-- at most one function replaced, and checks of what the sequence holds. Each
-- branch asks about a table an earlier migration in the same sequence
-- creates, not about operations state. No rows, no tenant, no cron.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS created_by uuid,
  ADD COLUMN IF NOT EXISTS last_changed_by uuid,
  ADD COLUMN IF NOT EXISTS last_changed_at timestamptz;

COMMENT ON COLUMN public.subscriptions.created_by IS
  'The person who added this plan, written by the server when it is added (#728). NULL on plans added before 20261112040000.';
COMMENT ON COLUMN public.subscriptions.last_changed_by IS
  'The person who last added, paused, resumed, ended or edited this plan, written with the change (#728).';
COMMENT ON COLUMN public.subscriptions.last_changed_at IS
  'When last_changed_by made that change (#728).';

-- ── The grant: in has_permission only while it is still the matrix ────────
DO $grant$
BEGIN
  IF to_regclass('public.role_permission_overrides') IS NOT NULL THEN
    RAISE NOTICE '20261112040000 (#907): role_permission_overrides exists (#905); has_permission is left as it is, and manage_plans is checked in permission_default below.';
  ELSE
    EXECUTE $ddl$
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
$ddl$;
    EXECUTE 'REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM PUBLIC, anon';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role';
    EXECUTE $c$COMMENT ON FUNCTION public.has_permission(uuid, uuid, text) IS 'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000). Dispatcher holds booking (20261031140000, #616), manage_schedule and message_clients (20261108152800, #728), and manage_plans (20261112040000, #728).'$c$;
  END IF;
END
$grant$;

-- ── What this file establishes, checked from either starting shape ────────
DO $post$
DECLARE
  _fn constant regprocedure := 'public.has_permission(uuid, uuid, text)'::regprocedure;
  _overrides constant boolean := to_regclass('public.role_permission_overrides') IS NOT NULL;
  _forbidden constant text[] := ARRAY[
    'manage_pricing', 'manage_client_billing', 'view_financials', 'manage_dna_billing',
    'reveal_signin_code', 'manage_org_billing', 'manage_users', 'manage_settings',
    'manage_franchise', 'send_campaigns', 'manage_imports'
  ];
  _src text;
  _p text;
  _ok boolean;
  _n_cols int;
  _n_insert bigint;
  _n_wide bigint;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;

  IF _overrides THEN
    -- #905's shape: has_permission still reads the overrides (this file did
    -- not replace it), and the dispatcher's DEFAULT carries manage_plans.
    IF strpos(_src, 'role_permission_overrides') = 0 OR strpos(_src, 'permission_default') = 0 THEN
      RAISE EXCEPTION '20261112040000 (#907): has_permission no longer reads role_permission_overrides and permission_default (#905)';
    END IF;
    IF to_regprocedure('public.permission_default(public.app_role, text)') IS NULL THEN
      RAISE EXCEPTION '20261112040000 (#907): role_permission_overrides exists but public.permission_default(app_role, text) does not (#905)';
    END IF;
    EXECUTE 'SELECT public.permission_default($1::public.app_role, $2)' INTO _ok USING 'dispatcher', 'manage_plans';
    IF _ok IS NOT TRUE THEN
      RAISE EXCEPTION '20261112040000 (#907): permission_default must give dispatcher manage_plans. Add ''manage_plans'' to the dispatcher list in permission_default (#905).';
    END IF;
    -- No price, no money, no settings, no people, not the business's own plan.
    FOREACH _p IN ARRAY _forbidden LOOP
      EXECUTE 'SELECT public.permission_default($1::public.app_role, $2)' INTO _ok USING 'dispatcher', _p;
      IF _ok IS TRUE THEN
        RAISE EXCEPTION '20261112040000 (#907): permission_default must not give dispatcher %', _p;
      END IF;
    END LOOP;
  ELSE
    -- The matrix shape: this file's has_permission, with the dispatcher's list.
    IF _src NOT LIKE '%''dispatcher'' AND _permission IN (''view_client_directory'', ''record_field_addons'', ''booking'', ''manage_schedule'', ''message_clients'', ''manage_plans'')%' THEN
      RAISE EXCEPTION '20261112040000 (#907): has_permission must grant dispatcher manage_plans';
    END IF;
    FOREACH _p IN ARRAY _forbidden LOOP
      IF _src ~ ('''dispatcher''[^)]*''' || _p || '''') THEN
        RAISE EXCEPTION '20261112040000 (#907): has_permission must not grant dispatcher %', _p;
      END IF;
    END LOOP;
  END IF;

  -- Either shape keeps the caller, second-step and turned-off guards, and
  -- anon never executes it.
  IF strpos(_src, 'NOT s.active') = 0 OR strpos(_src, 'auth.uid()') = 0 OR strpos(_src, 'mfa_satisfied()') = 0 THEN
    RAISE EXCEPTION '20261112040000 (#907): has_permission lost its caller, second-step or turned-off guard';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION '20261112040000 (#907): anon must not execute has_permission';
  END IF;

  SELECT count(*) INTO _n_cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions'
     AND column_name IN ('created_by', 'last_changed_by', 'last_changed_at');
  IF _n_cols <> 3 THEN
    RAISE EXCEPTION '20261112040000 (#907): subscriptions is missing its plan audit columns (found % of 3)', _n_cols;
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
    RAISE EXCEPTION '20261112040000 (#907): subscriptions has no insert policy to check';
  END IF;
  IF _n_wide > 0 THEN
    RAISE EXCEPTION '20261112040000 (#907): % subscriptions write polic(ies) no longer require manage_pricing', _n_wide;
  END IF;
END
$post$;
