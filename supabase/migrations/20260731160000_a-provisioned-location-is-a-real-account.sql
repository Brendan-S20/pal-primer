-- BUILD-6 / BUILD-7. Two things provision_franchise_location got wrong, both
-- only visible once a UI actually called it.
--
-- ── 1. A PROVISIONED LOCATION WAS FREE FOREVER ─────────────────────────────
--
-- organizations.plan_status defaults to 'free' and trial_ends_at to NULL. The
-- only place that sets them is bootstrap_organization, which this function
-- does not go through — it INSERTs the organization itself. So every location
-- opened this way lands in trialStateFor()'s `none` phase: no trial, no
-- countdown, no banner, and — when TRIAL_ENFORCEMENT flips on with Stripe —
-- nothing to enforce against. Provisioning would have been a way to mint
-- permanently free organizations, one per click, and the only ones who could
-- do it are the Enterprise franchises whose locations are precisely what the
-- pricing is supposed to follow.
--
-- The `none` phase exists for the six organizations that predate trials
-- entirely. Backfilling a clock onto an account someone has used for months
-- would be a surprise; starting one on an organization created ten seconds ago
-- is just what every other new organization already gets.
--
-- So a location starts a 14-day trial exactly like any other signup. Same
-- number, read from the same constant, and the existing TRIAL_DAYS parity test
-- covers it because it reads the number out of bootstrap's migration.
--
-- This does NOT decide franchise billing — the header of
-- 20260730180000 still stands: Enterprise is a custom quote and plan_id is
-- still left to the entry tier. It decides only that a location is a normal
-- account with a normal clock, so the arrangement has to be made rather than
-- silently defaulted to free.
--
-- ── 2. A LOCATION COULD BE CREATED THAT NOBODY COULD ADMINISTER ────────────
--
-- The function accepted an empty member list, or a list of nothing but techs.
-- Either way the new organization has no owner — and the parent is NOT a member
-- of its own child (that is why franchise_rollup has to be SECURITY DEFINER).
-- Nobody can invite anyone, change a setting, or connect Stripe. There is no
-- product path to repair it, because every path runs as a member of the org.
--
-- The parent would get a location in their rollup showing zeros forever and no
-- way to tell why. So: name an owner, or the location is not created. The
-- refusal costs one form field; the alternative is an unreachable organization
-- that only a platform admin can delete.
--
-- Duplicate addresses are refused. Two invites to the same person means
-- accept_org_invite_for_current_user takes the newest and leaves its twin
-- pending forever — debris nobody's UI shows. I first wrote this to collapse
-- them instead, and testing the collapse showed why that is wrong: listing
-- someone as owner and then again as tech silently made them a tech, which is
-- the entire owner requirement below defeated by a typo. Two roles for one
-- person is a question, and the answer is not the database's to invent.
--
-- Idempotent. Signature unchanged.

