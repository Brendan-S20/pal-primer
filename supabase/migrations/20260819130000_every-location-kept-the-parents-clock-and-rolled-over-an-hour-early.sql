-- Every location kept the parent's clock, and rolled over an hour early.
--
-- Owner decision, 2026-08-19: EACH LOCATION'S ROW USES ITS OWN CLOCK.
--
-- ── WHAT THIS SUPERSEDES, AND WHY ─────────────────────────────────────────
--
-- 20260730140000 wrote this, and it was right about the thing it was fixing:
--
--     -- Org-local "today", not the database's. The previous body used
--     -- CURRENT_DATE and date_trunc('month', now()), both of which resolve in
--     -- the DB session's timezone — so a parent in Chicago comparing "visits
--     -- today" across locations would see a boundary that matches none of
--     -- them. This is the BUG-12 mistake and it has now appeared five times.
--
-- The defect it named was the SERVER's clock, and replacing it with the
-- parent's clock did fix that. What the comment then argues for — one boundary
-- for the whole rollup, so the columns compare — is a second decision that got
-- carried along with the first, and it is the one being superseded here.
--
-- One clock does not make the numbers comparable; it makes them WRONG for
-- everyone but the parent. Measured live 2026-08-19: the parent
-- (America/New_York) starts August at 2026-08-01 04:00Z and both locations
-- (America/Chicago) start it at 05:00Z. A payment taken in that hour is in the
-- parent's August and the location's July. The location's own dashboard, which
-- cuts on the location's clock, disagrees with the franchise rollup by that
-- payment — and "visits today" flips over for a Chicago location at 11pm its
-- own time, so a truck still working at 11:30pm has its visits counted against
-- tomorrow on the franchise screen and against today on its own.
--
-- Of the two people who read these numbers, only one can be right, and it
-- should be the one whose day it is. A location's row in the rollup now answers
-- the same question its own dashboard answers, with the same boundaries.
--
-- ── WHAT THE OWNER ACCEPTED IN EXCHANGE ───────────────────────────────────
--
-- The parent's comparison is now across slightly different windows: Northside's
-- August and the franchise's August begin an hour apart. That is true of every
-- multi-timezone business and it is the smaller error — an hour's overlap in a
-- month-to-date comparison, against a location's own month being wrong all
-- month. Stated here because it is a real cost and the next person to read this
-- function should not have to rediscover it as a bug.
--
-- ── WHAT IS NOT CHANGED ───────────────────────────────────────────────────
--
-- `generate_franchise_settlements` still cuts its period on the PARENT's clock,
-- deliberately. A settlement statement is one document with one pair of
-- boundaries, agreed between two parties; a rollup is a table of per-location
-- rows, each answering "how is this location doing". Different shapes, different
-- right answers. 20260819120000 says the same thing from the other side.
--
-- The authorization block, the plan gate, the ten-column return shape, the
-- ('succeeded','refunded') status filter and the `revenue_cents`-preferring
-- reversal expression are the DEPLOYED body verbatim. Read from `pg_proc.prosrc`
-- on 2026-08-19: the live routine differs from 20260804080000 by exactly one
-- two-line comment (2962 bytes live against 3094 in the file) and by nothing
-- executable. A first draft of that migration invented a 7-column return shape
-- and would have broken every caller; the shape below is checked against
-- `pg_get_function_result` after the replace.
--
-- ── EXPOSURE ──────────────────────────────────────────────────────────────
--
-- One franchise exists (Demo Pet Waste Co, America/New_York, with Northside and
-- Southside on America/Chicago), so the divergence is real but small and there
-- is nothing to remediate — no stored figure is being corrected, only the
-- boundaries the next read uses.

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE(organization_id uuid, organization_name text, active_clients integer, visits_today integer, visits_completed_today integer, revenue_mtd_cents bigint, revenue_mtd_gross_cents bigint, refunds_mtd_cents bigint, ar_open_cents bigint, tech_count integer)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
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

  RETURN QUERY
  WITH children AS (
    -- Includes the parent's own row, so a rollup reads as the whole franchise
    -- rather than "everyone but me".
    SELECT o.id, o.name, coalesce(o.timezone, 'America/Chicago') AS tz
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
  ),
  clock AS (
    -- Each row's own day and its own month, rather than the parent's imposed on
    -- everyone. `now()` is evaluated once per statement, so every row is cut
    -- from the same instant — only the zone differs, which is the whole point.
    SELECT c.id, c.name, c.tz,
           (now() AT TIME ZONE c.tz)::date AS today,
           (date_trunc('month', (now() AT TIME ZONE c.tz)) AT TIME ZONE c.tz) AS month_start
    FROM children c
  ),
  money AS (
    SELECT c.id,
           COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
                      WHERE p.organization_id = c.id
                        AND p.status IN ('succeeded', 'refunded')
                        AND p.created_at >= c.month_start), 0) AS gross,
           COALESCE((SELECT SUM(
                       CASE WHEN ri.kind = 'payment_chargeback_won'
                            THEN -COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint)
                            ELSE  COALESCE((ri.detail->>'revenue_cents')::bigint, (ri.detail->>'amount_cents')::bigint) END
                     )::bigint
                       FROM public.review_items ri
                      WHERE ri.organization_id = c.id
                        AND ri.kind IN ('payment_refunded','payment_chargeback','payment_chargeback_won')
                        AND ri.detected_at >= c.month_start), 0) AS refunds
    FROM clock c
  )
  SELECT
    c.id,
    c.name,
    COALESCE((SELECT COUNT(*)::int FROM public.clients cl
               WHERE cl.organization_id = c.id AND cl.active = true), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.visits v
               WHERE v.organization_id = c.id AND v.scheduled_on = c.today
                 AND v.status = 'completed'), 0),
    (m.gross - m.refunds)::bigint,
    m.gross,
    m.refunds,
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM clock c JOIN money m ON m.id = c.id
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$function$;

