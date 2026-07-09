-- ============================================================================
-- LIVE HOTFIX — run once in Lovable Cloud → Database → SQL editor.
-- Phase 2 of finding #4: company-level portal entry point.
--
-- Adds organizations.portal_slug (unique) and backfills every existing org
-- from its name (collision-safe), so /portal/{slug} and the canonical
-- /portal/{slug}/{token} links work and legacy /portal/{uuid} links can
-- redirect. This is the ONLY SQL Phase 2 needs; everything else is code.
-- Idempotent — safe to run more than once.
-- ============================================================================

-- Company-level portal entry point (Phase 2 of finding #4).
--
-- Adds organizations.portal_slug: a stable, unique, human-friendly identifier
-- used in the canonical portal URL /portal/{slug}/{token} and the generic
-- company sign-in page /portal/{slug}. Every existing org is backfilled from
-- its name (collision-safe) so already-issued bare /portal/{uuid} links can
-- always redirect to /portal/{slug}/{uuid}.
--
-- This is the ONLY SQL this feature needs — all lookups/identify/verify logic
-- runs in server functions via the service-role client. Idempotent.

ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS portal_slug text;

-- Slugify: lowercase, non-alphanumeric runs → single hyphen, trimmed.
CREATE OR REPLACE FUNCTION public.slugify(_txt text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT trim(both '-' from regexp_replace(lower(coalesce(_txt, '')), '[^a-z0-9]+', '-', 'g'))
$$;

-- Backfill every org that has no slug yet, resolving collisions with -2, -3, …
DO $$
DECLARE r record; base text; cand text; n int;
BEGIN
  FOR r IN SELECT id, name FROM public.organizations WHERE portal_slug IS NULL LOOP
    base := nullif(public.slugify(r.name), '');
    IF base IS NULL THEN base := 'company'; END IF;
    -- Never let a slug collide with the UUID token format (route disambiguation
    -- treats a UUID-shaped first segment as a legacy token).
    IF base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      base := 'co-' || base;
    END IF;
    cand := base; n := 1;
    WHILE EXISTS (SELECT 1 FROM public.organizations WHERE portal_slug = cand) LOOP
      n := n + 1;
      cand := base || '-' || n;
    END LOOP;
    UPDATE public.organizations SET portal_slug = cand WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS organizations_portal_slug_key
  ON public.organizations (portal_slug);
