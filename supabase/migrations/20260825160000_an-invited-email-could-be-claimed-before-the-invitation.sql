-- Anyone could claim an email address before it was invited, and inherit the
-- role it was invited to.
--
-- ── THE CHAIN ─────────────────────────────────────────────────────────────
--
-- Two defects that are each defensible alone and are not defensible together.
--
-- 1. registerAccount (src/lib/auth-entry.functions.ts:29) takes NO auth
--    middleware and calls auth.admin.createUser({ email_confirm: true }). An
--    anonymous caller mints a CONFIRMED account for an address they have never
--    proved they control. The comment above it calls this "frictionless
--    signup", and as a signup flow it is a reasonable trade.
--
-- 2. This function matched a pending invite on `lower(email) = lower(_email)`
--    and NOTHING else. The `token` written at users.functions.ts:118 was never
--    read by anything -- org_invites.token existed and was dead.
--
-- So: an attacker registers newhire@acme-pets.com and does not sign in. Acme's
-- owner invites that address as office_manager. The attacker signs in and
-- ensureBootstrapped calls this function, which selects that invitation for
-- them on the strength of the address alone.
--
-- checkEmailAccount -- also unauthenticated, also unrate-limited -- is the
-- oracle for which addresses are still unclaimed.
--
-- ── AND THEN THE REPLAY SAID SOMETHING NOBODY EXPECTED ────────────────────
--
-- The attack does not complete, and neither does anything else.
--
--   ERROR: column "role" is of type staff_role but expression is of type app_role
--
-- org_invites.role is `app_role`; staff.role is `staff_role`. Every version of
-- this function since 20260710190000 has assigned one straight to the other.
-- Postgres refuses the INSERT, the function aborts, and because it is one
-- transaction the user_roles row goes back too. Production agrees, and says so
-- more bluntly than any log could:
--
--   pending invites: 5      accepted invites: 0
--
-- Not one invitation has ever been accepted. Teammate invites have been broken
-- since the day they shipped, and five people are currently waiting on one.
--
-- THIS IS WHY THE TWO FIXES ARE IN ONE FILE. The security hole was real but
-- LATENT -- masked by a different bug in the same function. Repairing the cast
-- on its own, as a tidy little type fix, would have ACTIVATED the pre-claim on
-- the day it shipped. Anyone who finds the cast bug independently and fixes it
-- without this guard reopens the hole, which is the single most important
-- sentence in this file.
--
-- ── WHY THE OBVIOUS FIX IS WRONG ON ITS OWN ──────────────────────────────
--
-- "Require the token" breaks something deliberate. src/lib/invite-email.server.ts
-- lines 10-18 state the design in its own words:
--
--   "It is a convenience, not the mechanism. Nobody clicks a token link to
--    accept ... an invited person who never gets the mail and simply signs up
--    at the app with the invited address still lands in the right organization
--    with the right role."
--
-- That is a real property worth keeping: invite mail lands in spam constantly,
-- and a one-or-two-truck business does not want to debug deliverability to add
-- an office manager. The invite email did not even carry a token -- it linked
-- to a bare /auth -- so requiring one would have stranded every invitee until
-- the email was changed too.
--
-- ── WHAT THIS DOES INSTEAD: BOTH DOORS, EACH ONE LOCKED ──────────────────
--
-- TOKEN PATH. The function now takes `_token`. Supplied, it must match the
-- invite exactly, and the email must still match the signed-in account. The
-- invite email now carries this token (`/auth?invite=…`) and ensureBootstrapped
-- passes it through, so the link is a real mechanism rather than decoration.
--
-- EMAIL PATH, KEPT, WITH THE ATTACK REMOVED. Without a token, the invite is
-- accepted only if the account was created AFTER the invite was issued. That
-- is precisely the difference between the person who was invited and then
-- signed up -- the case the design note is protecting -- and the attacker who
-- claimed the address in advance, whose account necessarily predates the
-- invitation. The convenience survives; the pre-claim does not.
--
-- ── WHAT THIS DOES NOT CLOSE, SAID PLAINLY ───────────────────────────────
--
-- An attacker who registers an address AFTER an invitation has been issued,
-- and signs in before the real invitee does, still inherits the role: their
-- account is newer than the invite, so the timing test passes. Closing that
-- needs the token to be MANDATORY, which means accepting that an invitee who
-- never receives the mail cannot join. That is a product decision, not a
-- technical one, and it is not taken here.
--
-- It is a much narrower window than what existed before -- it requires knowing
-- an invitation was sent, to an address, within its lifetime -- but it is a
-- window, and a reader of this file should not have to discover that by
-- reading the SQL.
--
-- The durable fix for both is to stop confirming email addresses nobody has
-- proved they control. Then email-matching is safe on its own, because only
-- the mailbox holder can hold the account. That is a change to
-- registerAccount, deliberately not made here.

