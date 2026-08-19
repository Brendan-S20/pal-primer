-- Four franchise RPCs the paywall migration walked past.
--
-- Owner decision, 2026-08-19: gate all four with the same check the other six
-- carry — and keep the nightly job working.
--
-- ── WHAT 20260731230000 LEFT OPEN ─────────────────────────────────────────
--
-- That migration made the franchise paywall real in SQL for six parent-side
-- RPCs, and its header names exactly two deliberate exclusions:
-- `redeem_franchise_link_code` (the CHILD side — a franchisee is somebody
-- else's location and is most likely on Launch) and `franchise_signals`
-- (platform-admin only). These four are on neither list. They are
-- SECURITY DEFINER, granted to `authenticated`, owner-role-checked, and carry
-- no plan check at all:
--
--   set_location_payment_routing   which Stripe account collects a location's
--                                  customer payments
--   set_chargeback_responsibility  who absorbs a reversal, location or franchise
--   generate_franchise_settlements cuts the royalty statements
--   mark_franchise_parent          declares an organization a franchise parent
--
-- They were missed, not decided. The tell is `franchise_payment_routing`: the
-- READ of the routing table was gated by that migration while both WRITES that
-- change it were not — nobody chooses that on purpose.
--
-- Live shape, 2026-08-19: `Demo Pet Waste Co` is on `enterprise` with two
-- children on `launch`. If that parent's plan lapses, rollup, link codes,
-- royalty rates and provisioning correctly refuse — while the same owner can
-- still redirect where a location's customer money lands, move chargeback
-- liability onto a franchisee, cut settlement statements and re-mark itself a
-- parent, from one `supabase.rpc(...)` in an ordinary signed-in session. The
-- TypeScript funnel refuses all of it; the funnel is not the boundary, which is
-- the whole argument of guardrail 10.4 and of the migration this completes.
--
-- ── THE NIGHTLY JOB KEEPS RUNNING ─────────────────────────────────────────
--
-- `generate_franchise_settlements` is the one of the four that is NOT only
-- reached by a person: its authorization block admits `auth.role() =
-- 'service_role'` for the nightly cron (src/routes/api/public/hooks/nightly.ts).
-- Owner decision, explicitly: billing a lapsed customer's statements is a
-- separate question from letting them reconfigure the franchise, and the cron
-- keeps generating for everyone. So the plan check on that function is skipped
-- for `service_role`.
--
-- Platform admins are skipped too, on the same reasoning 20260731230000 gives
-- for leaving `franchise_signals` alone: platform staff are not a tenant and
-- have no plan, and making an operator's ability to act depend on the
-- customer's purchase gates the wrong party. That exemption is written as an
-- explicit `is_platform_admin` term rather than left implicit, because the
-- three other functions here do not admit platform admins at all and a reader
-- should be able to see which is which.
--
-- Nothing else about the four changes. Each body below is the DEPLOYED routine
-- verbatim with one IF added after the role check — read from `pg_proc.prosrc`
-- on 2026-08-19 and confirmed md5-identical to the migration files that define
-- them (set_location_payment_routing 2e273db6…, set_chargeback_responsibility
-- f6619bd6…, mark_franchise_parent f2e22cc6…). `generate_franchise_settlements`
-- carries forward 20260819120000's draft-rate fix, which is two files earlier in
-- this same sequence; restating the whole routine is the only way plpgsql lets
-- you add a line to it, so the two are read together or not at all.
--
-- ── WHERE THE CHECK GOES, AND IN WHOSE WORDS ──────────────────────────────
--
-- Immediately AFTER the existing role check, never before: "you are not the
-- owner of this franchise" is about who the caller is and must not be leaked
-- past by an upgrade prompt, which would tell a stranger which plan a franchise
-- is on. The message is `upgradeMessage()` from src/lib/entitlements.ts with the
-- tier interpolated, PLAN_UPGRADE_REQUIRED code included, so the client's
-- isPlanUpgradeRequiredError() recognises an RPC rejection exactly as it
-- recognises a server-fn one. tests/entitlement-parity.test.ts ties the two
-- wordings together and now derives WHICH functions must carry the check from
-- the migrations themselves rather than from a hand-kept list of six.
--
-- ── EFFECT ON THE LIVE DATABASE ───────────────────────────────────────────
--
-- Nothing that works today stops working. The only franchise parent is on
-- `enterprise`, so `has_plan_entitlement(parent, 'franchise_structure')` is
-- true for it; every one of these call sites already runs the TypeScript
-- entitlement funnel before reaching the RPC; and no cron path is gated. The
-- change is only visible to a caller who skips the app, which is the caller it
-- is for.

-- ── set_location_payment_routing: whose Stripe account collects ────────────
CREATE OR REPLACE FUNCTION public.set_location_payment_routing(
  _child_org_id uuid,
  _collected_by_parent boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _parent uuid;
  _parent_acct text;
  _charges_ok boolean;
BEGIN
  SELECT parent_organization_id INTO _parent
    FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can change how a location collects payment.';
  END IF;

  -- The role check settled WHO may act; this settles whether the organization
  -- bought the capability. Second, never first. See the header.
  IF NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  -- Refuse to point a location at an account that cannot actually charge.
  -- Silently routing a live location's customers at a half-onboarded Stripe
  -- account would fail every payment attempt with no obvious cause.
  IF _collected_by_parent THEN
    SELECT stripe_connect_account_id, stripe_connect_charges_enabled
      INTO _parent_acct, _charges_ok
      FROM public.organizations WHERE id = _parent;
    IF _parent_acct IS NULL THEN
      RAISE EXCEPTION 'Connect the franchise''s own Stripe account first — locations cannot collect into an account that does not exist.';
    END IF;
    IF NOT coalesce(_charges_ok, false) THEN
      RAISE EXCEPTION 'The franchise''s Stripe account cannot accept charges yet. Finish Stripe onboarding before routing a location to it.';
    END IF;
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations
     SET payments_collected_by_parent = _collected_by_parent
   WHERE id = _child_org_id;
END;
$function$;

-- ── set_chargeback_responsibility: who absorbs a reversal ──────────────────
CREATE OR REPLACE FUNCTION public.set_chargeback_responsibility(_child_org_id uuid, _responsibility text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _parent uuid;
BEGIN
  IF _responsibility NOT IN ('location','franchise','split') THEN
    RAISE EXCEPTION 'Responsibility must be location, franchise, or split.';
  END IF;
  SELECT parent_organization_id INTO _parent FROM public.organizations WHERE id = _child_org_id;
  IF _parent IS NULL THEN
    RAISE EXCEPTION 'That organization is not part of a franchise.';
  END IF;
  IF NOT public.has_role(auth.uid(), _parent, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the franchise owner can set who absorbs chargebacks.';
  END IF;

  -- The role check settled WHO may act; this settles whether the organization
  -- bought the capability. Second, never first. See the header.
  IF NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET chargeback_responsibility = _responsibility WHERE id = _child_org_id;
END;
$function$;

-- ── mark_franchise_parent: declaring yourself a franchise ──────────────────
CREATE OR REPLACE FUNCTION public.mark_franchise_parent(_org_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NOT public.has_role(auth.uid(), _org_id, 'owner'::public.app_role) THEN
    RAISE EXCEPTION 'Only the owner can mark this organization as a franchise parent.';
  END IF;

  -- The role check settled WHO may act; this settles whether the organization
  -- bought the capability. Second, never first. See the header.
  IF NOT public.has_plan_entitlement(_org_id, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_org_id));
  END IF;

  IF EXISTS (SELECT 1 FROM public.organizations
              WHERE id = _org_id AND parent_organization_id IS NOT NULL) THEN
    RAISE EXCEPTION 'This organization is already a location within another franchise.';
  END IF;

  PERFORM set_config('app.allow_protected_org_write', '1', true);
  UPDATE public.organizations SET is_franchise_parent = true WHERE id = _org_id;
END;
$function$;

-- ── generate_franchise_settlements: the statements themselves ──────────────
--
-- Carries 20260819120000's `fri.status <> 'draft'` unchanged — see that file for
-- why the rate freeze was reaching the one row it was not meant to.
CREATE OR REPLACE FUNCTION public.generate_franchise_settlements(_parent uuid, _start date, _end date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _n integer := 0;
  _tz text;
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
    OR public.is_platform_admin(auth.uid())
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can generate settlements.';
  END IF;

  -- The role check settled WHO may act; this settles whether the organization
  -- bought the capability. Second, never first.
  --
  -- Two callers are exempt and both are deliberate. `service_role` is the
  -- nightly job: the owner decided that billing a lapsed customer's statements
  -- is a separate question from letting them reconfigure the franchise, so the
  -- cron keeps generating for everyone. A platform admin is not a tenant and
  -- has no plan of their own, so gating them here would gate the operator on
  -- the customer's purchase — the same reasoning 20260731230000 gives for
  -- leaving franchise_signals alone.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.is_platform_admin(auth.uid())
     AND NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  IF _end <= _start THEN
    RAISE EXCEPTION 'The period end must be after its start.';
  END IF;

  -- The PARENT's clock, deliberately, and unchanged by the 2026-08-19 rollup
  -- decision: a settlement period is one document covering every location, so
  -- it needs one pair of boundaries. `franchise_rollup` is the opposite case —
  -- a per-location row, which now cuts its month on the location's own clock.
  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;
  _from := _start::timestamp AT TIME ZONE _tz;
  _to   := _end::timestamp   AT TIME ZONE _tz;

  WITH kids AS (
    SELECT o.id,
           -- A SETTLED period keeps the rate it was settled at. There is no
           -- rate-history table, so the statement IS the history — but only
           -- once it has left draft, because only then has anyone been told a
           -- number. While it is still a draft the current rate wins, which is
           -- the whole point of regenerating: an owner who fixes a percentage
           -- and presses Generate is asking for exactly that.
           --
           -- Without `<> 'draft'` this coalesce and the `WHERE status =
           -- 'draft'` on the upsert below cover opposite halves of the set,
           -- and the freeze lands on the only half the generator can write.
           coalesce(
             (SELECT fri.royalty_percent
                FROM public.franchise_royalty_invoices fri
               WHERE fri.child_organization_id = o.id
                 AND fri.period_start = _start
                 AND fri.period_end   = _end
                 AND fri.status <> 'draft'),
             o.franchise_royalty_percent,
             0
           ) AS pct
    FROM public.organizations o WHERE o.parent_organization_id = _parent
  ),
  rev AS (
    SELECT k.id AS child, k.pct,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id = _parent), 0)::bigint AS by_parent,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS by_location,
           coalesce(sum(p.amount_cents), 0)::bigint AS total
    FROM kids k
    LEFT JOIN public.payments p
      ON p.organization_id = k.id
     AND p.status IN ('succeeded', 'refunded')
     AND p.created_at >= _from
     AND p.created_at <  _to
    GROUP BY k.id, k.pct
  ),
  adj AS (
    SELECT fa.child_organization_id AS child,
           coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = _parent), 0)::bigint AS loc_owes,
           coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS fran_owes
    FROM public.franchise_adjustments fa
    LEFT JOIN public.franchise_royalty_invoices fri ON fri.id = fa.applied_settlement_id
    WHERE fa.parent_organization_id = _parent
      -- Only what was already known when the period closed. Without this an
      -- adjustment landed on whichever statement happened to be cut first.
      AND fa.created_at < _to
      AND (
        fa.status = 'pending'
        OR (fa.status = 'applied'
            AND fri.period_start = _start
            AND fri.period_end = _end
            AND fri.status = 'draft')
      )
    GROUP BY fa.child_organization_id
  ),
  calc AS (
    SELECT r.child, r.pct, r.by_parent, r.by_location, r.total,
           round(r.total * r.pct / 100.0)::bigint AS royalty,
           coalesce(a.loc_owes, 0) AS loc_owes,
           coalesce(a.fran_owes, 0) AS fran_owes,
           (r.by_parent
            - round(r.total * r.pct / 100.0)
            - coalesce(a.loc_owes, 0)
            + coalesce(a.fran_owes, 0))::bigint AS balance
    FROM rev r LEFT JOIN adj a ON a.child = r.child
  ),
  ins AS (
    INSERT INTO public.franchise_royalty_invoices (
      parent_organization_id, child_organization_id, period_start, period_end,
      revenue_cents, royalty_percent, amount_cents,
      direction, royalty_cents, net_due_cents,
      revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
      adjustments_applied_cents, status, created_by
    )
    SELECT _parent, child, _start, _end,
           total, pct, royalty,
           CASE WHEN balance > 0 THEN 'franchise_owes_location'
                WHEN balance < 0 THEN 'location_owes_franchise'
                ELSE 'settled' END,
           royalty, abs(balance),
           by_parent, by_location,
           loc_owes - fran_owes, 'draft', auth.uid()
    FROM calc
    ON CONFLICT (child_organization_id, period_start, period_end) DO UPDATE
      SET revenue_cents = EXCLUDED.revenue_cents,
          royalty_percent = EXCLUDED.royalty_percent,
          amount_cents = EXCLUDED.amount_cents,
          direction = EXCLUDED.direction,
          royalty_cents = EXCLUDED.royalty_cents,
          net_due_cents = EXCLUDED.net_due_cents,
          revenue_collected_by_parent_cents = EXCLUDED.revenue_collected_by_parent_cents,
          revenue_collected_by_location_cents = EXCLUDED.revenue_collected_by_location_cents,
          adjustments_applied_cents = EXCLUDED.adjustments_applied_cents
      WHERE public.franchise_royalty_invoices.status = 'draft'
    RETURNING id, child_organization_id
  ),
  consume AS (
    UPDATE public.franchise_adjustments fa
       SET status = 'applied', applied_settlement_id = i.id
      FROM ins i
     WHERE fa.child_organization_id = i.child_organization_id
       AND fa.parent_organization_id = _parent
       AND fa.status = 'pending'
       -- Must match `adj` exactly. Consuming something the statement did not
       -- count would strand it, which is defect 1 by another route.
       AND fa.created_at < _to
    RETURNING fa.id
  )
  SELECT count(*)::integer INTO _n FROM ins;

  RETURN _n;
END;
$function$;

-- ── WHAT THIS FILE ESTABLISHES, PROVABLE FROM ANY STARTING STATE ──────────
--
-- Four routines carry a franchise_structure check, positioned after their role
-- check, and the settlement generator still lets the cron through. No tenant,
-- no plan row and no cron schedule is needed to ask any of it — the answers are
-- in the routines this file just wrote. `prosrc`, and every function is named.
DO $$
DECLARE
  _fn   text;
  _src  text;
  _role int;
  _plan int;
BEGIN
  FOREACH _fn IN ARRAY ARRAY[
    'set_location_payment_routing',
    'set_chargeback_responsibility',
    'mark_franchise_parent',
    'generate_franchise_settlements'
  ] LOOP
    SELECT p.prosrc INTO _src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _fn;

    IF _src IS NULL THEN
      RAISE EXCEPTION 'public.% is not present after this migration', _fn;
    END IF;

    _plan := position('has_plan_entitlement(' in _src);
    _role := position('has_role(auth.uid()' in _src);

    IF _plan = 0 THEN
      RAISE EXCEPTION 'public.% has no franchise_structure check, so an ordinary session can still call it on any plan', _fn;
    END IF;
    IF position('''franchise_structure''' in _src) = 0 THEN
      RAISE EXCEPTION 'public.% checks an entitlement that is not franchise_structure', _fn;
    END IF;
    IF _role = 0 THEN
      RAISE EXCEPTION 'public.% lost its role check while gaining a plan check', _fn;
    END IF;
    IF _plan < _role THEN
      RAISE EXCEPTION 'public.% asks about the plan before it asks who the caller is, which tells a stranger what plan the organization is on', _fn;
    END IF;
    IF position('PLAN_UPGRADE_REQUIRED' in _src) = 0
       OR position('initcap(public.plan_tier_for_org(' in _src) = 0 THEN
      RAISE EXCEPTION 'the refusal public.% gives has drifted from upgradeMessage(), so the client will show "Not authorized" instead of an upgrade prompt', _fn;
    END IF;
  END LOOP;

  -- The nightly job. This is the one exemption the owner asked for by name, and
  -- it is the one a later edit is most likely to tidy away.
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_franchise_settlements';
  IF position('auth.role() IS DISTINCT FROM ''service_role''' in _src) = 0 THEN
    RAISE EXCEPTION 'the settlement generator now applies its plan check to the nightly job, which would stop cutting statements for any franchise whose plan lapses';
  END IF;
  IF position('auth.role() = ''service_role''' in _src) = 0 THEN
    RAISE EXCEPTION 'the settlement generator no longer admits service_role at all, so the nightly job cannot call it';
  END IF;
END $$;

-- ── WHAT WAS MEASURED RATHER THAN ESTABLISHED ─────────────────────────────
--
-- Whether anybody is about to be locked out is a fact about this database on
-- this day, not about this change. A fresh build has no organizations at all,
-- and the log should say that rather than print a comforting zero. WARNING,
-- never EXCEPTION — a replay must not fail because nobody has bought Enterprise
-- in an empty database.
DO $$
DECLARE _parents bigint; _unentitled bigint;
BEGIN
  SELECT count(*) INTO _parents
    FROM public.organizations o
   WHERE o.is_franchise_parent
      OR EXISTS (SELECT 1 FROM public.organizations c WHERE c.parent_organization_id = o.id);

  IF _parents = 0 THEN
    RAISE WARNING 'franchise paywall survey SKIPPED: no organization is a franchise parent, so no caller could be affected by these four gates. Nothing was measured.';
    RETURN;
  END IF;

  SELECT count(*) INTO _unentitled
    FROM public.organizations o
   WHERE (o.is_franchise_parent
          OR EXISTS (SELECT 1 FROM public.organizations c WHERE c.parent_organization_id = o.id))
     AND NOT public.has_plan_entitlement(o.id, 'franchise_structure');

  RAISE WARNING 'franchise paywall survey: % franchise parent(s), of which % lack franchise_structure and will now be refused by these four RPCs as they already are by the other six. The nightly settlement run is unaffected.',
    _parents, _unentitled;
END $$;

-- ── THE GRANTS, RESTATED RATHER THAN ASSUMED ──────────────────────────────
--
-- A no-op against the live database — all four are already authenticated +
-- service_role and nothing else (read from `proacl`, 2026-08-19) — and not a
-- no-op on a fresh replay, where CREATE FUNCTION in `public` hands EXECUTE to
-- PUBLIC and `anon` is a member of PUBLIC. Narrowing what a plan may reach
-- while quietly widening who may call it would be a poor trade.
REVOKE ALL ON FUNCTION public.set_location_payment_routing(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_chargeback_responsibility(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.mark_franchise_parent(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_location_payment_routing(uuid, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_chargeback_responsibility(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_franchise_parent(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
