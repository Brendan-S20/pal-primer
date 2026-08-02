-- The six authorization primitives would answer about ANY user, to anyone.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
--
-- has_role, is_org_member, has_permission, can_write_org, is_platform_admin
-- and is_visit_tech take WHOSE permissions to check as an argument rather than
-- deriving it from the caller. So the question they answer is not "am I an
-- owner of this organization" but "is THIS user an owner of THAT one" — and
-- they answered it for anybody who asked.
--
-- They are SECURITY DEFINER and must stay executable by `authenticated`,
-- because row-security policies call them on essentially every query and
-- policies are evaluated as the querying role. Revoking them stops the product.
-- So the fix cannot be a grant; it has to be inside the function.
--
-- Any signed-in account could therefore ask the database:
--
--   SELECT has_role('<someone else>', '<some organization>', 'owner');
--
-- and get back true or false. One bit, no names, no rows, nothing writable —
-- but repeated across ids it maps which people belong to which businesses and
-- in what role. 20260731240000 closed the paths that returned real tenant data;
-- this closes the last one that returned an inference about it.
--
-- Severity is genuinely low and worth stating honestly rather than dressing
-- up: both ids are random 128-bit values, nothing enumerates them across
-- tenants, and to ask about a person you must already hold their user id —
-- which in practice means they are in your own organization, where the staff
-- page already shows you. It is a leak of relationships, never of data.
--
-- ── WHY THIS IS SIX SMALL GUARDS AND NOT A SIGNATURE CHANGE ────────────────
--
-- The obvious fix — drop the _user_id parameter and read auth.uid() inside —
-- would mean rewriting every policy that calls these, and I first reported the
-- cost that way. Checking rather than assuming showed it is unnecessary: of
-- 182 call sites across policies and function bodies, 182 pass the caller's own
-- identity. (181 pass auth.uid() literally; bootstrap_organization passes it
-- through a local variable.) Every TypeScript caller passes context.userId,
-- which is the JWT subject, i.e. auth.uid() again.
--
-- Nothing legitimately asks about a third party, so the functions can simply
-- refuse to. The signature stays, every policy keeps working, and the argument
-- becomes what it always effectively was: an assertion about yourself.
--
-- ── THE TWO EXEMPTIONS, AND WHY THEY ARE NOT HOLES ─────────────────────────
--
-- `auth.uid() IS NULL` means there is no end user — service-role code, a cron
-- job, a trigger firing inside the nightly run. That code can read user_roles
-- directly and needs no oracle, so gating it would break internal callers to
-- prevent nothing. This is the same shape as tg_orgs_protect_platform_columns.
--
-- Impersonation is NOT an exemption and needs none: startImpersonation mints a
-- real magic-link session for the target through generateLink + verifyOtp, so
-- inside an impersonation tab auth.uid() IS the impersonated user and every
-- check is a self-check like any other.
--
-- Returning FALSE rather than raising is deliberate. These are predicates in
-- policy expressions; an exception would turn a probe into a broken query for
-- the legitimate caller sharing that statement. False is also what makes the
-- leak stop: a probe about someone else now looks exactly like a probe about a
-- non-member, so nothing is learned either way.
--
-- IS NOT DISTINCT FROM rather than `=`, so a NULL _user_id yields false instead
-- of NULL — a NULL in a policy is treated as no-access, but relying on that is
-- how a subtle hole gets built later.
--
-- Bodies are otherwise byte-identical to what was live; only the leading
-- conjunct is new. Idempotent.

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _org_id uuid, _role app_role)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id AND role = _role
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (
    SELECT 1 FROM public.user_roles ur
    WHERE ur.user_id = _user_id
      AND ur.organization_id = _org_id
      AND (
        ur.role = 'owner'
        OR (ur.role = 'office_manager' AND _permission NOT IN ('manage_org_billing', 'manage_franchise'))
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons'))
        OR (ur.role = 'tech' AND _permission = 'record_field_addons')
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_write_org(_user_id uuid, _org_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _org_id
      AND role IN ('owner', 'office_manager', 'dispatcher')
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_platform_admin(_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (SELECT 1 FROM public.platform_admins WHERE user_id = _user_id)
$function$;

CREATE OR REPLACE FUNCTION public.is_visit_tech(_user_id uuid, _visit_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT (auth.uid() IS NULL OR _user_id IS NOT DISTINCT FROM auth.uid())
     AND EXISTS (
    SELECT 1 FROM public.visits v
    JOIN public.staff s ON s.id = v.assigned_staff_id
    WHERE v.id = _visit_id AND s.user_id = _user_id
  );
$function$;

COMMENT ON FUNCTION public.has_permission(uuid, uuid, text) IS
  'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER — a tenant asking about a third party gets false, because every one of the 182 call sites passes the caller''s own identity and answering for anyone else was a membership oracle.';
