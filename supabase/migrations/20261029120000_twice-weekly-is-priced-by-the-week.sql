-- Twice-weekly was billed at 3.6x the weekly plan (#572, F-07).
--
-- organizations.frequency_multipliers is a PER-VISIT multiplier on the weekly
-- price. Every reader applies it to one visit: computeZoneVisitPrice, the
-- quote prefill, the new-client wizard and pricing drift in the app, and
-- public_quote here. The column default shipped in 20260701215820 as
--   {"weekly":1.0,"biweekly":1.7,"twice_weekly":1.8,"monthly":3.2}
-- so a twice-weekly visit cost 1.8 weekly visits, and at two a week the plan
-- cost 3.6x the weekly one. A $35 weekly yard was quoted and invoiced $63 a
-- visit, $126 a week.
--
-- D1 (2026-10-28): 1.8 is the WEEK. Twice-weekly is 0.9 a visit, 1.8x the
-- weekly plan all in. Biweekly (1.7 a visit) and monthly (3.2 a visit) keep
-- their values and their meaning.
--
-- Three changes:
--
-- 1. The column default's twice_weekly is 0.9.
-- 2. Every organization still on the shipped 1.8 moves to 0.9. Nothing in the
--    product could write this column before this migration, so 1.8 is the
--    default nobody chose. A different value was set by hand outside the
--    product; it is left alone and counted in a warning.
-- 3. update_org_frequency_multipliers, so the owner (and an office manager,
--    who has manage_pricing like standard pricing) can set every cadence from
--    Settings > Business defaults. It refuses a twice-weekly visit above the
--    weekly price, so a week of two visits is never more than two weekly ones.
--
-- Plans already sold keep their stored price_cents: changing what a customer
-- pays is the owner's call. Pricing drift (Reports) compares each plan with
-- today's rate card, so every twice-weekly plan priced at 1.8 a visit shows
-- there as over the card, with the price it would be today.
--
-- public_quote needs no new body: it reads the column, so the public booking
-- link quotes 0.9 a visit the moment the row says so.

ALTER TABLE public.organizations
  ALTER COLUMN frequency_multipliers
  SET DEFAULT '{"weekly":1.0,"biweekly":1.7,"twice_weekly":0.9,"monthly":3.2}'::jsonb;

DO $data$
DECLARE
  _moved integer;
  _custom integer;
BEGIN
  UPDATE public.organizations
     SET frequency_multipliers = jsonb_set(frequency_multipliers, '{twice_weekly}', '0.9'::jsonb)
   WHERE jsonb_typeof(frequency_multipliers -> 'twice_weekly') = 'number'
     AND (frequency_multipliers ->> 'twice_weekly')::numeric = 1.8;
  GET DIAGNOSTICS _moved = ROW_COUNT;
  RAISE NOTICE 'twice_weekly moved from 1.8 to 0.9 a visit on % organization(s).', _moved;

  SELECT count(*) INTO _custom FROM public.organizations
   WHERE jsonb_typeof(frequency_multipliers -> 'twice_weekly') = 'number'
     AND (frequency_multipliers ->> 'twice_weekly')::numeric > 1;
  IF _custom > 0 THEN
    RAISE WARNING '% organization(s) have a hand-set twice_weekly above 1 a visit; left as set.', _custom;
  END IF;
END
$data$;

CREATE OR REPLACE FUNCTION public.update_org_frequency_multipliers(
  _org_id uuid,
  _biweekly numeric,
  _twice_weekly numeric,
  _monthly numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _org_id, 'owner')
    OR public.has_role(auth.uid(), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update pricing settings';
  END IF;
  IF _biweekly IS NULL OR _twice_weekly IS NULL OR _monthly IS NULL
     OR _biweekly < 0.1 OR _biweekly > 10
     OR _twice_weekly < 0.1 OR _twice_weekly > 10
     OR _monthly < 0.1 OR _monthly > 10 THEN
    RAISE EXCEPTION 'Each multiplier must be between 0.1 and 10';
  END IF;
  IF _twice_weekly > 1 THEN
    RAISE EXCEPTION 'A twice-weekly visit can cost at most the weekly price';
  END IF;

  -- Merged onto what is there, so a key this function does not know about
  -- survives. Weekly is the price itself and is always 1.
  UPDATE public.organizations
     SET frequency_multipliers = COALESCE(frequency_multipliers, '{}'::jsonb)
           || jsonb_build_object(
                'weekly', 1.0,
                'biweekly', round(_biweekly, 2),
                'twice_weekly', round(_twice_weekly, 2),
                'monthly', round(_monthly, 2))
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$fn$;

REVOKE ALL ON FUNCTION public.update_org_frequency_multipliers(uuid, numeric, numeric, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_org_frequency_multipliers(uuid, numeric, numeric, numeric) TO authenticated;

COMMENT ON FUNCTION public.update_org_frequency_multipliers(uuid, numeric, numeric, numeric) IS
  'Sets the per-visit price multiplier for each pet-waste cadence (weekly is 1). Owner or office manager. Twice-weekly is capped at 1 a visit so its week is at most 2x weekly (#572).';

-- What this migration establishes, provable from any starting state.
DO $post$
DECLARE
  _def text;
BEGIN
  SELECT column_default INTO _def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'organizations'
     AND column_name = 'frequency_multipliers';
  IF (replace(split_part(_def, '::', 1), '''', '')::jsonb ->> 'twice_weekly')::numeric <> 0.9 THEN
    RAISE EXCEPTION 'frequency_multipliers default twice_weekly is not 0.9: %', _def;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations
     WHERE jsonb_typeof(frequency_multipliers -> 'twice_weekly') = 'number'
       AND (frequency_multipliers ->> 'twice_weekly')::numeric = 1.8
  ) THEN
    RAISE EXCEPTION 'an organization is still on twice_weekly 1.8 a visit';
  END IF;
  IF has_function_privilege('anon', 'public.update_org_frequency_multipliers(uuid, numeric, numeric, numeric)', 'EXECUTE') THEN
    RAISE EXCEPTION 'update_org_frequency_multipliers is callable by anon';
  END IF;
END
$post$;
