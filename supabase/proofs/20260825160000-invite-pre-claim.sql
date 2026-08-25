-- Proof for 20260825160000 — an invited email could be claimed in advance.
--
-- Five assertions. The last one restores the old body and shows the attacker
-- succeeding, because a test that only shows the fix working cannot tell you
-- the fix is what did it.

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE _i (k text PRIMARY KEY, v text);
GRANT SELECT ON _i TO authenticated;

-- auth.users.created_at is the pivot of this whole fix, so the fixture sets it
-- explicitly rather than relying on insertion order.
CREATE OR REPLACE FUNCTION pg_temp.mkuser(_email text, _created timestamptz)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE _id uuid;
BEGIN
  INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                          email_confirmed_at, created_at, updated_at)
  VALUES (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'authenticated',
          'authenticated', _email, '', _created, _created, _created)
  RETURNING id INTO _id;
  RETURN _id;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.be(_k text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE _u text;
BEGIN
  SELECT v INTO _u FROM _i WHERE k = _k;
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', _u, 'role','authenticated')::text, true);
END $$;

DO $$
DECLARE _org uuid; _owner uuid; _attacker uuid; _hire uuid; _prior uuid;
        _tok text := 'tok_' || encode(gen_random_bytes(12),'hex');
        _tok2 text := 'tok_' || encode(gen_random_bytes(12),'hex');
BEGIN
  PERFORM set_config('app.allow_protected_org_write','1',true);

  -- The attacker claimed the address a week before anyone invited it.
  _attacker := pg_temp.mkuser('newhire@acme-proof.invalid', now() - interval '7 days');
  -- Somebody who already had an account before being invited (legitimate).
  _prior    := pg_temp.mkuser('prior@acme-proof.invalid',   now() - interval '7 days');
  _owner    := pg_temp.mkuser('owner@acme-proof.invalid',   now() - interval '30 days');

  INSERT INTO public.organizations (name) VALUES ('Acme Proof Pets') RETURNING id INTO _org;
  INSERT INTO public.user_roles (user_id, organization_id, role) VALUES (_owner, _org, 'owner');

  -- Invitations issued NOW, i.e. after both accounts above already existed.
  INSERT INTO public.org_invites (organization_id, email, role, token, invited_by, status, expires_at, created_at)
  VALUES (_org, 'newhire@acme-proof.invalid', 'office_manager', _tok, _owner, 'pending', now() + interval '7 days', now());
  INSERT INTO public.org_invites (organization_id, email, role, token, invited_by, status, expires_at, created_at)
  VALUES (_org, 'prior@acme-proof.invalid', 'office_manager', _tok2, _owner, 'pending', now() + interval '7 days', now());

  -- The real hire signs up AFTER being invited. Same address is impossible
  -- here (the attacker holds it), so this is a third address invited now and
  -- signed up in a moment.
  INSERT INTO public.org_invites (organization_id, email, role, token, invited_by, status, expires_at, created_at)
  VALUES (_org, 'genuine@acme-proof.invalid', 'tech', 'tok_genuine', _owner, 'pending', now() + interval '7 days', now() - interval '1 minute');
  _hire := pg_temp.mkuser('genuine@acme-proof.invalid', now());

  INSERT INTO _i VALUES ('org',_org::text),('attacker',_attacker::text),('hire',_hire::text),
                        ('prior',_prior::text),('tok',_tok),('tok2',_tok2);
  PERFORM set_config('app.allow_protected_org_write','',true);
END $$;

-- ── 1. THE ATTACK: account predates the invitation ───────────────────────
DO $$
DECLARE _org uuid; _ok boolean := false; _n int;
BEGIN
  PERFORM pg_temp.be('attacker');
  BEGIN
    _org := public.accept_org_invite_for_current_user();
  EXCEPTION WHEN raise_exception THEN
    _ok := true;
    RAISE NOTICE '1 PASS  pre-claim refused: %', SQLERRM;
  END;
  IF NOT _ok AND _org IS NOT NULL THEN
    RAISE EXCEPTION '1 FAIL  the attacker inherited org %', _org;
  END IF;
  SELECT count(*) INTO _n FROM public.user_roles
   WHERE user_id = (SELECT v::uuid FROM _i WHERE k='attacker');
  IF _n <> 0 THEN RAISE EXCEPTION '1 FAIL  attacker holds % role row(s)', _n; END IF;
  IF NOT _ok THEN RAISE NOTICE '1 PASS  pre-claim returned NULL and granted nothing'; END IF;
END $$;

-- ── 2. THE CONVENIENCE SURVIVES: invited, then signed up ─────────────────
DO $$
DECLARE _org uuid;
BEGIN
  PERFORM pg_temp.be('hire');
  _org := public.accept_org_invite_for_current_user();
  IF _org IS NULL THEN
    RAISE EXCEPTION '2 FAIL  a genuine invitee could not join without a token';
  END IF;
  RAISE NOTICE '2 PASS  invited-then-signed-up still joins with no token (org %)', _org;
END $$;

-- ── 3. THE TOKEN LETS A PRE-EXISTING ACCOUNT IN ──────────────────────────
DO $$
DECLARE _org uuid; _tok text;
BEGIN
  SELECT v INTO _tok FROM _i WHERE k='tok2';
  PERFORM pg_temp.be('prior');
  _org := public.accept_org_invite_for_current_user(_tok);
  IF _org IS NULL THEN
    RAISE EXCEPTION '3 FAIL  a correct token did not admit a pre-existing account';
  END IF;
  RAISE NOTICE '3 PASS  correct token admits an account older than its invite';
END $$;

-- ── 4. THE ATTACKER'S OWN TOKEN IS NOT A SKELETON KEY ────────────────────
-- The attacker holds their own invite's token (it was mailed to the address
-- they control). It must not let them accept somebody else's invitation.
DO $$
DECLARE _org uuid; _tok2 text;
BEGIN
  SELECT v INTO _tok2 FROM _i WHERE k='tok2';   -- prior@'s token
  PERFORM pg_temp.be('attacker');
  _org := public.accept_org_invite_for_current_user(_tok2);
  IF _org IS NOT NULL THEN
    RAISE EXCEPTION '4 FAIL  a token accepted an invitation addressed to somebody else';
  END IF;
  RAISE NOTICE '4 PASS  a token is useless against an invitation for another address';
