-- BUILD-6 (phase 1): let a franchise actually be assembled, with consent.
--
-- Until now there was no way to link a child organization to a parent through
-- the product at all. `parent_organization_id` was never written anywhere in
-- TypeScript; the franchise page's own empty state said "any organization whose
-- parent_organization_id points at this one will roll up here", which described
-- editing the column by hand. BUG-19 then protected that column, so the manual
-- workaround is gone too. This is the replacement.
--
-- CONSENT IS THE POINT. BUG-19 existed because one organization could declare
-- itself another's child unilaterally. The fix is not merely to lock the column
-- — it is to make the relationship require both sides. So:
--
--   1. The PARENT generates a link code. Generating it grants nothing.
--   2. The code is handed to the franchisee out of band.
--   3. The CHILD's owner redeems it. That act — by the child, on the child's
--      own account — is the consent.
--
-- Deliberately a code rather than "parent enters the child's email or org id":
-- that shape would let anyone probe which organizations exist and who owns
-- them, and it would put the decision on the wrong side of the relationship.
-- The referral system already uses a code for the same reason, so this reuses a
-- pattern the product and its users have seen before rather than inventing one.
--
-- STRUCTURE IS EXACTLY TWO LEVELS. A parent may not itself have a parent, and a
-- child may not itself have children. Enforced at redemption, not by
-- convention. Deeper hierarchies are not a small change — rollup, royalty
-- math, and every RLS decision would each need a recursive form — and
-- pretending to support them by leaving the door open is how you get a cycle in
-- production. If real multi-level franchising is ever needed it should be a
-- deliberate piece of work, starting by removing these two checks on purpose.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.franchise_link_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Short, unambiguous, and read aloud over the phone without confusion:
  -- Crockford-ish alphabet, no I/L/O/U. Generated in the function below.
  code text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 8 AND 24),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- Single-use and time-bounded. A franchise link is a durable, consequential
  -- relationship; a code that works forever is a credential nobody rotates.
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  used_at timestamptz,
  used_by_org_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS franchise_link_codes_parent_idx
  ON public.franchise_link_codes (parent_organization_id, created_at DESC);

ALTER TABLE public.franchise_link_codes ENABLE ROW LEVEL SECURITY;

-- Only the issuing parent's members can see their own codes. The REDEEMER never
-- selects from this table — redemption goes through the SECURITY DEFINER
-- function below, which looks the code up itself. That means a stranger cannot
-- enumerate or test codes through PostgREST.
DROP POLICY IF EXISTS franchise_link_codes_select ON public.franchise_link_codes;
CREATE POLICY franchise_link_codes_select ON public.franchise_link_codes
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), parent_organization_id));

GRANT SELECT ON public.franchise_link_codes TO authenticated;
GRANT ALL ON public.franchise_link_codes TO service_role;

COMMENT ON TABLE public.franchise_link_codes IS
  'BUILD-6: single-use, expiring codes a franchise parent issues so a child organization can consent to being linked. Redemption is performed BY the child (redeem_franchise_link_code), which is what makes the link consensual — see BUG-19 for why that matters.';

-- ── Issue a code ────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_franchise_link_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _org uuid;
  _code text;
BEGIN
  SELECT organization_id INTO _org FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  IF NOT public.has_role(auth.uid(), _org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can invite a location to this franchise.';
  END IF;

  -- Two levels only: an org that is itself somebody's child cannot recruit.
  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _org AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is already part of another franchise, so it cannot have locations of its own.';
  END IF;

  -- Ambiguity-free alphabet: no I, L, O, U.
  SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                           (floor(random() * 32) + 1)::int, 1), '')
    INTO _code
    FROM generate_series(1, 10);

  INSERT INTO public.franchise_link_codes (parent_organization_id, code, created_by)
  VALUES (_org, _code, auth.uid());

  RETURN _code;
END;
$$;

COMMENT ON FUNCTION public.create_franchise_link_code() IS
  'BUILD-6: issues a single-use 14-day code the franchise parent hands to a prospective child. Owner-only. Grants nothing by itself — the link happens when the CHILD redeems it.';

