-- A zone can be turned off without deleting it (#449).
--
-- An owner pauses a zone (a seasonal area, a full route, a new area being
-- tried) and turns it back on later with its shape, ZIPs and pricing intact.
-- Until now the only way to stop a zone quoting was to delete it, which
-- throws all three away.
--
--   zones.enabled                 new, NOT NULL DEFAULT true, so every zone
--                                 that exists today stays on.
--   public_quote                  spliced: a zone that is off is not a zone
--                                 the public signup page or the lead form can
--                                 quote from. Same splice pattern as
--                                 20261027200000: the newest body read with
--                                 pg_get_functiondef on the NAMED function,
--                                 one anchor that must occur exactly once.
--   tg_zones_enabled_owner_only   new trigger. Only an owner turns a zone on
--                                 or off. The zones UPDATE policy lets every
--                                 manage_pricing role write a zone (an office
--                                 manager edits rates), so the switch needs
--                                 its own check. A service-role caller has no
--                                 auth.uid() and is let through, as the app's
--                                 own server functions check the role first.
--
-- The app's matcher (src/lib/zone-match.ts) skips a zone that is off, which
-- covers address lookup, new properties, the office quote, the receptionist
-- and the leads list. Properties already in a zone that is turned off keep
-- that zone (src/lib/zones-redetect.server.ts), so their clients keep their
-- schedule and price.
--
-- Replays into an empty database: one column, one trigger, one splice of a
-- function 20261024100900 creates. No rows read. Idempotent.

-- ── 1. The column ────────────────────────────────────────────────────────

ALTER TABLE public.zones
  ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.zones.enabled IS
  'Off (false) keeps the zone''s shape, ZIPs and pricing but skips it for zone detection, public_quote (signup page and lead form) and new assignments. Properties already in it keep it. Only an owner changes it (tg_zones_enabled_owner_only).';

-- ── 2. Only an owner flips it ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_zones_enabled_owner_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.enabled IS NOT DISTINCT FROM OLD.enabled THEN
    RETURN NEW;
  END IF;
  -- The service role (the app's own server, migrations, the seeder) has no
  -- user. The server function checks the caller's role before it writes.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = auth.uid()
       AND ur.organization_id = NEW.organization_id
       AND ur.role = 'owner'
  ) THEN
    RAISE EXCEPTION 'Only an owner can turn a zone on or off.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_zones_enabled_owner_only() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS zones_enabled_owner_only ON public.zones;
CREATE TRIGGER zones_enabled_owner_only
  BEFORE UPDATE OF enabled ON public.zones
  FOR EACH ROW EXECUTE FUNCTION public.tg_zones_enabled_owner_only();

-- ── 3. public_quote skips a zone that is off ─────────────────────────────

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'WHERE z.organization_id = _org.id';
  _to   CONSTANT text := 'WHERE z.organization_id = _org.id
      AND z.enabled';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, 'AND z.enabled') > 0 THEN
    RAISE NOTICE 'public_quote already skips a zone that is off; leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_quote contains the zone organization filter % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'zones'
       AND column_name = 'enabled' AND is_nullable = 'NO'
       AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'zones.enabled is missing, nullable, or not on by default';
  END IF;

  -- Named function, read through prosrc, which cannot raise for any kind of
  -- routine.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname = 'public_quote'
       AND p.prosrc LIKE '%AND z.enabled%'
  ) THEN
    RAISE EXCEPTION 'public_quote does not skip a zone that is off';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'public_quote')
     IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'public.public_quote has more than one overload; the splice reached only one';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.zones'::regclass
       AND t.tgname = 'zones_enabled_owner_only'
       AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'zones_enabled_owner_only trigger is missing';
  END IF;

  IF has_function_privilege('anon', 'public.tg_zones_enabled_owner_only()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_zones_enabled_owner_only()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_zones_enabled_owner_only is callable directly';
  END IF;

  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_quote';
  END IF;
END
$post$;
