-- Unlinking a location left the next franchise collecting its money.
--
-- Owner decision, 2026-08-19: clear the routing state on unlink, in the same
-- transaction that ends the link.
--
-- ── WHAT UNLINK LEFT BEHIND ───────────────────────────────────────────────
--
-- `unlink_franchise_child` clears `parent_organization_id` and resets
-- `franchise_royalty_percent` to 0. It does not touch the other two columns the
-- franchise relationship writes:
--
--   payments_collected_by_parent   set by set_location_payment_routing — TRUE
--                                  means this location's customer payments are
--                                  charged into the FRANCHISE's Stripe account
--   chargeback_responsibility      set by set_chargeback_responsibility — who
--                                  absorbs a reversal
--
-- Today that is harmless, and only by luck: `resolveOrgStripeAccount` requires
-- both the flag AND a non-null `parent_organization_id`, so with the parent
-- gone the stale `true` decides nothing. It is one clause away from mattering.
--
-- The sequence that makes it matter needs no bug anywhere else. A location
-- leaves franchise A with the flag set. Months later it redeems franchise B's
-- link code — `redeem_franchise_link_code` sets `parent_organization_id` and
-- nothing more, because a freshly recruited location is expected to arrive with
-- the defaults. The row now says: parent is B, and B collects this location's
-- customer money. Nobody agreed to that. Nobody is shown it either — the
-- routing screen reads the flag it finds and reports it as the arrangement. The
-- chargeback split travels the same way: a location that negotiated
-- `franchise` liability with A arrives at B still carrying it.
--
-- ── WHY IN SQL AND NOT IN THE CALLER ──────────────────────────────────────
--
-- Clearing them in TypeScript after the RPC returns would make the app a second
-- writer of routing state, outside the transaction that ends the link and
-- outside the `app.allow_protected_org_write` guard that lets these columns be
-- written at all. Two writers, one of which can crash between statements, is
-- how a row ends up half-unlinked — parent gone, money still routed. The unlink
-- is one act and it is one UPDATE.
--
-- ── THE VALUES ARE THE COLUMN DEFAULTS, CHECKED RATHER THAN ASSUMED ───────
--
-- "Reset to what a never-linked org has" is only meaningful if those are
-- actually the defaults, so the values are read out of the catalog below rather
-- than trusted: `payments_collected_by_parent` is NOT NULL DEFAULT false and
-- `chargeback_responsibility` is NOT NULL DEFAULT 'location'. Neither is
-- nullable, so "clear" means the default and not NULL — writing NULL would
-- violate the constraint and take the whole unlink with it.
--
-- ── WHAT IS NOT ADDED HERE ────────────────────────────────────────────────
--
-- No plan check. 20260819140000 gated four franchise RPCs on
-- `franchise_structure`, and this one is deliberately not among them for the
-- same reason `removeFranchiseLocation` has no `requireEntitlement`: a paywall
-- may withhold a capability, but it must not lock an organization inside a
-- relationship it wants out of. A franchise whose plan lapses must still be
-- able to release its locations.
--
-- Everything else is the DEPLOYED body verbatim, read from `pg_proc.prosrc` on
-- 2026-08-19 (1110 bytes; the file at 20260730160000 differs only by comments).
--
-- ── EXPOSURE ──────────────────────────────────────────────────────────────
--
-- Latent, and unmeasurable today: `payments_collected_by_parent` is false on
-- all four organizations in the database and `chargeback_responsibility` is
-- 'location' on all four, so there is no row carrying stale routing and no
-- unlink has ever happened to leave one. Nothing is being remediated here; the
-- fix is for the next unlink, not for a row that exists.

