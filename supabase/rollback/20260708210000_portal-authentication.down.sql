-- ROLLBACK for 20260708210000_portal-authentication.sql (QA finding #4).
--
-- WHAT THIS UNDOES:
--   • Re-grants EXECUTE on every portal_* RPC to `anon` (restores the old
--     bare-link behavior — the portal is UNAUTHENTICATED again).
--   • Drops portal_resolve_contact and regenerate_portal_token.
--   • Drops the portal_sessions and portal_otps tables.
--
-- WHAT THIS DOES **NOT** UNDO — read before running:
--   • Application CODE (portal-auth.server.ts, gated server functions, the
--     verify screen, owner Regenerate button) is reverted by git, NOT by this
--     script. Run this ONLY together with a code revert to the pre-#4 commit;
--     the new code calls portal_* via service_role and expects a session, and
--     will break if the schema is rolled back under it.
--   • Any portal_token values ALREADY ROTATED via the Regenerate action stay
--     rotated. Clients whose links were regenerated keep their NEW links; the
--     old links do not come back. (Rotation is a normal UPDATE to
--     clients.portal_token and is indistinguishable from any other token
--     change — there is no history to restore.)
--   • Stripe customers / payment methods created while #4 was live are real
--     objects in Stripe and on clients.* columns; they are untouched and remain
--     valid. This script never deletes payment data.
--
-- NET: reverting restores the (insecure) pre-#4 access model. It is a security
-- regression, not a data-loss event. Prefer `regenerate_portal_token` for any
-- single leaked link over rolling the whole feature back.

BEGIN;

-- Re-grant anon EXECUTE on portal_* RPCs (undo the revocation).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname LIKE 'portal\_%'
       AND p.proname NOT IN ('portal_resolve_contact')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated;', r.sig);
  END LOOP;
END $$;

DROP FUNCTION IF EXISTS public.regenerate_portal_token(uuid);
DROP FUNCTION IF EXISTS public.portal_resolve_contact(uuid);

DROP TABLE IF EXISTS public.portal_otps;
DROP TABLE IF EXISTS public.portal_sessions;

COMMIT;
