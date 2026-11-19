-- An invited technician is not blocked by a membership that is over (#982).
--
-- PROPOSED MIGRATION. File only: not applied to any live database by the
-- change that adds it. Brendan signs off before it reaches production.
--
-- THE BUG. accept_org_invite_for_current_user refuses with "This account
-- already belongs to another organization" whenever the account has ANY
-- user_roles row, even one that no longer means anything:
--   * a business that was deleted (organizations.deleted_at is set), the
--     usual state of a QA or test org an address was once invited to;
--   * a business that turned this person off: the user_roles row stays, the
--     staff row is inactive (they land on access-off or /no-workspace),
--     and nothing short of leave_business_i_was_turned_off_in clears it.
-- The guard was written for BUG-18 (two live businesses) and has been
-- redefined in 20260730120000, 20260825160000, 20261101155000 and
-- 20261109180000; none of them looked at what the other row was.
--
-- THE FIX, in the same function and nothing else:
--   * the guard counts only a membership in a LIVE business where the person
--     is not turned off (the exact test leave_business_i_was_turned_off_in
--     uses: staff rows there and none active = off). A person who really is
--     in another live business is refused exactly as before, same message.
--   * on acceptance the dead memberships are deleted (staff rows and their
--     history stay), and a live business that had turned them off gets a
--     staff.left line, as when they leave on their own.
-- Everything else in the function is 20261109180000's, line for line,
-- including the splice text off-means-off.proof.sql replays over.
--
-- ROLLBACK: supabase/rollback/20261118030000_an-invite-is-not-blocked-by-a-membership-that-is-over.down.sql

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
  _dead record;
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

  -- BUG-18: already in a DIFFERENT organization. Only a membership that
  -- still means something counts (#982): one in a business that was deleted,
  -- or one where this account's access was turned off (it has staff rows
  -- there and none of them is on) is a membership in name only, and it does
  -- not keep the person out of a new business. That is the same test
  -- leave_business_i_was_turned_off_in uses (20261111150000).
  SELECT ur.organization_id INTO _existing_org
    FROM public.user_roles ur
    JOIN public.organizations o ON o.id = ur.organization_id
   WHERE ur.user_id = _uid
     AND o.deleted_at IS NULL
     AND NOT (EXISTS (SELECT 1 FROM public.staff s
                       WHERE s.organization_id = ur.organization_id
                         AND s.user_id = _uid AND NOT s.active)
              AND NOT EXISTS (SELECT 1 FROM public.staff s
                               WHERE s.organization_id = ur.organization_id
                                 AND s.user_id = _uid AND s.active))
   LIMIT 1;

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

  -- The memberships in name only go now, so the account is in one business
  -- at a time as everything else assumes. The staff rows and their history
  -- stay; a business that turned them off is told, as when they leave.
  FOR _dead IN
    WITH gone AS (
      DELETE FROM public.user_roles ur
       WHERE ur.user_id = _uid AND ur.organization_id <> _inv.organization_id
      RETURNING ur.organization_id
    ) SELECT g.organization_id FROM gone g
  LOOP
    INSERT INTO public.activity_log (organization_id, actor_user_id, actor_label, kind, summary, meta)
    SELECT _dead.organization_id, _uid, left(coalesce(nullif(btrim(_name), ''), 'A former teammate'), 200),
           'staff.left',
           left(format('%s joined another business after their access here was turned off or the business closed',
                       coalesce(nullif(btrim(_name), ''), 'A former teammate')), 500),
           jsonb_build_object('user_id', _uid)
     WHERE EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = _dead.organization_id AND o.deleted_at IS NULL);
  END LOOP;

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
  'Accepts a pending org_invites row for the signed-in user. Either the invite token is supplied and must match, or the account must post-date the invitation, or (#765) already have a staff row in the inviting organization. A membership in a deleted business, or one whose access was turned off, does not count as belonging to another organization (#982); those are retired when the invitation is accepted. A former member''s newest staff row there is turned back on with the invited role; otherwise a staff row is inserted with the name the person typed.';

REVOKE ALL ON FUNCTION public.accept_org_invite_for_current_user(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite_for_current_user(text) TO authenticated, service_role;
