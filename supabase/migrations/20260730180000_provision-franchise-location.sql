-- BUILD-6: the franchise CREATES a location. Owner design, 2026-07-30.
--
-- The code-redemption flow I built assumed the franchisee already had a
-- HoundStack organization and would attach it. That is backwards for how
-- franchises actually onboard: the franchise opens a location, hands the
-- operator a login, and the operator starts working. Making them sign up
-- independently, then paste a code, is homework nobody asked for.
--
-- So the parent provisions: name the location, list the people who work there
-- with their roles, done. Everyone named gets an invite email and signs
-- themselves in. The franchisee performs no setup step at all.
--
-- ON THE OBJECTION I RAISED AND WITHDRAW. I argued that letting a parent enter
-- an email would leak which businesses use HoundStack and who owns them. That
-- was an argument against a DIFFERENT design — one where the parent looks up an
-- EXISTING organization by email. Here the parent creates a brand-new
-- organization and invites people into it. There is no lookup, so there is
-- nothing to enumerate. The owner was right and the objection does not apply.
--
-- It is also SAFER than the code flow, for the reason BUG-19 existed: a
-- newly-created organization has no prior data and no prior owner, so there is
-- nothing to hijack. The consent problem only ever existed for pre-existing
-- organizations.
--
-- The code flow is KEPT, not replaced. It covers the other real case — a
-- franchise acquiring an operator already running on HoundStack, whose data
-- must survive the transition. That one genuinely needs the existing
-- organization's owner to agree, which is exactly what redeeming does.
--
-- BILLING IS DELIBERATELY NOT DECIDED HERE. Enterprise is a custom quote
-- through sales, and the owner's intent is that pricing follows LOCATIONS
-- rather than the parent buying a plan. A new location is therefore created
-- with no plan_id, which resolves to the Launch floor in plan_tier_for_org()
-- rather than silently inheriting Enterprise. That is a placeholder, not a
-- decision — inventing a billing arrangement here would be worse than leaving
-- an obvious gap for BUILD-2 and sales to fill.
--
-- Idempotent.

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

  -- Refuse UP FRONT if any invitee already belongs to an organization. BUG-18
  -- means their invite would be rejected at acceptance time — so without this
  -- the parent would create a location, send five emails, and only discover
  -- days later that two people can never get in. Better to fail before
  -- anything exists than to half-build a location.
  SELECT array_agg(DISTINCT lower(m.value->>'email'))
    INTO _taken
    FROM jsonb_array_elements(coalesce(_members, '[]'::jsonb)) AS m
   WHERE EXISTS (
     SELECT 1 FROM auth.users u
      JOIN public.user_roles ur ON ur.user_id = u.id
     WHERE lower(u.email) = lower(m.value->>'email')
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
  -- billing note in the header.
  INSERT INTO public.organizations (name, timezone)
  VALUES (btrim(_name), _tz)
  RETURNING id INTO _new_org;

  -- The franchise link is set at birth. No consent step is needed because the
  -- organization is the parent's own creation; there is no other party yet.
  UPDATE public.organizations SET parent_organization_id = _parent WHERE id = _new_org;
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _parent;

  -- One invite per person, reusing org_invites and the acceptance flow that
  -- already exists rather than inventing a second way to join an organization.
  FOR _m IN SELECT * FROM jsonb_array_elements(coalesce(_members, '[]'::jsonb))
  LOOP
    _email := lower(btrim(_m->>'email'));
    CONTINUE WHEN _email IS NULL OR _email = '';
    _role := coalesce((_m->>'role')::public.app_role, 'tech'::public.app_role);
    IF _role = 'platform_admin' THEN
      RAISE EXCEPTION 'A location cannot be given platform-admin access.';
    END IF;

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
  'BUILD-6: a franchise owner opens a location — creates the organization already linked to the parent and issues an org_invite per named person. No consent step, because the organization is the parent''s own creation with no prior owner or data. Refuses up front if any invitee already belongs to an organization (BUG-18 would reject their invite later). Billing is deliberately unset; see the migration header.';

REVOKE ALL ON FUNCTION public.provision_franchise_location(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.provision_franchise_location(text, jsonb) TO authenticated, service_role;