-- ── WHAT THIS FILE ESTABLISHES, PROVABLE FROM ANY STARTING STATE ──────────
--
-- No tenant, no organization, no payment and no cron job is needed to answer
-- any of these — they are questions about the routine this migration just
-- wrote. `prosrc` rather than `pg_get_functiondef`, and the function is named.
DO $$
DECLARE
  _src    text;
  _result text;
BEGIN
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'franchise_rollup' AND p.pronargs = 1;

  IF _src IS NULL THEN
    RAISE EXCEPTION 'franchise_rollup(uuid) is not present after this migration';
  END IF;

  -- The clock is per row now.
  IF position('AT TIME ZONE c.tz' in _src) = 0 THEN
    RAISE EXCEPTION 'franchise_rollup does not resolve a timezone per location row';
  END IF;

  -- And the single parent-wide boundary it replaced is gone, rather than both
  -- being present with the old one still feeding the columns.
  IF position('_month_start' in _src) > 0 OR position('_today' in _src) > 0 THEN
    RAISE EXCEPTION 'franchise_rollup still carries the parent-wide month/day boundary it was meant to drop';
  END IF;

  -- Both windows moved, not just the month: "visits today" was the other half
  -- of the fault.
  IF position('v.scheduled_on = c.today' in _src) = 0
     OR position('p.created_at >= c.month_start' in _src) = 0 THEN
    RAISE EXCEPTION 'franchise_rollup does not read both windows from the per-location clock';
  END IF;

  -- Authorization is not weakened by any of the above.
  IF position('has_role(auth.uid(), _parent_org, ''owner''::public.app_role)' in _src) = 0
     OR position('has_plan_entitlement(_parent_org, ''franchise_structure'')' in _src) = 0 THEN
    RAISE EXCEPTION 'franchise_rollup lost its role check or its plan gate';
  END IF;

  -- The return shape every caller destructures. An earlier draft of the
  -- 2026-08-04 migration rewrote this function with 7 columns instead of 10.
  -- Named function, so this is not the unbounded-set problem pg_get_functiondef
  -- has, and it is not that routine in any case.
  _result := pg_get_function_result('public.franchise_rollup(uuid)'::regprocedure);
  IF position('revenue_mtd_gross_cents' in _result) = 0
     OR position('refunds_mtd_cents' in _result) = 0
     OR position('tech_count' in _result) = 0 THEN
    RAISE EXCEPTION 'franchise_rollup no longer returns the ten columns its callers read: %', _result;
  END IF;
END $$;

-- ── WHAT WAS MEASURED RATHER THAN ESTABLISHED ─────────────────────────────
--
-- How far apart the clocks actually are is a fact about whatever database this
-- runs against. A fresh build has no franchise at all, so there is nothing to
-- measure and the log says so in as many words rather than printing a reassuring
-- zero. WARNING, never EXCEPTION.
DO $$
DECLARE _row record; _n bigint := 0;
BEGIN
  FOR _row IN
    SELECT child.name AS child_name,
           coalesce(child.timezone, 'America/Chicago') AS child_tz,
           coalesce(parent.timezone, 'America/Chicago') AS parent_tz,
           (date_trunc('month', now() AT TIME ZONE coalesce(child.timezone, 'America/Chicago'))
              AT TIME ZONE coalesce(child.timezone, 'America/Chicago'))
           - (date_trunc('month', now() AT TIME ZONE coalesce(parent.timezone, 'America/Chicago'))
              AT TIME ZONE coalesce(parent.timezone, 'America/Chicago')) AS gap
      FROM public.organizations child
      JOIN public.organizations parent ON parent.id = child.parent_organization_id
     WHERE coalesce(child.timezone, 'America/Chicago') IS DISTINCT FROM coalesce(parent.timezone, 'America/Chicago')
  LOOP
    _n := _n + 1;
    RAISE WARNING 'clock survey: % (%) starts the month % after its franchise (%). Until now its rollup row was cut on the franchise''s boundary.',
      _row.child_name, _row.child_tz, _row.gap, _row.parent_tz;
  END LOOP;

  IF _n = 0 THEN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE parent_organization_id IS NOT NULL) THEN
      RAISE WARNING 'clock survey SKIPPED: no organization has a parent, so no location clock could be compared. Nothing was measured.';
    ELSE
      RAISE WARNING 'clock survey: every location shares its franchise''s timezone, so no boundary moves today.';
    END IF;
  END IF;
END $$;

-- ── THE GRANTS, RESTATED RATHER THAN ASSUMED ──────────────────────────────
--
-- A no-op against the live database, where `franchise_rollup` is already
-- authenticated + service_role and nothing else (read from `proacl`,
-- 2026-08-19), and not a no-op at all on a fresh replay: CREATE FUNCTION in
-- `public` hands EXECUTE to PUBLIC and `anon` is a member of PUBLIC, so a
-- database built from these files would otherwise publish every location's
-- revenue, AR and headcount to anyone holding the publishable key. The
-- function's own role check would still refuse — `auth.uid()` is null for anon
-- — but a reachable SECURITY DEFINER read of every tenant's money is not
-- something to leave standing on the strength of one IF.
REVOKE ALL ON FUNCTION public.franchise_rollup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;