CREATE OR REPLACE FUNCTION public.unlink_franchise_child(_child_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _caller_org uuid;
  _parent uuid;
BEGIN
  SELECT parent_organization_id INTO _parent
    FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;

  SELECT organization_id INTO _caller_org FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;

  IF NOT (
    (_caller_org = _parent AND public.has_role(auth.uid(), _parent, 'owner'::public.app_role))
    OR public.is_platform_admin(auth.uid())
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can remove a location. If you need to leave a franchise, contact them — or contact HoundStack support if they are unreachable.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  -- Everything the franchise relationship wrote, cleared together. The two
  -- routing columns were the ones left behind: with the parent gone they decide
  -- nothing, and the moment this location joins a DIFFERENT franchise they
  -- decide that the new parent collects its customers' money and carries — or
  -- does not carry — its chargebacks. These are the column defaults, which is
  -- what a location that has never been in a franchise has.
  UPDATE public.organizations
     SET parent_organization_id = NULL,
         franchise_royalty_percent = 0,
         payments_collected_by_parent = false,
         chargeback_responsibility = 'location'
   WHERE id = _child_org_id;

  -- Stop calling an org a franchise parent once its last location is removed.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE parent_organization_id = _parent) THEN
    UPDATE public.organizations SET is_franchise_parent = false WHERE id = _parent;
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.unlink_franchise_child(uuid) IS
  'BUILD-6: removes a location from a franchise. The FRANCHISE OWNER or a platform admin only — a franchisee cannot detach itself, because exit is governed by the franchise agreement rather than by software. Platform admins are included so a franchisee whose parent has abandoned them is not permanently stranded. Royalty invoices already raised are preserved. 2026-08-19: also clears payments_collected_by_parent and chargeback_responsibility, which used to survive the unlink and be inherited by the next franchise the location joined.';

-- ── WHAT THIS FILE ESTABLISHES, PROVABLE FROM ANY STARTING STATE ──────────
--
-- That the routine clears both columns, and — the part worth more than the
-- first — that the values it clears them TO are the same values the table gives
-- a row that was never in a franchise. That second question is answered from
-- the catalog, so it stays true if a later migration changes a default and
-- forgets this file. No tenant, no organization and no unlink is needed for
-- either. `prosrc`, and the function is named.
DO $$
DECLARE
  _src         text;
  _routing_def text;
  _cb_def      text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'unlink_franchise_child';

  IF _src IS NULL THEN
    RAISE EXCEPTION 'unlink_franchise_child(uuid) is not present after this migration';
  END IF;

  IF position('payments_collected_by_parent = false' in _src) = 0 THEN
    RAISE EXCEPTION 'unlink_franchise_child still leaves payments_collected_by_parent set, so the next franchise this location joins silently collects its customer payments';
  END IF;
  IF position('chargeback_responsibility = ''location''' in _src) = 0 THEN
    RAISE EXCEPTION 'unlink_franchise_child still leaves chargeback_responsibility set, so a liability split agreed with one franchise is inherited by the next';
  END IF;
  IF position('parent_organization_id = NULL' in _src) = 0 THEN
    RAISE EXCEPTION 'unlink_franchise_child no longer ends the link itself';
  END IF;
  IF position('is_platform_admin(auth.uid())' in _src) = 0
     OR position('has_role(auth.uid(), _parent, ''owner''::public.app_role)' in _src) = 0 THEN
    RAISE EXCEPTION 'unlink_franchise_child lost the authorization that decides who may remove a location';
  END IF;

  SELECT column_default INTO _routing_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'payments_collected_by_parent';
  SELECT column_default INTO _cb_def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'chargeback_responsibility';

  IF _routing_def IS NULL OR position('false' in _routing_def) = 0 THEN
    RAISE EXCEPTION 'organizations.payments_collected_by_parent no longer defaults to false (%), so unlink is resetting to something a never-linked org does not have', coalesce(_routing_def, '(none)');
  END IF;
  IF _cb_def IS NULL OR position('location' in _cb_def) = 0 THEN
    RAISE EXCEPTION 'organizations.chargeback_responsibility no longer defaults to location (%), so unlink is resetting to something a never-linked org does not have', coalesce(_cb_def, '(none)');
  END IF;
END $$;

-- ── WHAT WAS MEASURED RATHER THAN ESTABLISHED ─────────────────────────────
--
-- How many rows carry stale routing is a fact about this database today. On a
-- fresh build there are no organizations at all and the log says so, rather than
-- printing a zero that reads like a clean bill of health. WARNING, never
-- EXCEPTION.
DO $$
DECLARE _orgs bigint; _stranded bigint;
BEGIN
  SELECT count(*) INTO _orgs FROM public.organizations;
  IF _orgs = 0 THEN
    RAISE WARNING 'stale-routing survey SKIPPED: there are no organizations, so no unlinked location could be carrying routing state. Nothing was measured.';
    RETURN;
  END IF;

  SELECT count(*) INTO _stranded
    FROM public.organizations
   WHERE parent_organization_id IS NULL
     AND (payments_collected_by_parent OR chargeback_responsibility <> 'location');

  IF _stranded = 0 THEN
    RAISE WARNING 'stale-routing survey: % organization(s) checked, none of them carrying franchise routing state without a franchise. Nothing to remediate.', _orgs;
  ELSE
    RAISE WARNING 'stale-routing survey: % of % organization(s) have no parent but still carry franchise routing state left over from a previous link. This migration stops it happening again; it does not clean those rows, which is a decision about somebody''s money and not a migration''s to make.',
      _stranded, _orgs;
  END IF;
END $$;

-- ── THE GRANTS, RESTATED RATHER THAN ASSUMED ──────────────────────────────
--
-- A no-op live (already authenticated + service_role, read from `proacl` on
-- 2026-08-19) and not a no-op on a fresh replay, where CREATE FUNCTION in
-- `public` hands EXECUTE to PUBLIC and `anon` is a member of PUBLIC.
REVOKE ALL ON FUNCTION public.unlink_franchise_child(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unlink_franchise_child(uuid) TO authenticated, service_role;
