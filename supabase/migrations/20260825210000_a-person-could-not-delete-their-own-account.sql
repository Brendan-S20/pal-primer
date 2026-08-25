-- A person could not delete their own account from inside the app.
--
-- App Review guideline 5.1.1(v) requires it wherever an app supports account
-- CREATION, and this one does: an unrecognised email at sign-in walks straight
-- into /get-started, and that chunk ships in the binary. What the app said
-- instead was the canonical rejection text -- "email support@houndstack.com".
--
-- Owner decision, 2026-08-25, and this file implements exactly that.
--
-- ── WHY THIS ANONYMISES RATHER THAN DROPS THE ROW ─────────────────────────
--
-- The obvious implementation is auth.admin.deleteUser. It would destroy
-- service history, and the schema says so:
--
--     staff.user_id            -> auth.users(id) ON DELETE CASCADE
--     visits.assigned_staff_id -> staff(id)      ON DELETE SET NULL
--
-- So deleting the auth row deletes the staff row, and deleting the staff row
-- NULLs `assigned_staff_id` on every visit that person ever completed. Who did
-- the work becomes unknowable, retroactively, across the whole history --
-- which is the opposite of "preserve invoices, payments, service history and
-- audit logs".
--
-- Two more FKs would block the delete outright for a platform admin:
-- platform_admin_audit.actor_user_id and platform_support_notes.author_user_id
-- are NOT NULL with no ON DELETE rule at all.
--
-- So the account is ANONYMISED and its ACCESS is removed. The distinction that
-- matters to a person deleting their account is that they can no longer sign
-- in and their personal details are gone; it is not that a foreign key
-- somewhere stops resolving. `staff` is where the personal data actually lives
-- -- display_name, email, phone, avatar, and start/end ADDRESSES WITH
-- COORDINATES, which for a technician is their home -- and every one of those
-- is cleared here.
--
-- ── THE SOLE OWNER ───────────────────────────────────────────────────────
--
-- Refused outright unless they say what should happen to the business. An
-- organization with no owner cannot be administered, billed, or recovered by
-- anybody, and the person best placed to decide is the one pressing the
-- button. Two ways through:
--
--   transfer  promote a named member to owner first, then anonymise
--   close     soft-delete the workspace, then anonymise
--
-- Closing sets deleted_at and suspended_at. Cancelling the platform
-- subscription is the SERVER's half -- it needs Stripe -- and this function
-- deliberately does not pretend to do it. See delete-account.functions.ts.
--
-- ── WHAT IS NEVER TOUCHED ────────────────────────────────────────────────
--
-- invoices, payments, credit_ledger, visits, visit_photos, activity, and every
-- audit table. Financial and service records survive a person leaving, which
-- is both the legal position and the reason a business can still answer a
-- question about last March.

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

  RETURN jsonb_build_object(
    'ok', true,
    'organization_id', _org,
    'transferred', _transferred,
    'workspace_closed', _closed
  );
END;
$$;

COMMENT ON FUNCTION public.delete_my_account(uuid, boolean) IS
  'Ends the calling user''s access and anonymises their personal data, preserving invoices, payments, service history and audit records. Refuses for a sole owner unless ownership is transferred or the workspace is closed. The auth identity and Stripe subscription are the server function''s half.';

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
  -- And the things it must NOT do. A future edit that starts deleting invoices
  -- or visits here fails at replay rather than in production.
  IF _src ~* 'delete\s+from\s+public\.(invoices|payments|visits|credit_ledger|activity)' THEN
    RAISE EXCEPTION 'delete_my_account must not delete financial or service records';
  END IF;
END
$verify$;
