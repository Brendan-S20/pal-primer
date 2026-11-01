-- An invited name is kept (#651, R2-10 / F-26).
--
-- 1. accept_org_invite_for_current_user wrote split_part(_email, '@', 1) as
--    the new staff row's display_name. The name the invitee typed on Get
--    started is in auth.users.raw_user_meta_data.display_name
--    (registerAccount puts it there) and was never read. So every invited
--    teammate was "tech1-walk-r2" on the board, in pickers and reports, and to
--    customers in the portal ("Walked by tech1-walk-r2"). staff.email was
--    left NULL as well.
--
--    Now: the typed display_name, else the name an OAuth provider gave
--    (full_name, then name), else the email prefix. The email is written too.
--    Same body otherwise: the 20260825160000 version with the 20261009180000
--    splice already in it (an accepted invitation is a seat: active = true).
--
-- 2. A tech could not rename themselves. /profile updated staff through RLS,
--    and the only UPDATE policy on staff is "Managers write staff (update)",
--    which asks for manage_users. A tech's update matched no row, PostgREST
--    reported no error, and the page said "Profile saved". With (1) there was
--    no path to a real name at all.
--
--    update_my_staff_profile changes the caller's own name and phone and
--    nothing else, and raises when there is no row of theirs to change, so a
--    save that did not happen can not be reported as one. A person who is off
--    (staff.active = false) writes nothing, as everywhere else.
--
-- Existing prefix names are NOT backfilled here. That is a reviewed one-off
-- the owner runs.
--
-- Replays into an empty database: both functions are created, nothing is read
-- or asserted about rows.

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
    -- stops an address being claimed before it is invited.
    SELECT * INTO _inv FROM public.org_invites
     WHERE lower(email) = lower(_email)
       AND status = 'pending'
       AND expires_at > now()
       AND created_at < _created
     ORDER BY created_at DESC LIMIT 1;

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
  _name := left(nullif(btrim(coalesce(
             nullif(btrim(_meta ->> 'display_name'), ''),
             nullif(btrim(_meta ->> 'full_name'), ''),
             nullif(btrim(_meta ->> 'name'), ''))), ''), 120);
  _name := coalesce(_name, split_part(_email, '@', 1));

  INSERT INTO public.user_roles(user_id, organization_id, role)
    VALUES (_uid, _inv.organization_id, _inv.role);
  -- org_invites.role is app_role, staff.role is staff_role: the cast is required.
  -- An accepted invitation is a seat (20261009180000): active = true.
  -- The next line is for 20261009180000's splice, which tests/sql/off-means-off.proof.sql
  -- replays over whatever this function is now. It returns early when the body
  -- holds its new tail, and raises when it holds neither tail. Keep it:
  --   was: split_part(_email, '@', 1), true);
  INSERT INTO public.staff(organization_id, user_id, role, display_name, email, active)
    VALUES (_inv.organization_id, _uid, _inv.role::text::public.staff_role,
            _name, _email, true);

  UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
  RETURN _inv.organization_id;
END;
$$;

COMMENT ON FUNCTION public.accept_org_invite_for_current_user(text) IS
  'Accepts a pending org_invites row for the signed-in user. Either the invite token is supplied and must match, or the account must post-date the invitation. The staff row takes the name the person typed (raw_user_meta_data display_name, then full_name, then name) and falls back to the email prefix only when none is set.';

REVOKE ALL ON FUNCTION public.accept_org_invite_for_current_user(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite_for_current_user(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.update_my_staff_profile(_display_name text, _phone text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _uid uuid := auth.uid();
  _name text := btrim(coalesce(_display_name, ''));
  _tel text := nullif(btrim(coalesce(_phone, '')), '');
  _id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to change your profile.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- RLS is bypassed here, so the two-step gate every staff policy carries is
  -- asked directly.
  IF NOT public.mfa_satisfied() THEN
    RAISE EXCEPTION 'Finish two-step sign-in first.' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF _name = '' THEN
    RAISE EXCEPTION 'A name is required' USING ERRCODE = 'check_violation';
  END IF;
  IF length(_name) > 80 THEN
    RAISE EXCEPTION 'A name can be at most 80 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF _tel IS NOT NULL AND length(_tel) > 40 THEN
    RAISE EXCEPTION 'A phone number can be at most 40 characters' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.staff
     SET display_name = _name,
         phone = _tel
   WHERE user_id = _uid
     AND active
  RETURNING id INTO _id;

  IF _id IS NULL THEN
    RAISE EXCEPTION 'No staff record for this account' USING ERRCODE = 'no_data_found';
  END IF;
  RETURN _id;
END;
$$;

COMMENT ON FUNCTION public.update_my_staff_profile(text, text) IS
  'The signed-in person changes their own staff display_name and phone. Nothing else on the row, nobody else''s row. Raises when no active staff row of theirs exists, so the caller never reports a save that did not happen.';

REVOKE ALL ON FUNCTION public.update_my_staff_profile(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_my_staff_profile(text, text) TO authenticated, service_role;

DO $verify$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_org_invite_for_current_user';
  IF _src NOT LIKE '%raw_user_meta_data%' OR _src NOT LIKE '%''display_name''%' THEN
    RAISE EXCEPTION 'accept_org_invite_for_current_user does not read the typed display_name';
  END IF;
  IF _src NOT LIKE '%created_at < _created%' OR _src NOT LIKE '%token = _token%' THEN
    RAISE EXCEPTION 'accept_org_invite_for_current_user lost its pre-claim guard';
  END IF;
  IF has_function_privilege('anon', 'public.update_my_staff_profile(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can run update_my_staff_profile';
  END IF;
END
$verify$;
