-- Make the franchise paywall real in the database.
--
-- ── WHAT COULD BE OBTAINED WITHOUT PAYING FOR IT ────────────────────────────
--
-- houndstack.com/pricing sells "parent and child organization structure with
-- full rollup" and "franchise management, royalty billing, and regional
-- dashboards" at Enterprise. Until this migration, the only thing standing
-- between a $79 Launch organization and all of it was TypeScript.
--
-- Every parent-side franchise RPC is granted to `authenticated` and checks only
-- ROLE — has_role(auth.uid(), org, 'owner'). None of them mentioned the plan.
-- The plan check lived exclusively in resolveOrgId() in
-- src/lib/franchise.functions.ts (and its twins in franchise-routing and
-- franchise-provision), which is a funnel the app chooses to walk through, not
-- a boundary. A browser holding an ordinary signed-in session can call
-- supabase.rpc(...) directly and never enter it.
--
-- Concretely, the owner of a Launch organization could:
--   create_franchise_link_code()        mint a recruiting code,
--   provision_franchise_location(...)   open new locations outright,
--   franchise_rollup() / _children()    read every location's clients, visits,
--                                       revenue and A/R,
--   franchise_payment_routing()         see whose Stripe account collects,
--   set_child_royalty_percent(...)      and set what each location owes them.
--
-- That is the entire Enterprise franchise capability, obtained for $79 by
-- skipping one TypeScript function. Guardrail 10.4 already says hidden UI is
-- not authorization; the same is true of a paywall.
--
-- has_plan_entitlement() has existed since 20260729130000 and was called by
-- NOTHING — a SQL mirror of PLAN_ENTITLEMENTS that no policy and no function
-- ever consulted. This is its first caller.
--
-- ── WHERE THE CHECK GOES ────────────────────────────────────────────────────
--
-- Immediately AFTER each function's existing role check, never before it. The
-- two failures answer different questions and a caller should meet them in that
-- order: "you are not the owner of this franchise" is about who they are, and
-- must not be leaked past by an upgrade prompt; "your plan doesn't include
-- this" is about what the organization bought. Reversing them would tell a
-- stranger which plan a franchise is on.
--
-- The message mirrors upgradeMessage() in src/lib/entitlements.ts exactly,
-- PLAN_UPGRADE_REQUIRED code included, so the client's
-- isPlanUpgradeRequiredError() recognises an RPC rejection the same way it
-- recognises a server-fn one, and the owner is shown an upgrade prompt rather
-- than "Not authorized" — which would send a paying owner to ask their admin
-- for access they already hold. The tier display name is initcap() of the tier
-- slug, which is exactly TIER_NAMES; tests/entitlement-parity.test.ts asserts
-- that equivalence so the two cannot drift.
--
-- ── WHAT IS DELIBERATELY NOT GATED ──────────────────────────────────────────
--
-- redeem_franchise_link_code() — the CHILD side. A franchisee is a location
-- somebody else recruited, and is most likely on Launch or Growth. Requiring
-- Enterprise to accept an invitation would mean linking only works if every
-- location independently buys the most expensive plan, which is not the
-- product being sold. Same reasoning, at length, in the header of
-- src/lib/franchise-membership.functions.ts, which is why that file's
-- joinFranchise has no requireEntitlement either. The parent pays for the
-- franchise; the child pays for their own business.
--
-- franchise_signals() — platform-admin only, gated by is_platform_admin().
-- Platform staff are not a tenant and have no plan; making their diagnostics
-- depend on some organization's tier would be gating the operator on the
-- customer's purchase.
--
-- ── SERVICE-ROLE / CRON EXPOSURE: NONE ──────────────────────────────────────
--
-- No exemption for auth.uid() IS NULL is needed, and none is added. Verified
-- live on 2026-07-31: no cron.job command, no other function body in pg_proc,
-- and no server route calls any of these six. More decisively, none of them
-- could work as service_role even today — each one either resolves the caller's
-- org from `user_roles WHERE user_id = auth.uid()` (null → "No organization for
-- this account.") or calls has_role(auth.uid(), ...), which is a plain EXISTS
-- against user_roles and is false for a null user. A null-uid caller therefore
-- never reaches the line this migration adds. An exemption here would be a hole
-- opened for a caller that does not exist.
--
-- ── EFFECT ON THE LIVE DATABASE: NOTHING BREAKS ─────────────────────────────
--
-- Checked before applying, against all 7 organizations that exist:
-- has_plan_entitlement(org, 'franchise_structure') is FALSE for every one of
-- them (six on `launch`, one — the demo org — on `scale`; no organization is on
-- `enterprise`). That sounds alarming and is not, because the TypeScript funnel
-- already refuses all seven today: every call site runs requireEntitlement
-- before it reaches the RPC. Nothing that works right now stops working. No
-- organization has a parent or a child either, so no franchise relationship
-- exists to disturb.
--
-- The practical consequence is for testing, not for customers: exercising the
-- franchise feature now requires putting the organization on the Enterprise
-- plan, in the app and in the database alike, instead of only in the database.
--
-- Idempotent: CREATE OR REPLACE throughout, and replacing a function preserves
-- its existing grants, so the EXECUTE privileges are deliberately not restated
-- here — restating them is how a migration accidentally widens one.

-- ── franchise_rollup: every location's clients, visits, revenue and A/R ─────
CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(organization_id uuid, organization_name text, active_clients integer, visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint, revenue_mtd_gross_cents bigint, refunds_mtd_cents bigint, ar_open_cents bigint, tech_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _tz text;
  _today date;
  _month_start timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise rollup';
  END IF;

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent_org));
  END IF;

  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent_org;
  _today := (now() AT TIME ZONE _tz)::date;
  _month_start := (date_trunc('month', (now() AT TIME ZONE _tz))) AT TIME ZONE _tz;

  RETURN QUERY
  WITH children AS (
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  ),
  money AS (
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
                      WHERE p.organization_id = c.id
                        AND p.status IN ('succeeded', 'refunded')
                        AND p.created_at >= _month_start), 0) AS gross,
           COALESCE((SELECT SUM(
                       CASE WHEN ri.kind = 'payment_chargeback_won'
                            THEN -(ri.detail->>'amount_cents')::bigint
                            ELSE  (ri.detail->>'amount_cents')::bigint END
                     )::bigint
                       FROM public.review_items ri
                      WHERE ri.organization_id = c.id
                        AND ri.kind IN ('payment_refunded','payment_chargeback','payment_chargeback_won')
                        AND ri.detected_at >= _month_start), 0) AS refunds
    FROM children c
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl
               WHERE cl.organization_id = c.id AND cl.active = true), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = _today), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = _today
                 AND v.status = 'completed'), 0),
    (m.gross - m.refunds)::bigint,
    m.gross,
    m.refunds,
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM children c JOIN money m ON m.id = c.id
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$function$;

