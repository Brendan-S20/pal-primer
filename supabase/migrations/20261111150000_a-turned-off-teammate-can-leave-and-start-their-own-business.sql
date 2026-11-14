-- A turned-off teammate can leave that business and start their own (#765).
--
-- WHAT STILL FAILED AFTER #782. Settings -> Users offers an owner one way to
-- take somebody off the team: Deactivate (set_staff_active false). That keeps
-- the person's user_roles row, because the row is how the database knows they
-- are OFF rather than a stranger (access_turned_off, 20261009180000). And
-- user_roles holds one row per account (user_roles_one_org_per_user_idx,
-- 20260730120000), so bootstrap_organization hands that account back the
-- business it was turned off in instead of building a new one.
--
-- So on build 3a028504 a deactivated member could reset their password and
-- sign in, and landed on /access-off, whose only buttons were "Check again"
-- and "Sign out". Get started sent them to sign in, and sign in sent them back
-- to /access-off. The address could never start a business of its own.
--
-- THE WAY OUT. leave_business_i_was_turned_off_in(): the signed-in caller,
-- and only the caller, gives up the membership of a business that has turned
-- them off. After that the account has no membership, which is the state #782
-- already handles: /no-workspace, where they start their own business or open
-- an invitation.
--
-- WHAT IT DOES NOT DO, deliberately:
--   * It never acts for anybody but auth.uid(). There is no argument.
--   * It refuses a person who is ON. Leaving a business you can still use is
--     a different feature with different questions (who owns the work), and
--     an owner who is on must never be able to orphan a business.
--   * It deletes ONE row: the caller's own user_roles row in the business
--     that turned them off. Their staff row stays, turned off, so the visits
--     and history it carries keep pointing at a person, and an owner who
--     invites them back gets the same person back (20261109180000).
--     Nothing in that business is read back to the caller or deleted.
--   * It writes no auth.users row. Proving the address is theirs is the
--     password reset's job, which already happened to get them signed in.
--
-- The business sees it: an activity_log row in its own timeline, named for
-- the person, kind 'staff.left'.
--
-- Replays into an empty database: one function, its grants, and assertions
-- about what this file establishes. No rows are read or written.

CREATE OR REPLACE FUNCTION public.leave_business_i_was_turned_off_in()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org uuid;
  _name text;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Sign in first.';
  END IF;
  -- The same second step every other read and write asks for: a stolen
  -- password alone does not get to rearrange somebody's memberships.
  IF NOT public.mfa_satisfied() THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Finish two-step sign-in first.';
  END IF;

  -- The same per-account lock bootstrap_organization takes, so a leave and a
  -- "start my business" from two tabs take turns rather than interleave.
  PERFORM pg_advisory_xact_lock(hashtextextended('bootstrap_organization:' || _uid::text, 0));

  SELECT ur.organization_id INTO _org
    FROM public.user_roles ur
   WHERE ur.user_id = _uid
     AND EXISTS (SELECT 1 FROM public.staff s
                  WHERE s.organization_id = ur.organization_id
                    AND s.user_id = _uid AND NOT s.active)
     AND NOT EXISTS (SELECT 1 FROM public.staff s
                      WHERE s.organization_id = ur.organization_id
                        AND s.user_id = _uid AND s.active)
   LIMIT 1;

  IF _org IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'Only somebody whose access was turned off can leave a business this way.';
  END IF;

  SELECT s.display_name INTO _name
    FROM public.staff s
   WHERE s.organization_id = _org AND s.user_id = _uid
   ORDER BY s.created_at DESC
   LIMIT 1;
  _name := coalesce(nullif(btrim(_name), ''), 'A former teammate');

  DELETE FROM public.user_roles WHERE user_id = _uid AND organization_id = _org;

  INSERT INTO public.activity_log (organization_id, actor_user_id, actor_label, kind, summary, meta)
  VALUES (_org, _uid, left(_name, 200), 'staff.left',
          left(format('%s left the business after their access was turned off', _name), 500),
          jsonb_build_object('user_id', _uid));

  RETURN _org;
END;
$function$;

COMMENT ON FUNCTION public.leave_business_i_was_turned_off_in() IS
  'The caller gives up their own membership of the business that turned them off (#765), so the account can start or join another. Refuses anybody who is on. Deletes only the caller''s user_roles row there; the staff row and its history stay. Logs staff.left to that business.';

REVOKE ALL ON FUNCTION public.leave_business_i_was_turned_off_in() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_business_i_was_turned_off_in() TO authenticated, service_role;

-- ── What this file establishes ─────────────────────────────────────────────
DO $check$
DECLARE
  _fn regprocedure := 'public.leave_business_i_was_turned_off_in()'::regprocedure;
  _src text;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc WHERE oid = _fn;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn)
     OR NOT (SELECT proconfig FROM pg_proc WHERE oid = _fn) @> ARRAY['search_path=""'] THEN
    RAISE EXCEPTION 'leave_business_i_was_turned_off_in must be SECURITY DEFINER with an empty search_path';
  END IF;
  IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'leave_business_i_was_turned_off_in is callable by anon';
  END IF;
  IF _src !~ 'NOT s\.active' OR _src !~ 'public\.mfa_satisfied\(\)' THEN
    RAISE EXCEPTION 'leave_business_i_was_turned_off_in must refuse a person who is on, and one who has not finished two-step sign-in';
  END IF;
  IF _src ~* 'DELETE\s+FROM\s+public\.staff' OR _src ~* 'auth\.users' THEN
    RAISE EXCEPTION 'leave_business_i_was_turned_off_in must not delete a staff row or touch auth.users';
  END IF;
  RAISE NOTICE 'a turned-off teammate can leave that business, and only their own membership goes';
END $check$;
