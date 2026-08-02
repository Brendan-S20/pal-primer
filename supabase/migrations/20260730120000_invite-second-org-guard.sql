-- BUG-18: accepting a second organization's invite permanently bricked the
-- account, and nothing in the product could undo it.
--
-- accept_org_invite_for_current_user checked membership of the INVITED org
-- only:
--
--   IF EXISTS (SELECT 1 FROM user_roles WHERE user_id = _uid
--                AND organization_id = _inv.organization_id) THEN ... RETURN;
--
-- A user already in org A who accepted an invite to org B fell straight past
-- that guard and got a second user_roles row. From the next request onward,
-- resolveCaller's `.maybeSingle()` raised PGRST116 — "more than one row" — on
-- EVERY permission check. That is 154 authz call sites across 48 files, plus
-- getMyOrg, which backs the entire client-side role and navigation layer. The
-- account could not load a page, and no self-service path existed to remove the
-- extra row.
--
-- The single-org assumption is deliberate and documented (authz.server.ts):
-- silently choosing among memberships would resolve a caller into an org they
-- did not ask for, which at that layer means answering an authorization
-- question wrongly. Real multi-org membership is a franchise/Enterprise concern
-- and belongs to BUILD-6 (owner decision) — it needs an active-org concept, an
-- org switcher, and per-org query scoping, none of which exist.
--
-- So this does NOT add multi-org support. It closes the trap: the invite is
-- refused, clearly, with the account left exactly as it was. A refusal a user
-- can read and act on beats a silent success that destroys their login.
--
-- Everything else about the function is unchanged — same lookup, same
-- idempotent re-accept, same staff row, same return value. Only the
-- cross-org case is newly rejected.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.accept_org_invite_for_current_user()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _inv public.org_invites;
  _existing_org uuid;
BEGIN
  IF _uid IS NULL THEN RETURN NULL; END IF;
  SELECT email INTO _email FROM auth.users WHERE id = _uid;
  IF _email IS NULL THEN RETURN NULL; END IF;

  SELECT * INTO _inv FROM public.org_invites
   WHERE lower(email) = lower(_email) AND status = 'pending' AND expires_at > now()
   ORDER BY created_at DESC LIMIT 1;
  IF _inv.id IS NULL THEN RETURN NULL; END IF;

  -- Don't double-add if already a member of that org. (Unchanged.)
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND organization_id = _inv.organization_id) THEN
    UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
    RETURN _inv.organization_id;
  END IF;

  -- BUG-18: already in a DIFFERENT organization. Accepting would insert a
  -- second user_roles row and break every authorization lookup this account
  -- makes, with no way back. Refuse, leave the invite pending so it can still
  -- be accepted by the right account, and say why.
  SELECT organization_id INTO _existing_org
    FROM public.user_roles WHERE user_id = _uid LIMIT 1;

  IF _existing_org IS NOT NULL THEN
    RAISE EXCEPTION 'This account already belongs to another organization. Ask the inviter to send the invitation to a different email address, or leave your current organization first.'
      USING ERRCODE = 'raise_exception';
  END IF;

  INSERT INTO public.user_roles(user_id, organization_id, role)
    VALUES (_uid, _inv.organization_id, _inv.role);
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_inv.organization_id, _uid, _inv.role,
            split_part(_email, '@', 1), _inv.role = 'tech');

  UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
  RETURN _inv.organization_id;
END;
$$;

COMMENT ON FUNCTION public.accept_org_invite_for_current_user() IS
  'BUG-18: refuses an invite that would give the account a SECOND organization membership, which would break resolveCaller (.maybeSingle) on every subsequent request and leave the account unusable. Multi-org membership arrives with BUILD-6 and must revisit this together with resolveCaller.';

-- A safety net for the assumption itself. If a second membership is ever
-- created by some other path, this makes it fail at the database rather than
-- succeed and brick the account later. A unique index rather than a
-- constraint, so BUILD-6 can drop it in one statement when multi-org genuinely
-- arrives.
--
-- Note it is stricter than "one ORG per user": resolveCaller uses
-- `.maybeSingle()`, which rejects a second ROW regardless of which org it
-- names. So a user holding two ROLES in the SAME org breaks it exactly as
-- badly, and the index has to match the invariant the code actually depends
-- on. The table's own UNIQUE (user_id, organization_id, role) permits that
-- case; nothing in the product creates it, and no account has it today.
--
-- Created only if no account currently holds more than one row, so this
-- migration can never fail on live data it did not cause. (Verified: 10 rows,
-- 10 distinct users, no duplicates of either kind.)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles GROUP BY user_id HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS user_roles_one_org_per_user_idx
      ON public.user_roles (user_id);
  ELSE
    RAISE NOTICE 'Skipping user_roles_one_org_per_user_idx: an account already holds multiple user_roles rows.';
  END IF;
END $$;

COMMENT ON INDEX public.user_roles_one_org_per_user_idx IS
  'BUG-18 safety net: enforces the one-ROW-per-user assumption resolveCaller (.maybeSingle) depends on — stricter than one org per user, because a second role in the same org breaks it identically. BUILD-6 (multi-org membership) must DROP this index as part of introducing an active-org concept — not work around it.';