-- ── franchise_children: the location list the rollup and trend both walk ────
CREATE OR REPLACE FUNCTION public.franchise_children(_parent_org uuid)
RETURNS TABLE(id uuid, name text)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise locations';
  END IF;

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent_org));
  END IF;

  RETURN QUERY
  SELECT o.id, o.name
  FROM public.organizations o
  WHERE o.parent_organization_id = _parent_org
  ORDER BY o.name;
END;
$function$;

-- ── franchise_payment_routing: whose Stripe account collects each location ──
CREATE OR REPLACE FUNCTION public.franchise_payment_routing()
RETURNS TABLE(child_organization_id uuid, child_name text, royalty_percent numeric, payments_collected_by_parent boolean, chargeback_responsibility text, child_account_id text, child_charges_enabled boolean)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _parent uuid;
BEGIN
  SELECT organization_id INTO _parent FROM public.user_roles
   WHERE user_id = auth.uid() LIMIT 1;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'No organization for this account.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can see payment routing.';
  END IF;

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  RETURN QUERY
  SELECT o.id, o.name, coalesce(o.franchise_royalty_percent, 0),
         coalesce(o.payments_collected_by_parent, false),
         coalesce(o.chargeback_responsibility, 'location'),
         o.stripe_connect_account_id,
         coalesce(o.stripe_connect_charges_enabled, false)
  FROM public.organizations o
  WHERE o.parent_organization_id = _parent
  ORDER BY o.name;
