-- ROLLBACK for 20261118030000_an-invite-is-not-blocked-by-a-membership-that-is-over.sql (#982).
--
-- Restores accept_org_invite_for_current_user to 20261109180000's definition
-- (verbatim below), so any membership blocks an invitation again.
--
-- WHAT THIS DOES **NOT** UNDO: user_roles rows the new function already
-- deleted when it accepted somebody. Those staff rows and their history are
-- intact, but the membership rows are not restored.
--
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261118030000_an-invite-is-not-blocked-by-a-membership-that-is-over.down.sql

CREATE OR REPLACE FUNCTION public.accept_org_invite_for_current_user(_token text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _email text;
  _created timestamptz;
  _meta jsonb;
  _name text;
  _inv public.org_invites;
  _existing_org uuid;
  _staff_id uuid;
BEGIN
  IF _uid IS NULL THEN RETURN NULL; END IF;
  SELECT email, created_at, raw_user_meta_data INTO _email, _created, _meta
    FROM auth.users WHERE id = _uid;
  IF _email IS NULL THEN RETURN NULL; END IF;

  IF _token IS NOT NULL AND length(_token) > 0 THEN
    -- Token path. The email still has to match: a token is a capability to
    -- accept THIS invitation, not a capability to accept it as anybody.
    SELECT * INTO _inv FROM public.org_invites
     WHERE token = _token
       AND lower(email) = lower(_email)
       AND status = 'pending'
       AND expires_at > now()
     LIMIT 1;
  ELSE
    -- Email path: the account has to post-date the invitation, which is what
    -- stops an address being claimed before it is invited -- unless the
    -- account was already on the inviting business's staff (#765).
    SELECT * INTO _inv FROM public.org_invites i
     WHERE lower(i.email) = lower(_email)
       AND i.status = 'pending'
       AND i.expires_at > now()
       AND (i.created_at < _created
            OR EXISTS (SELECT 1 FROM public.staff s
                        WHERE s.user_id = _uid
                          AND s.organization_id = i.organization_id))
     ORDER BY i.created_at DESC LIMIT 1;

    IF _inv.id IS NULL AND EXISTS (
      SELECT 1 FROM public.org_invites
       WHERE lower(email) = lower(_email) AND status = 'pending' AND expires_at > now()
    ) THEN
      RAISE EXCEPTION 'This email has a pending invitation. Open the link in that invitation email to join.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF _inv.id IS NULL THEN RETURN NULL; END IF;

  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND organization_id = _inv.organization_id) THEN
    UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
    RETURN _inv.organization_id;
  END IF;

  -- BUG-18: already in a DIFFERENT organization.
  SELECT organization_id INTO _existing_org
    FROM public.user_roles WHERE user_id = _uid LIMIT 1;

  IF _existing_org IS NOT NULL THEN
    RAISE EXCEPTION 'This account already belongs to another organization. Ask the inviter to send the invitation to a different email address, or leave your current organization first.'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF _inv.role::text = 'platform_admin' THEN
    RAISE EXCEPTION 'platform_admin cannot be granted by an organization invitation.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The name the person typed. The prefix is the last resort, not the rule.
  -- Capped at 80, the same cap /profile and update_my_staff_profile use, so a
  -- name that was accepted here can always be saved again there.
  _name := left(nullif(btrim(coalesce(
             nullif(btrim(_meta ->> 'display_name'), ''),
             nullif(btrim(_meta ->> 'full_name'), ''),
             nullif(btrim(_meta ->> 'name'), ''))), ''), 80);
  _name := coalesce(_name, split_part(_email, '@', 1));

  INSERT INTO public.user_roles(user_id, organization_id, role)
    VALUES (_uid, _inv.organization_id, _inv.role);

  -- A former member comes back as the person they were (#765): their newest
  -- staff row in this business, turned on, with the invited role.
  SELECT id INTO _staff_id FROM public.staff
   WHERE user_id = _uid AND organization_id = _inv.organization_id
   ORDER BY created_at DESC LIMIT 1;

  IF _staff_id IS NOT NULL THEN
    UPDATE public.staff
       SET role = _inv.role::text::public.staff_role,
           active = true,
           email = _email,
           display_name = coalesce(nullif(btrim(display_name), ''), _name)
     WHERE id = _staff_id;
  ELSE
    -- org_invites.role is app_role, staff.role is staff_role: the cast is required.
    -- An accepted invitation is a seat (20261009180000): active = true.
    -- The next line is for 20261009180000's splice, which tests/sql/off-means-off.proof.sql
    -- replays over whatever this function is now. It returns early when the body
    -- holds its new tail, and raises when it holds neither tail. Keep it:
    --   was: split_part(_email, '@', 1), true);
    INSERT INTO public.staff(organization_id, user_id, role, display_name, email, active)
      VALUES (_inv.organization_id, _uid, _inv.role::text::public.staff_role,
              _name, _email, true);
  END IF;

  UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
  RETURN _inv.organization_id;
END;
$$;
COMMENT ON FUNCTION public.accept_org_invite_for_current_user(text) IS
  'Accepts a pending org_invites row for the signed-in user. Either the invite token is supplied and must match, or the account must post-date the invitation, or (#765) already have a staff row in the inviting organization. A former member''s newest staff row there is turned back on with the invited role; otherwise a staff row is inserted with the name the person typed.';

REVOKE ALL ON FUNCTION public.accept_org_invite_for_current_user(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite_for_current_user(text) TO authenticated, service_role;