-- ── Redeem a code (this is the consent) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.redeem_franchise_link_code(_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _child uuid;
  _rec   public.franchise_link_codes;
BEGIN
  SELECT organization_id INTO _child FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _child IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  -- Joining a franchise changes who can see this organization's numbers. Only
  -- the owner may agree to that.
  IF NOT public.has_role(auth.uid(), _child, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can join a franchise.';
  END IF;

  -- Locked so two simultaneous redemptions of the same code cannot both win.
  SELECT * INTO _rec FROM public.franchise_link_codes
   WHERE upper(trim(code)) = upper(trim(_code))
   FOR UPDATE;

  -- One message for every "this code won't work" case. Distinguishing
  -- not-found from expired from already-used would turn this into an oracle for
  -- guessing codes.
  IF _rec.id IS NULL
     OR _rec.used_at IS NOT NULL
     OR _rec.revoked_at IS NOT NULL
     OR _rec.expires_at <= now() THEN
    RAISE EXCEPTION 'That code is not valid. Ask the franchise owner for a new one.';
  END IF;

  IF _rec.parent_organization_id = _child THEN
    RAISE EXCEPTION 'An organization cannot be its own parent.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _child AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization already belongs to a franchise.';
  END IF;

  -- Two levels only, from the other side: a child may not already be a parent.
  IF EXISTS (SELECT 1 FROM public.organizations WHERE parent_organization_id = _child) THEN
    RAISE EXCEPTION 'This organization has locations of its own, so it cannot also be a location of another franchise.';
  END IF;

  -- Belt and braces against a cycle even though the two rules above make one
  -- unreachable today. Cheap, and the thing it prevents is unrecoverable.
  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _rec.parent_organization_id AND parent_organization_id = _child) THEN
    RAISE EXCEPTION 'That would create a circular franchise relationship.';
  END IF;

  -- BUG-19 protects these columns; this is a sanctioned writer, so it opens the
  -- same transaction-local hatch the trigger already provides rather than
  -- introducing a second bypass.
  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations
     SET parent_organization_id = _rec.parent_organization_id
   WHERE id = _child;

  UPDATE public.organizations
     SET is_franchise_parent = true
   WHERE id = _rec.parent_organization_id;

  UPDATE public.franchise_link_codes
     SET used_at = now(), used_by_org_id = _child
   WHERE id = _rec.id;

  RETURN _rec.parent_organization_id;
END;
$$;

COMMENT ON FUNCTION public.redeem_franchise_link_code(text) IS
  'BUILD-6: the child organization''s owner consents to joining a franchise. Enforces two-level structure, no self-parenting, no cycles, and single use. This is the ONLY sanctioned writer of parent_organization_id besides the platform.';

-- ── Leaving a franchise ─────────────────────────────────────────────────────
--
-- A relationship that can only be entered is a trap. Either side can end it:
-- the child because it is their business, the parent because they may be
-- offboarding a franchisee. Royalty invoices already raised are deliberately
-- left alone — unlinking is not a way to erase what was owed.

CREATE OR REPLACE FUNCTION public.unlink_franchise_child(_child_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _caller_org uuid;
  _parent uuid;
BEGIN
  SELECT organization_id INTO _caller_org FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _caller_org IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;

  SELECT parent_organization_id INTO _parent
    FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;

  -- Owner of either side.
  IF NOT (
    (_caller_org = _child_org_id AND public.has_role(auth.uid(), _child_org_id, 'owner'::public.app_role))
    OR (_caller_org = _parent AND public.has_role(auth.uid(), _parent, 'owner'::public.app_role))
  ) THEN
    RAISE EXCEPTION 'Only the owner of the location or of the franchise can end this link.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations
     SET parent_organization_id = NULL,
         franchise_royalty_percent = 0
   WHERE id = _child_org_id;

  -- Stop calling an org a franchise parent once its last location leaves.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE parent_organization_id = _parent) THEN
    UPDATE public.organizations SET is_franchise_parent = false WHERE id = _parent;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.unlink_franchise_child(uuid) IS
  'BUILD-6: ends a franchise link. Either side''s owner may do it. Royalty invoices already raised are intentionally preserved — unlinking is not a way to erase what was owed.';

-- ── Repair mark_franchise_parent ────────────────────────────────────────────
--
-- The live version raises `function public.has_role(uuid, app_role) does not
-- exist` on EVERY call: it passes two arguments to a function that only exists
-- with three, and tests for an 'admin' role that is not a member of the
-- app_role enum. The "Mark this org as a franchise parent" button has therefore
-- never worked once. Verified by calling it.
--
-- Rewritten against the real signature. It is now also nearly redundant —
-- redeem_franchise_link_code sets is_franchise_parent when a location actually
-- joins — so it is kept only for the case of declaring intent before the first
-- location is linked, and it no longer claims a role that does not exist.
CREATE OR REPLACE FUNCTION public.mark_franchise_parent(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.has_role(auth.uid(), _org_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can mark this organization as a franchise parent.';
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _org_id AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is already a location within another franchise.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _org_id;
END;
$$;

COMMENT ON FUNCTION public.mark_franchise_parent(uuid) IS
  'BUILD-6: marks an organization as a franchise parent. Repaired — the previous body called a two-argument has_role() that does not exist and checked for an ''admin'' role absent from the app_role enum, so every call raised 42883.';

REVOKE ALL ON FUNCTION public.create_franchise_link_code() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.redeem_franchise_link_code(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unlink_franchise_child(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_franchise_link_code() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.redeem_franchise_link_code(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_franchise_child(uuid) TO authenticated, service_role;
