-- franchise_signals returned names and ids as two parallel arrays that were
-- not in the same order.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
--
--   string_agg(c.name, ' · ' ORDER BY c.name),
--   array_agg(c.id),                            -- no ORDER BY
--
-- The names came out alphabetical and the ids came out in whatever order the
-- aggregate happened to see them, so `organization_ids[i]` did not identify
-- the organization named i-th. Zipping them to build per-organization links —
-- the obvious thing to do with them — would have sent a platform admin to the
-- wrong tenant roughly as often as the right one, and every link would have
-- looked perfectly plausible.
--
-- It has never mispaired anyone, because the screen built on top of it noticed
-- and deliberately rendered names with no links at all, plus one "find them in
-- Tenants" fallback. So the cost so far has been a worse screen rather than a
-- wrong answer.
--
-- ── WHY NOT JUST ADD `ORDER BY c.name` TO THE SECOND AGGREGATE ─────────────
--
-- Because it would still be wrong, and wrong in a way nothing would catch.
--
-- Ordering only by name is not a total order — this database has THREE
-- organizations literally named "Test Test" — and two aggregates each sort
-- their own input independently. Where the keys tie, the two sorts may
-- disagree, so the arrays can still drift apart on exactly the rows a human
-- would find hardest to check.
--
-- More to the point, two parallel arrays that must stay in step is a shape
-- that invites this bug back the next time somebody edits the query. So the
-- pairing is not restored, it is made impossible: one jsonb array of
-- self-contained {id, name, linked} objects. There is nothing left to zip.
--
-- `linked` per organization is new and is the reason this is worth doing at
-- all: the row already carried a COUNT of how many of the cluster are already
-- linked, which tells a salesperson how many calls are left but not WHICH
-- ones. Now the screen can show it per organization.
--
-- The return type changes, so this drops and recreates rather than replaces.
-- Idempotent.

DROP FUNCTION IF EXISTS public.franchise_signals();

CREATE FUNCTION public.franchise_signals()
RETURNS TABLE(
  email_domain text,
  org_count integer,
  orgs jsonb,
  states text,
  state_count integer,
  stripe_accounts integer,
  already_linked integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  WITH owners AS (
    SELECT o.id, o.name, o.parent_organization_id, o.stripe_connect_account_id,
           lower(split_part(u.email, '@', 2)) AS domain
    FROM public.organizations o
    JOIN public.user_roles ur ON ur.organization_id = o.id AND ur.role = 'owner'
    JOIN auth.users u ON u.id = ur.user_id
    WHERE o.deleted_at IS NULL
  ),
  custom AS (
    SELECT * FROM owners
    WHERE domain NOT IN (
      'gmail.com','googlemail.com','yahoo.com','ymail.com','outlook.com',
      'hotmail.com','live.com','msn.com','icloud.com','me.com','mac.com',
      'aol.com','proton.me','protonmail.com','gmx.com','zoho.com','mail.com'
    )
  ),
  regions AS (
    SELECT p.organization_id, array_agg(DISTINCT p.region) FILTER (WHERE p.region IS NOT NULL) AS regs
    FROM public.properties p GROUP BY p.organization_id
  ),
  per_domain_regions AS (
    SELECT c.domain, r AS reg
    FROM custom c
    LEFT JOIN regions rg ON rg.organization_id = c.id,
    LATERAL unnest(coalesce(rg.regs, ARRAY[]::text[])) AS r
  )
  SELECT
    c.domain,
    count(*)::int,
    -- One self-contained object per organization. Ordered by (name, id) so the
    -- list is stable between calls even when two organizations share a name —
    -- but nothing depends on that order for correctness any more, which is the
    -- whole point.
    jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'name', c.name,
        'linked', c.parent_organization_id IS NOT NULL
      )
      ORDER BY c.name, c.id
    ),
    coalesce((SELECT string_agg(DISTINCT pdr.reg, ', ') FROM per_domain_regions pdr WHERE pdr.domain = c.domain), ''),
    coalesce((SELECT count(DISTINCT pdr.reg)::int FROM per_domain_regions pdr WHERE pdr.domain = c.domain), 0),
    count(*) FILTER (WHERE c.stripe_connect_account_id IS NOT NULL)::int,
    count(*) FILTER (WHERE c.parent_organization_id IS NOT NULL)::int
  FROM custom c
  GROUP BY c.domain
  HAVING count(*) > 1
  ORDER BY count(*) DESC, c.domain;
END;
$function$;

COMMENT ON FUNCTION public.franchise_signals() IS
  'BUILD-6 sales intelligence: clusters of organizations sharing a custom email domain, i.e. one multi-location operator who signed up piecemeal. Returns one jsonb array of {id, name, linked} objects rather than parallel name and id arrays, which were not ordered alike and could not be zipped safely.';

REVOKE ALL ON FUNCTION public.franchise_signals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_signals() TO authenticated, service_role;
