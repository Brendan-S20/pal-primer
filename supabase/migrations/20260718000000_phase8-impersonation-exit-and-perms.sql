-- QA round 3, phase 8 (role security).
--
-- 1. Impersonation exit/duration audit (H2): track when an impersonation
--    session ENDS so the audit log can show a stop event + duration. The tab's
--    "Exit impersonation" control marks the grant ended (idempotently) and
--    writes a stop_impersonation event carrying the platform-admin identity.
-- 2. Refresh public.has_permission so its documentation matches the TS matrix
--    after adding `reveal_signin_code` (G2). The role logic is generic
--    (owner = all; office_manager = all except org-billing/franchise;
--    dispatcher/tech = explicit lists), so reveal_signin_code already resolves
--    to owner + office_manager with no logic change — this CREATE OR REPLACE
--    only keeps the mirror + comment authoritative. Idempotent.

-- ── 1. Impersonation session end marker ─────────────────────────────────────
ALTER TABLE public.impersonation_grants
  ADD COLUMN IF NOT EXISTS ended_at timestamptz;

-- ── 2. Capability matrix (mirror of src/lib/permissions.ts) ─────────────────
-- Permissions checked in SQL (RLS/RPCs): manage_pricing, manage_client_billing,
-- view_financials, view_client_directory, manage_dna_billing, record_field_addons,
-- manage_org_billing, manage_franchise, plus office-only capabilities.
-- reveal_signin_code (G2) is enforced in the server fn layer via requirePermission
-- and resolves here to owner + office_manager (never dispatcher/tech).
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _org_id uuid, _permission text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
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
$$;
REVOKE ALL ON FUNCTION public.has_permission(uuid, uuid, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, uuid, text) TO authenticated, service_role;
