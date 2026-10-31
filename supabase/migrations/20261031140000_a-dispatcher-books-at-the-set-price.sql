-- A dispatcher books at the set price (#616).
--
-- The front desk could not book anything. Book a groom, Book a visit and the
-- one-off on the Schedule all asked for manage_pricing, which a dispatcher
-- does not hold, because booking a one-off used to mean typing a price. The
-- Roles help page said a dispatcher does "scheduling", and they could not
-- schedule a single visit.
--
-- This adds one permission, 'booking', to the matrix. Owner holds it (every
-- permission) and office_manager holds it (every permission but the two it
-- names), so the only clause that changes is the dispatcher's. It mirrors
-- ROLE_PERMISSIONS in src/lib/permissions.ts, which tests/permission-parity
-- pins against this file.
--
-- No policy reads 'booking', and no policy changes. The subscriptions write
-- policy stays manage_pricing exactly as it is, so a dispatcher still cannot
-- write a plan, or a price, with their own key. Their booking is written by
-- the server function after it has worked the price out itself from the
-- business's own numbers (the one-off price, the service's price, the groom
-- grid) and refused anything else: the same split the portal's auto-accept
-- and the booking link's webhook already make.
--
-- The body below is 20261009180000's verbatim except for the dispatcher's
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
        OR (ur.role = 'dispatcher' AND _permission IN ('view_client_directory', 'record_field_addons', 'booking'))
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
  'Mirrors ROLE_PERMISSIONS in src/lib/permissions.ts; the IMP-3 parity test pins them together. Answers only about the CALLER, only after the second step when they have one, and never for a person whose staff row in that organization is turned off (20261009180000). Dispatcher holds booking (20261031140000, #616).';

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _fn constant regprocedure := 'public.has_permission(uuid, uuid, text)'::regprocedure;
  _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = _fn;
  IF _src NOT LIKE '%''dispatcher'' AND _permission IN (''view_client_directory'', ''record_field_addons'', ''booking'')%' THEN
    RAISE EXCEPTION 'has_permission must grant dispatcher booking';
  END IF;
  -- The dispatcher's list gains booking and nothing else: no price, no money.
  IF _src ~ '''dispatcher''[^)]*''manage_pricing''' THEN
    RAISE EXCEPTION 'has_permission must not grant dispatcher manage_pricing';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not execute has_permission';
  END IF;
END
$post$;
