-- Deleting an account removes its push tokens (#487).
--
-- delete_my_account (20260825210000) keeps the auth row on purpose, so the
-- ON DELETE CASCADE from auth.users never fires. Two tables hung off that
-- cascade and were left behind:
--
--   push_subscriptions    web push endpoints and APNs/FCM device tokens
--   live_activity_tokens  APNs tokens for the route Live Activity
--
-- A deleted person's phone would keep receiving HoundStack notifications.
-- This file redefines the function with the same body, plus two deletes
-- after the staff update, in the same transaction.
--
-- The profile photo files in the "avatars" bucket are removed by the server
-- function, because SQL cannot delete Storage objects. See
-- delete-account.functions.ts.
--
-- Nothing else changes. The signature, the sole-owner refusal, the transfer,
-- the workspace close, SECURITY DEFINER, search_path and the grants are all
-- as they were.

CREATE OR REPLACE FUNCTION public.delete_my_account(
  _transfer_to uuid DEFAULT NULL,
  _close_workspace boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _role public.app_role;
  _owner_count int;
  _closed boolean := false;
  _transferred boolean := false;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not signed in.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- resolveCaller uses .maybeSingle() on this table, so a person has at most
  -- one membership; BUG-18 and its unique index enforce that.
  SELECT organization_id, role INTO _org, _role
    FROM public.user_roles WHERE user_id = _uid LIMIT 1;

  IF _org IS NOT NULL AND _role = 'owner' THEN
    SELECT count(*) INTO _owner_count
      FROM public.user_roles WHERE organization_id = _org AND role = 'owner';

    IF _owner_count = 1 THEN
      -- The refusal the owner asked for: never silently orphan a business.
      IF _transfer_to IS NULL AND NOT _close_workspace THEN
        RAISE EXCEPTION 'You are the only owner of this workspace. Transfer ownership to somebody else, or close the workspace, before deleting your account.'
          USING ERRCODE = 'raise_exception';
      END IF;

      IF _transfer_to IS NOT NULL THEN
        -- Must already be a member of THIS organization. Promoting a stranger
        -- would be a way to hand a business to an outsider on the way out.
        IF NOT EXISTS (
          SELECT 1 FROM public.user_roles
           WHERE user_id = _transfer_to AND organization_id = _org
        ) THEN
          RAISE EXCEPTION 'That person is not a member of this workspace.'
            USING ERRCODE = 'raise_exception';
        END IF;
        IF _transfer_to = _uid THEN
          RAISE EXCEPTION 'You cannot transfer ownership to yourself.'
            USING ERRCODE = 'raise_exception';
        END IF;

        UPDATE public.user_roles SET role = 'owner'
         WHERE user_id = _transfer_to AND organization_id = _org;
        UPDATE public.staff SET role = 'owner'
         WHERE user_id = _transfer_to AND organization_id = _org;
        _transferred := true;

      ELSE
        -- Close. Soft, never a DROP: the invoices and service history under it
        -- have to remain answerable.
        PERFORM set_config('app.allow_protected_org_write', '1', true);
        UPDATE public.organizations
           SET deleted_at = now(), suspended_at = now()
         WHERE id = _org;
        PERFORM set_config('app.allow_protected_org_write', '', true);
        _closed := true;
      END IF;
    END IF;
  END IF;

  -- ACCESS. This is what actually ends the account: no membership means no
  -- org-scoped row is readable, whatever else survives.
  DELETE FROM public.user_roles WHERE user_id = _uid;

  -- IDENTITY. The staff row stays so visits keep their attribution, and every
  -- personal field on it is cleared -- including the start/end address and
  -- coordinates, which for a technician is where they live.
  UPDATE public.staff
     SET active = false,
         display_name = 'Deleted user',
         email = NULL,
         phone = NULL,
         avatar_url = NULL,
         start_address = NULL, start_latitude = NULL, start_longitude = NULL,
         end_address = NULL, end_latitude = NULL, end_longitude = NULL,
         routing_available = false
   WHERE user_id = _uid;

  -- DEVICES. The auth row is kept, so its cascade never fires. Delete the
  -- push tokens here, or the person's phones keep getting notifications.
  DELETE FROM public.push_subscriptions WHERE user_id = _uid;
  DELETE FROM public.live_activity_tokens WHERE user_id = _uid;

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', _org,
    'transferred', _transferred,
    'workspace_closed', _closed
  );
END;
$$;

COMMENT ON FUNCTION public.delete_my_account(uuid, boolean) IS
  'Ends the calling user''s access and anonymises their personal data, preserving invoices, payments, service history and audit records. Deletes their push subscriptions and Live Activity tokens. Refuses for a sole owner unless ownership is transferred or the workspace is closed. The auth identity, avatar files and Stripe subscription are the server function''s half.';

REVOKE ALL ON FUNCTION public.delete_my_account(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account(uuid, boolean) TO authenticated, service_role;

DO $verify$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'delete_my_account' LIMIT 1;
  IF _src IS NULL THEN
    RAISE EXCEPTION 'delete_my_account is missing after this migration';
  END IF;

  -- The properties this file establishes, each provable from an empty database.
  IF _src NOT LIKE '%only owner of this workspace%' THEN
    RAISE EXCEPTION 'the sole-owner refusal is gone';
  END IF;
  IF _src NOT LIKE '%DELETE FROM public.user_roles%' THEN
    RAISE EXCEPTION 'membership is no longer removed, so access would survive deletion';
  END IF;
  IF _src NOT LIKE '%start_latitude = NULL%' THEN
    RAISE EXCEPTION 'the staff home coordinates are no longer cleared';
  END IF;
  -- The two deletes this file adds.
  IF _src NOT LIKE '%DELETE FROM public.push_subscriptions WHERE user_id = _uid%' THEN
    RAISE EXCEPTION 'push subscriptions are no longer deleted, so a deleted account keeps getting notifications';
  END IF;
  IF _src NOT LIKE '%DELETE FROM public.live_activity_tokens WHERE user_id = _uid%' THEN
    RAISE EXCEPTION 'Live Activity tokens are no longer deleted, so a deleted account keeps getting route updates';
  END IF;
  -- And the things it must NOT do. A future edit that starts deleting invoices
  -- or visits here fails at replay rather than in production.
  IF _src ~* 'delete\s+from\s+public\.(invoices|payments|visits|credit_ledger|activity)' THEN
    RAISE EXCEPTION 'delete_my_account must not delete financial or service records';
  END IF;
END
$verify$;