CREATE OR REPLACE FUNCTION public.provision_franchise_location(
  _name text,
  _members jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _parent uuid;
  _new_org uuid;
  _tz text;
  _m jsonb;
  _email text;
  _role public.app_role;
  _taken text[];
  _clean jsonb;
  _trial_days constant int := 14;
BEGIN
  SELECT organization_id INTO _parent FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can open a location.';
  END IF;
  -- Two levels only, same rule as redemption.
  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _parent AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is a location within another franchise, so it cannot open locations of its own.';
  END IF;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'Give the location a name.';
  END IF;

  -- Normalise: blank rows dropped (an unused row in a form is not a mistake),
  -- addresses lowercased and trimmed, the role default resolved once here
  -- rather than in four separate places below.
  SELECT coalesce(jsonb_agg(jsonb_build_object('email', s.email, 'role', s.role)), '[]'::jsonb)
    INTO _clean
    FROM (
      SELECT lower(btrim(m.value->>'email')) AS email,
             coalesce((m.value->>'role')::public.app_role, 'tech'::public.app_role)::text AS role
        FROM jsonb_array_elements(coalesce(_members, '[]'::jsonb)) AS m
       WHERE btrim(coalesce(m.value->>'email', '')) <> ''
    ) s;

  -- See header. Refused, not collapsed.
  SELECT array_agg(e.email) INTO _taken
    FROM (SELECT x.value->>'email' AS email FROM jsonb_array_elements(_clean) x
           GROUP BY 1 HAVING count(*) > 1) e;
  IF _taken IS NOT NULL THEN
    RAISE EXCEPTION 'This address is listed more than once: %. Each person gets one row, with the one role they hold at this location.',
      array_to_string(_taken, ', ');
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(_clean) e
              WHERE e.value->>'role' = 'platform_admin') THEN
    RAISE EXCEPTION 'A location cannot be given platform-admin access.';
  END IF;

  -- See header §2. A location with no owner is an organization nobody inside
  -- the product can reach, including the franchise that created it.
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(_clean) e
                  WHERE e.value->>'role' = 'owner') THEN
    RAISE EXCEPTION 'Name someone as the owner of this location. A location without an owner has nobody who can invite staff, change its settings or take payment — and the franchise is not a member of its own locations, so it cannot do those things on their behalf.';
  END IF;

  -- Refuse UP FRONT if any invitee already belongs to an organization. BUG-18
  -- means their invite would be rejected at acceptance time — so without this
  -- the parent would create a location, send five emails, and only discover
  -- days later that two people can never get in. Better to fail before
  -- anything exists than to half-build a location.
  SELECT array_agg(DISTINCT e.value->>'email') INTO _taken
    FROM jsonb_array_elements(_clean) e
   WHERE EXISTS (
     SELECT 1 FROM auth.users u
      JOIN public.user_roles ur ON ur.user_id = u.id
     WHERE lower(u.email) = e.value->>'email'
   );
  IF _taken IS NOT NULL AND array_length(_taken, 1) > 0 THEN
    RAISE EXCEPTION 'These people already belong to another HoundStack organization, so they cannot be added to a new location: %. Use a different address for them, or link their existing business with an invitation code instead.',
      array_to_string(_taken, ', ');
  END IF;

  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;

  -- The hatch must be open BEFORE the INSERT, not after it. Creating an
  -- organization fires trg_reassign_billing_tier, which calls
  -- assign_billing_tier_for_org and writes billing_tier and plan_id — both
  -- protected columns. Without this the insert itself raises
  -- "These account fields can only be changed by the platform." Normal signup
  -- never hits it because that path runs as service_role, which the trigger
  -- exempts; a tenant-initiated creation like this one does not.
  PERFORM set_config('app.allow_protected_org_write', '1', true);

  -- plan_id is whatever assign_billing_tier_for_org decides for a brand-new
  -- org (the entry tier). Deliberately NOT inherited from the parent — see the
  -- billing note in 20260730180000. The trial, by contrast, is not a billing
  -- decision: it is the clock every new organization gets. See header §1.
  INSERT INTO public.organizations (name, timezone, plan_status, trial_ends_at)
  VALUES (btrim(_name), _tz, 'trialing'::public.org_plan_status,
          now() + (_trial_days || ' days')::interval)
  RETURNING id INTO _new_org;

  -- The franchise link is set at birth. No consent step is needed because the
  -- organization is the parent's own creation; there is no other party yet.
  UPDATE public.organizations SET parent_organization_id = _parent WHERE id = _new_org;
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _parent;

  -- One invite per person, reusing org_invites and the acceptance flow that
  -- already exists rather than inventing a second way to join an organization.
  FOR _m IN SELECT * FROM jsonb_array_elements(_clean)
  LOOP
    _email := _m->>'email';
    _role := (_m->>'role')::public.app_role;

    INSERT INTO public.org_invites (organization_id, email, role, token, invited_by)
    VALUES (
      _new_org,
      _email,
      _role,
      -- gen_random_uuid() rather than pgcrypto's gen_random_bytes: this
      -- function pins search_path to public+pg_temp, and pgcrypto lives in the
      -- extensions schema, so gen_random_bytes is not resolvable here. Two
      -- UUIDs give 256 bits of randomness, which is more than the token needs.
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      auth.uid()
    );
  END LOOP;

  RETURN _new_org;
END;
$$;

COMMENT ON FUNCTION public.provision_franchise_location(text, jsonb) IS
  'BUILD-6: a franchise owner opens a location — creates the organization already linked to the parent, on its own 14-day trial like any other new account, and issues an org_invite per named person. Requires an owner among them: the parent is not a member of its own child, so an ownerless location is unreachable by anyone. Refuses up front if any invitee already belongs to an organization (BUG-18 would reject their invite later). plan_id is still deliberately unset; see 20260730180000.';

REVOKE ALL ON FUNCTION public.provision_franchise_location(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_franchise_location(text, jsonb) TO authenticated, service_role;