END;
$function$;

-- ── create_franchise_link_code: minting a recruiting code ───────────────────
CREATE OR REPLACE FUNCTION public.create_franchise_link_code()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_org));
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _org AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is already part of another franchise, so it cannot have locations of its own.';
  END IF;

  SELECT string_agg(substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                           (floor(random() * 32) + 1)::int, 1), '')
    INTO _code
    FROM generate_series(1, 10);

  INSERT INTO public.franchise_link_codes (parent_organization_id, code, created_by)
  VALUES (_org, _code, auth.uid());

  RETURN _code;
END;
$function$;

-- ── set_child_royalty_percent: what a location owes its franchise ───────────
--
-- Gated on the PARENT's plan, which is the organization the entitlement belongs
-- to and the one the check above already resolved from the child's own row. The
-- child's plan is irrelevant to whether the parent may bill them.
CREATE OR REPLACE FUNCTION public.set_child_royalty_percent(_child_org_id uuid, _percent numeric)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _parent_org uuid;
BEGIN
  IF _percent IS NULL OR _percent < 0 OR _percent > 100 THEN
    RAISE EXCEPTION 'Royalty percent must be between 0 and 100.';
  END IF;

  SELECT parent_organization_id INTO _parent_org
  FROM public.organizations WHERE id = _child_org_id;

  IF _parent_org IS NULL THEN
    RAISE EXCEPTION 'That location is not part of any franchise.';
  END IF;

  IF NOT public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise parent''s owner can set a royalty rate.';
  END IF;

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent_org, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent_org));
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  UPDATE public.organizations
     SET franchise_royalty_percent = _percent
   WHERE id = _child_org_id;
END;
$function$;

-- ── provision_franchise_location: opening a location outright ──────────────
CREATE OR REPLACE FUNCTION public.provision_franchise_location(_name text, _members jsonb DEFAULT '[]'::jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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

  -- BUILD-1: the role check settled WHO may act; this settles whether the
  -- organization bought the capability. See the header.
  IF NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _parent AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is a location within another franchise, so it cannot open locations of its own.';
  END IF;

  IF _name IS NULL OR btrim(_name) = '' THEN
    RAISE EXCEPTION 'Give the location a name.';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('email', s.email, 'role', s.role)), '[]'::jsonb)
    INTO _clean
    FROM (
      SELECT lower(btrim(m.value->>'email')) AS email,
             coalesce((m.value->>'role')::public.app_role, 'tech'::public.app_role)::text AS role
        FROM jsonb_array_elements(coalesce(_members, '[]'::jsonb)) AS m
       WHERE btrim(coalesce(m.value->>'email', '')) <> ''
    ) s;

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

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(_clean) e
                  WHERE e.value->>'role' = 'owner') THEN
    RAISE EXCEPTION 'Name someone as the owner of this location. A location without an owner has nobody who can invite staff, change its settings or take payment — and the franchise is not a member of its own locations, so it cannot do those things on their behalf.';
  END IF;

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

  PERFORM set_config('app.allow_protected_org_write', '1', true);

  INSERT INTO public.organizations (name, timezone, plan_status, billing_status, trial_ends_at)
  VALUES (btrim(_name), _tz, 'trialing'::public.org_plan_status,
          'trialing'::public.org_billing_status,
          now() + (_trial_days || ' days')::interval)
  RETURNING id INTO _new_org;

  UPDATE public.organizations SET parent_organization_id = _parent WHERE id = _new_org;
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _parent;

  FOR _m IN SELECT * FROM jsonb_array_elements(_clean)
  LOOP
    _email := _m->>'email';
    _role := (_m->>'role')::public.app_role;

    INSERT INTO public.org_invites (organization_id, email, role, token, invited_by)
    VALUES (
      _new_org,
      _email,
      _role,
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      auth.uid()
    );
  END LOOP;

  RETURN _new_org;
END;
$function$;