END $$;

-- ── 5. MUTATION: fix ONLY the cast, and the attacker walks in ────────────
--
-- The most valuable mutation available here, and the one the migration header
-- warns about. The security hole was masked by the app_role/staff_role type
-- error: the attacker matched the invitation but the function aborted before
-- granting anything. So the tempting tidy fix — repair the cast, ship it —
-- ACTIVATES the pre-claim. This restores exactly that: old matching, new cast.
DO $$
DECLARE _org uuid; _n int;
BEGIN
  EXECUTE $f$
    CREATE OR REPLACE FUNCTION public.accept_org_invite_for_current_user(_token text DEFAULT NULL)
    RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $b$
    DECLARE _uid uuid := auth.uid(); _email text; _inv public.org_invites;
    BEGIN
      IF _uid IS NULL THEN RETURN NULL; END IF;
      SELECT email INTO _email FROM auth.users WHERE id = _uid;
      SELECT * INTO _inv FROM public.org_invites
       WHERE lower(email) = lower(_email) AND status='pending' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1;
      IF _inv.id IS NULL THEN RETURN NULL; END IF;
      INSERT INTO public.user_roles(user_id, organization_id, role)
        VALUES (_uid, _inv.organization_id, _inv.role);
      INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
        VALUES (_inv.organization_id, _uid, _inv.role::text::public.staff_role,
                split_part(_email,'@',1), _inv.role::text = 'tech');
      RETURN _inv.organization_id;
    END $b$;
  $f$;
  PERFORM pg_temp.be('attacker');
  _org := public.accept_org_invite_for_current_user();
  IF _org IS NULL THEN
    RAISE EXCEPTION '5 INCONCLUSIVE  the cast-only body refused too — this test proves nothing';
  END IF;
  SELECT count(*) INTO _n FROM public.staff
   WHERE user_id = (SELECT v::uuid FROM _i WHERE k='attacker');
  RAISE NOTICE '5 PASS  cast-only fix let the attacker inherit org % with % staff row(s) — the timing guard is what stops it', _org, _n;
END $$;

ROLLBACK;
