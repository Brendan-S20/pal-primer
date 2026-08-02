-- BUILD-6: tell-tales that several organizations are really one business.
--
-- A franchise does not announce itself. It shows up as a cluster of separate
-- signups that share things independent businesses would not. This surfaces
-- those clusters for platform admins, so a multi-location operator can be
-- recognized and offered Enterprise rather than discovered by accident.
--
-- The signal is a CUSTOM email domain. @barkave.com across five signups is a
-- strong tell. A shared PUBLIC provider (@gmail.com) is not a weak signal — it
-- is the base rate, so those domains are EXCLUDED rather than ranked lower.
-- Ranking them would bury every real cluster under everyone who uses Gmail.
--
-- State footprint comes from properties.region, because organizations carry no
-- address of their own. It matters twice over: crossing state lines is what
-- turns "a few accounts" into "an operator with a structure", and it is also
-- the usual sign of separate legal entities — which is what forces separate
-- Stripe accounts, since stripe_connect_account_id is one per organization.
--
-- Platform-admin only; this is cross-tenant by nature.
--
-- Idempotent.

CREATE OR REPLACE FUNCTION public.franchise_signals()
RETURNS TABLE (
  email_domain text,
  org_count integer,
  org_names text,
  organization_ids uuid[],
  states text,
  state_count integer,
  stripe_accounts integer,
  already_linked integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    string_agg(c.name, ' · ' ORDER BY c.name),
    array_agg(c.id),
    coalesce((SELECT string_agg(DISTINCT pdr.reg, ', ') FROM per_domain_regions pdr WHERE pdr.domain = c.domain), ''),
    coalesce((SELECT count(DISTINCT pdr.reg)::int FROM per_domain_regions pdr WHERE pdr.domain = c.domain), 0),
    count(*) FILTER (WHERE c.stripe_connect_account_id IS NOT NULL)::int,
    count(*) FILTER (WHERE c.parent_organization_id IS NOT NULL)::int
  FROM custom c
  GROUP BY c.domain
  HAVING count(*) > 1
  ORDER BY count(*) DESC, c.domain;
END;
$$;

COMMENT ON FUNCTION public.franchise_signals() IS
  'BUILD-6: clusters of organizations sharing a CUSTOM owner email domain — a tell-tale that several signups are one multi-location operator. Public email providers are excluded because they are the base rate, not a signal. Reports state footprint (properties.region) and Stripe Connect account count. Platform-admin only.';

REVOKE ALL ON FUNCTION public.franchise_signals() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.franchise_signals() TO authenticated, service_role;