-- The zero-argument signature has to go rather than be replaced: adding a
-- DEFAULT parameter CREATES A SECOND FUNCTION, and PostgREST calling with no
-- arguments would then be ambiguous between them.
DROP FUNCTION IF EXISTS public.accept_org_invite_for_current_user();

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
  _inv public.org_invites;
  _existing_org uuid;
BEGIN
  IF _uid IS NULL THEN RETURN NULL; END IF;
  SELECT email, created_at INTO _email, _created FROM auth.users WHERE id = _uid;
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
    -- Email path, with the pre-claim removed. `created_at > _inv.created_at`
    -- is the whole of the fix: the invited person signs up after being
    -- invited; the attacker claimed the address before.
    SELECT * INTO _inv FROM public.org_invites
     WHERE lower(email) = lower(_email)
       AND status = 'pending'
       AND expires_at > now()
       AND created_at < _created
     ORDER BY created_at DESC LIMIT 1;

    -- Distinguish "no invitation" from "an invitation you must use the link
    -- for". Silently bootstrapping a personal org in the second case is how an
    -- invited teammate ends up permanently unable to accept: BUG-18 below
    -- refuses a second membership, and that refusal cannot be undone.
    IF _inv.id IS NULL AND EXISTS (
      SELECT 1 FROM public.org_invites
       WHERE lower(email) = lower(_email) AND status = 'pending' AND expires_at > now()
    ) THEN
      RAISE EXCEPTION 'This email has a pending invitation. Open the link in that invitation email to join.'
        USING ERRCODE = 'raise_exception';
    END IF;
  END IF;

  IF _inv.id IS NULL THEN RETURN NULL; END IF;

  -- Don't double-add if already a member of that org. (Unchanged.)
  IF EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND organization_id = _inv.organization_id) THEN
    UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
    RETURN _inv.organization_id;
  END IF;

  -- BUG-18: already in a DIFFERENT organization. (Unchanged.)
  SELECT organization_id INTO _existing_org
    FROM public.user_roles WHERE user_id = _uid LIMIT 1;

  IF _existing_org IS NOT NULL THEN
    RAISE EXCEPTION 'This account already belongs to another organization. Ask the inviter to send the invitation to a different email address, or leave your current organization first.'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- platform_admin exists in app_role and NOT in staff_role, so it has no
  -- staff row to be. It is also not a thing anybody should be invited to a
  -- tenant as. Refused explicitly rather than left to fail on the cast.
  IF _inv.role::text = 'platform_admin' THEN
    RAISE EXCEPTION 'platform_admin cannot be granted by an organization invitation.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.user_roles(user_id, organization_id, role)
    VALUES (_uid, _inv.organization_id, _inv.role);
  -- THE CAST IS THE FIX FOR A SECOND, OLDER BUG. See the header: org_invites.role
  -- is app_role and staff.role is staff_role, and every version of this function
  -- since 2026-07-10 has assigned one to the other directly. Postgres refuses,
  -- the whole function aborts, and no invitation has ever been accepted.
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_inv.organization_id, _uid, _inv.role::text::public.staff_role,
            split_part(_email, '@', 1), _inv.role::text = 'tech');

  UPDATE public.org_invites SET status = 'accepted', accepted_at = now() WHERE id = _inv.id;
  RETURN _inv.organization_id;
END;
$$;

COMMENT ON FUNCTION public.accept_org_invite_for_current_user(text) IS
  'Accepts a pending org_invites row for the signed-in user. Either the invite token is supplied and must match, or the account must post-date the invitation -- which is what stops an address being claimed before it is invited. BUG-18 refusal of a second membership is unchanged.';

-- DROP discarded the old ACL, so both lines, every time.
REVOKE ALL ON FUNCTION public.accept_org_invite_for_current_user(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_org_invite_for_current_user(text) TO authenticated, service_role;

DO $verify$
DECLARE _src text; _n int;
BEGIN
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_org_invite_for_current_user';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one accept_org_invite_for_current_user overload, found %', _n;
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'accept_org_invite_for_current_user';

  IF _src NOT LIKE '%created_at < _created%' THEN
    RAISE EXCEPTION 'the email path no longer requires the account to post-date the invitation';
  END IF;
  IF _src NOT LIKE '%token = _token%' THEN
    RAISE EXCEPTION 'the token path is missing';
  END IF;
END
$verify$;
