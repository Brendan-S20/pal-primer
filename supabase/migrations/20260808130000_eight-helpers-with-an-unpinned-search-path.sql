-- Eight functions with a mutable search_path, and an honest severity.
--
-- Supabase's security advisor reports `function_search_path_mutable` for these
-- eight. The headline version of that finding is a privilege-escalation vector:
-- a SECURITY DEFINER function runs as its owner, so if an attacker can prepend a
-- schema to search_path they can make it call THEIR `public.foo()` with the
-- owner's rights.
--
-- That is not what these are. Checked before writing anything —
-- `pg_proc.prosecdef` is false for all eight:
--
--   default_skip_billable_pct   effective_speed_kmh   haversine_km
--   is_valid_entity_name        is_valid_label        next_station_number
--   next_visit_date             phone_digits
--
-- They are SECURITY INVOKER, so they already run with the caller's own
-- privileges and there is nothing to escalate TO. Six are IMMUTABLE arithmetic
-- or CASE lookups that touch no table at all; `next_station_number` reads
-- `public.waste_stations` already schema-qualified, and the two validators are
-- regex checks.
--
-- So this is hygiene, not a hole, and it is recorded that way rather than
-- written up as a security fix. What it does buy is real, if small: pinning
-- makes resolution independent of whatever the caller's search_path happens to
-- be, which is the kind of thing that turns into a confusing bug when a
-- function is later called from a context nobody anticipated — and it takes the
-- advisor list from 8 findings to 0 in this category, so the next genuine one
-- is not lost in a list people have learned to skim.
--
-- ── WHY ALTER AND NOT CREATE OR REPLACE ───────────────────────────────────
--
-- `SET search_path` is function ATTRIBUTE, not part of the body, so ALTER sets
-- it without restating a single line of logic. Retyping eight bodies to change
-- an attribute is how a WHEN branch or a COALESCE default silently changes —
-- the same argument the generate_visits_core splice migration made at length,
-- and here it comes for free.
--
-- pg_temp is included because it is the one schema an attacker can always write
-- to; naming it LAST means a temp object can never shadow a public one.

DO $pre$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('default_skip_billable_pct','effective_speed_kmh','haversine_km',
                       'is_valid_entity_name','is_valid_label','next_station_number',
                       'next_visit_date','phone_digits')
     AND p.prosecdef;
  -- If any of these ever becomes SECURITY DEFINER, the reasoning in this header
  -- stops holding and the finding stops being hygiene.
  IF _n <> 0 THEN
    RAISE EXCEPTION
      '% of these helpers are now SECURITY DEFINER — re-assess the severity before pinning', _n;
  END IF;
END
$pre$;

ALTER FUNCTION public.default_skip_billable_pct(skip_reason_code)  SET search_path = public, pg_temp;
ALTER FUNCTION public.effective_speed_kmh(text, text)              SET search_path = public, pg_temp;
ALTER FUNCTION public.haversine_km(double precision, double precision, double precision, double precision)
                                                                   SET search_path = public, pg_temp;
ALTER FUNCTION public.is_valid_entity_name(text)                   SET search_path = public, pg_temp;
ALTER FUNCTION public.is_valid_label(text)                         SET search_path = public, pg_temp;
ALTER FUNCTION public.next_station_number(uuid)                    SET search_path = public, pg_temp;
ALTER FUNCTION public.next_visit_date(service_frequency, date)     SET search_path = public, pg_temp;
ALTER FUNCTION public.phone_digits(text)                           SET search_path = public, pg_temp;

DO $post$
DECLARE _unpinned text;
BEGIN
  SELECT string_agg(p.proname, ', ') INTO _unpinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('default_skip_billable_pct','effective_speed_kmh','haversine_km',
                       'is_valid_entity_name','is_valid_label','next_station_number',
                       'next_visit_date','phone_digits')
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'));
  -- An ALTER against a signature that does not exist raises; an ALTER that
  -- silently hit a different overload would not. This catches that.
  IF _unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'still unpinned after the ALTERs: %', _unpinned;
  END IF;
END
$post$;
