-- BUILD-6 (phase 2): repair franchise_rollup() and actually call it.
--
-- I previously recorded this function as "the one correct piece of cross-org
-- authz in the repo — written, granted, typed, and never called." The
-- authorization half of that is true and is worth keeping. The BODY is not: it
-- had never been executed, so three errors sat in it undetected until the first
-- call raised `42703: column cl.status does not exist`.
--
--   1. `cl.status = 'active'` — public.clients has NO status column. It has
--      `active boolean NOT NULL DEFAULT true`, which the rest of the app uses
--      unanimously (19 call sites). Note the same function gets `staff` right
--      on the very next line (`s.active = true`), so this was an authoring slip,
--      not a schema that moved.
--   2. `i.amount_paid_cents` — does not exist on public.invoices. That column
--      lives on platform_invoices, a different table entirely.
--   3. `i.status IN ('open','draft','past_due')` — `past_due` is not a member
--      of the invoice_status enum ('draft','open','paid','void','uncollectible').
--
-- Any one of those would have raised on first execution. That is the real
-- lesson: a SECURITY DEFINER function granted to `authenticated` and never
-- called is not a spare part, it is unverified surface area.
--
-- AR NOW MATCHES THE REST OF THE APP. src/lib/ar.ts is the documented canonical
-- definition ("B1"), and every other surface routes through it: open means
-- status = 'open' ONLY; the balance is total_cents - credit_applied_cents
-- floored at zero. The old body disagreed on both counts, so a franchise parent
-- would have seen an AR figure for a location that the location's own dashboard
-- contradicted.
--
-- REVENUE deliberately matches the ROYALTY generators (payments.created_at,
-- status='succeeded'), not the weekly digest (which uses paid_at). There is no
-- canonical revenue definition in this codebase — three families disagree — and
-- this is the one number a franchise parent will directly compare against a
-- royalty invoice for the same period. Two numbers that must reconcile beat one
-- number that is arguably more correct in isolation. Logged as IMP-10.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.franchise_rollup(_parent_org uuid)
RETURNS TABLE (
  organization_id uuid,
  organization_name text,
  active_clients integer,
  visits_today integer,
  visits_completed_today integer,
  revenue_mtd_cents bigint,
  ar_open_cents bigint,
  tech_count integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _tz text;
  _today date;
  _month_start timestamptz;
BEGIN
  -- Authorization, unchanged in substance: the caller must be an owner or
  -- office manager OF THE PARENT. This is the part that was always right, and
  -- the reason a SECURITY DEFINER function is the correct shape here — the
  -- caller's own RLS can never read a sibling organization's rows, which is why
  -- the TypeScript reimplementation returned zeros for every caller.
  IF NOT (
    public.has_role(auth.uid(), _parent_org, 'owner'::public.app_role)
    OR public.has_role(auth.uid(), _parent_org, 'office_manager'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Not authorized to view franchise rollup';
  END IF;

  -- Org-local "today", not the database's. The previous body used CURRENT_DATE
  -- and date_trunc('month', now()), both of which resolve in the DB session's
  -- timezone — so a parent in Chicago comparing "visits today" across locations
  -- would see a boundary that matches none of them. This is the BUG-12 mistake
  -- and it has now appeared five times in this codebase.
  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent_org;
  _today := (now() AT TIME ZONE _tz)::date;
  _month_start := (date_trunc('month', (now() AT TIME ZONE _tz))) AT TIME ZONE _tz;

  RETURN QUERY
  WITH children AS (
    -- Includes the parent's own row, so a rollup reads as the whole franchise
    -- rather than "everyone but me".
    SELECT o.id, o.name
    FROM public.organizations o
    WHERE o.id = _parent_org OR o.parent_organization_id = _parent_org
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
    COALESCE((SELECT SUM(p.amount_cents)::bigint FROM public.payments p
               WHERE p.organization_id = c.id AND p.status = 'succeeded'
                 AND p.created_at >= _month_start), 0),
    -- Canonical AR (ar.ts / "B1"): open only, net of applied credit, floored.
    COALESCE((SELECT SUM(GREATEST(i.total_cents - COALESCE(i.credit_applied_cents, 0), 0))::bigint
                FROM public.invoices i
               WHERE i.organization_id = c.id AND i.status = 'open'), 0),
    COALESCE((SELECT COUNT(*)::int FROM public.staff s
               WHERE s.organization_id = c.id AND s.active = true), 0)
  FROM children c
  ORDER BY (c.id = _parent_org) DESC, c.name;
END;
$$;

COMMENT ON FUNCTION public.franchise_rollup(uuid) IS
  'BUILD-6: per-location rollup for a franchise parent. SECURITY DEFINER because a parent cannot read a child org under RLS. Repaired — the original body referenced clients.status, invoices.amount_paid_cents, and an invoice_status value ''past_due'', none of which exist, and had never been executed. AR matches src/lib/ar.ts; revenue matches the royalty generators.';

GRANT EXECUTE ON FUNCTION public.franchise_rollup(uuid) TO authenticated, service_role;
