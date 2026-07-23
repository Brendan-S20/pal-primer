-- Platform add-on lifecycle status (platform admin console — Add-ons page):
-- 'active'      → tenants can see + subscribe
-- 'coming_soon' → tenants see it with a "Coming soon" badge; subscribe disabled
-- 'disabled'    → hidden from the tenant catalog entirely
--
-- is_active is kept (lots of existing reads filter on it) and stays in sync:
-- the setPlatformAddonStatus server fn writes BOTH columns
-- (is_active = status = 'active'); no trigger needed.

ALTER TABLE public.platform_addons
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'coming_soon'));

-- Backfill from the existing boolean.
UPDATE public.platform_addons
SET status = CASE WHEN is_active THEN 'active' ELSE 'disabled' END;
