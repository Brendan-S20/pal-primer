-- A royalty rate set on the 5th could not reach the draft it was for.
--
-- Owner decision, 2026-08-19: A DRAFT TAKES THE CURRENT RATE.
--
-- ── WHAT THE FREEZE ACTUALLY FROZE ────────────────────────────────────────
--
-- 20260801080000 fixed "changing a royalty rate restated closed periods" by
-- making `kids` prefer the rate already written on the statement for that
-- period:
--
--     coalesce((SELECT fri.royalty_percent FROM franchise_royalty_invoices fri
--                WHERE fri.child_organization_id = o.id
--                  AND fri.period_start = _start AND fri.period_end = _end),
--              o.franchise_royalty_percent, 0)
--
-- with no condition on that statement's status. Read together with the upsert
-- one CTE below it — `ON CONFLICT … DO UPDATE … WHERE status = 'draft'` — the
-- two rules cover disjoint halves of the same set, and the freeze covers the
-- wrong half:
--
--   ISSUED / PAID / VOID  the upsert refuses to write. The frozen rate is read
--                         and then thrown away with everything else on the row.
--                         Nothing here was ever at risk.
--
--   DRAFT                 the upsert writes. And the frozen rate is exactly
--                         the figure it writes back, so the one row the
--                         generator is allowed to move was pinned to whatever
--                         percentage happened to be configured the night the
--                         nightly job first cut it.
--
-- So the freeze could only ever bite a draft. The lived consequence: the
-- nightly job writes last month's drafts on the 1st, an owner sets a location's
-- rate on the 5th, presses "Generate last month's royalties", and gets a
-- rewritten draft at the OLD percentage — plus a toast reading "Generated 2
-- royalty invoices", because the RPC did write 2 rows. Every other figure on
-- them moved; the rate did not.
--
-- ── WHY THIS IS NOT A REVERSAL OF 20260801080000 ──────────────────────────
--
-- That migration's evidence was `july_royalty_at_10pct=10000 ->
-- after_rate_change=25000`, and its stated complaint was "restated CLOSED
-- periods". A draft is not a closed period. It is the working figure between
-- generating and issuing, and `src/lib/franchise-settlement.ts` has said so all
-- along: "a late adjustment moves the figures underneath, and only stops once
-- the statement leaves draft". The rate was the one input that did not follow
-- that rule.
--
-- The protection that mattered is untouched and is asserted below: ISSUING is
-- what makes a statement a bill, and an issued statement's rate — like every
-- other number on it — cannot move. Two mechanisms now say that instead of
-- one, which is the correct number: the upsert guard refuses the write, and
-- `fri.status <> 'draft'` keeps the historical rate available to any future
-- reader of that row.
--
-- ── THE CHANGE ────────────────────────────────────────────────────────────
--
-- One predicate: `AND fri.status <> 'draft'` in the sub-select. `status` is
-- NOT NULL DEFAULT 'draft', so this admits exactly issued, paid and void.
--
-- Everything else in this function is the DEPLOYED body verbatim. That is not
-- a formality: the live routine is newer than several migration files that
-- claim to define it — 20260730200000 still filters `status = 'succeeded'` and
-- has no adjustments CTE at all. Rewriting from that copy would have silently
-- reverted the collector split, the ('succeeded','refunded') fix, the period
-- window on adjustments and the void-release accounting. Read out of
-- `pg_proc.prosrc` on 2026-08-19 and confirmed md5-identical to
-- 20260801080000's copy (9be12b10917add795e3648e4ed2b9a39, 5435 bytes), so
-- that file — not the older ones — is the one in force.
--
-- ── EXPOSURE ──────────────────────────────────────────────────────────────
--
-- Latent. `franchise_royalty_invoices` holds zero rows, `franchise_adjustments`
-- holds zero rows, and the one franchise in the database (Demo Pet Waste Co and
-- its two locations) has franchise_royalty_percent 0.00 on all three orgs. So
-- there is no statement anywhere carrying a stale rate, nothing to remediate,
-- and — worth saying plainly — no way to measure this fix against a real
-- statement. The behaviour above was read out of the routine, not observed on
-- a row.

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
-- Every assertion below reads the routine this migration just wrote. None of
-- them needs a tenant, a statement, a row or a cron job, so they hold on a
-- database built from these files and nothing else. `prosrc` rather than
-- `pg_get_functiondef`, and the function is named, per the working agreement.
DO $$
DECLARE
  _src  text;
  _kids text;
  _at   int;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'generate_franchise_settlements'
     AND p.pronargs = 3;

  IF _src IS NULL THEN
    RAISE EXCEPTION 'generate_franchise_settlements(uuid, date, date) is not present after this migration';
  END IF;

  -- The frozen-rate lookup, isolated, so this cannot be satisfied by the word
  -- 'draft' appearing somewhere else in a 5KB routine.
  _at   := position('WITH kids' in _src);
  _kids := substring(_src from _at for position('  rev AS (' in _src) - _at);
  IF _kids = '' OR _kids IS NULL THEN
    RAISE EXCEPTION 'could not isolate the kids CTE — this check is measuring nothing';
  END IF;

  IF position('fri.status <> ''draft''' in _kids) = 0 THEN
    RAISE EXCEPTION 'the frozen-rate lookup does not exclude drafts, so a rate change still cannot reach the one statement it is allowed to move';
  END IF;

  -- The real protection, which this change must not have bought its fix with.
  IF position('WHERE public.franchise_royalty_invoices.status = ''draft''' in _src) = 0 THEN
    RAISE EXCEPTION 'the upsert no longer refuses to rewrite a statement that has left draft';
  END IF;

  -- Two, not one: `adj` and `consume` must agree about the period window or an
  -- adjustment gets consumed without being counted.
  IF (SELECT count(*) FROM regexp_matches(_src, 'fa\.created_at < _to', 'g')) <> 2 THEN
    RAISE EXCEPTION 'the period filter must appear in BOTH adj and consume';
  END IF;
END $$;

-- ── WHAT WAS MEASURED RATHER THAN ESTABLISHED ─────────────────────────────
--
-- A premise, not a product: these counts describe whatever database this runs
-- against on the day it runs. On a fresh build they are all zero and there is
-- nothing to say — which is itself worth printing, because "the check found no
-- stale drafts" and "there was nothing here to check" must not look the same in
-- a log. WARNING, never EXCEPTION.
DO $$
DECLARE
  _drafts   bigint;
  _stale    bigint;
  _families bigint;
BEGIN
  SELECT count(*) INTO _families
    FROM public.organizations WHERE parent_organization_id IS NOT NULL;

  IF _families = 0 THEN
    RAISE WARNING 'rate-freeze survey SKIPPED: no organization has a parent, so no settlement statement can exist to carry a stale rate. Nothing was measured.';
    RETURN;
  END IF;

  SELECT count(*) INTO _drafts
    FROM public.franchise_royalty_invoices WHERE status = 'draft';

  SELECT count(*) INTO _stale
    FROM public.franchise_royalty_invoices fri
    JOIN public.organizations o ON o.id = fri.child_organization_id
   WHERE fri.status = 'draft'
     AND fri.royalty_percent IS DISTINCT FROM coalesce(o.franchise_royalty_percent, 0);

  RAISE WARNING 'rate-freeze survey: % draft statement(s), of which % carried a percentage that no longer matches the location''s configured rate. Regenerating those periods now moves them.',
    _drafts, _stale;
END $$;

-- ── THE GRANTS, RESTATED RATHER THAN ASSUMED ──────────────────────────────
--
-- CREATE OR REPLACE of an existing function keeps its ACL, so on the live
-- database this changes nothing — `generate_franchise_settlements` is already
-- authenticated + service_role and nothing else (read from `proacl`,
-- 2026-08-19). On a fresh replay it is not a no-op at all: CREATE FUNCTION in
-- `public` hands EXECUTE to PUBLIC, and `anon` is a member of PUBLIC, so a
-- database built from these files would publish the royalty billing engine —
-- a write path that also admits `service_role` — to anyone holding the
-- publishable key. That is exactly the fault
-- 20260809180000 was written about: a lockdown that only held for the
-- functions that existed the day it ran.
--
-- `service_role` is deliberate and load-bearing: the nightly job calls this
-- routine (src/routes/api/public/hooks/nightly.ts) and the authorization block
-- above admits `auth.role() = 'service_role'` for exactly that path.
REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;
