-- Stage 3 QA: manage_pricing includes office managers, but the only UPDATE
-- policy on organizations is owner-only, so their standard-pricing and
-- deep-clean saves were 0-row silent no-ops (PostgREST reports success).
-- Fix with narrowly-scoped SECURITY DEFINER functions that enforce the role
-- check in the database and can touch ONLY these settings columns - no
-- broad RLS widening, no service-role bypass.

CREATE OR REPLACE FUNCTION public.update_org_standard_pricing(
  _org_id uuid,
  _std_base_price_cents integer,
  _std_per_dog_addl_cents integer
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
  IF _std_base_price_cents IS NOT NULL AND (_std_base_price_cents < 0 OR _std_base_price_cents > 1000000) THEN
    RAISE EXCEPTION 'Invalid base price';
  END IF;
  IF _std_per_dog_addl_cents IS NOT NULL AND (_std_per_dog_addl_cents < 0 OR _std_per_dog_addl_cents > 1000000) THEN
    RAISE EXCEPTION 'Invalid per-dog price';
  END IF;

  UPDATE public.organizations
     SET std_base_price_cents = _std_base_price_cents,
         std_per_dog_addl_cents = _std_per_dog_addl_cents
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.update_org_standard_pricing(uuid, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_org_standard_pricing(uuid, integer, integer) TO authenticated;

-- Same latent gap for the seasonal deep-clean settings (also manage_pricing).
CREATE OR REPLACE FUNCTION public.update_org_deepclean_settings(
  _org_id uuid,
  _enabled boolean,
  _months integer[],
  _charge_cents integer
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
  IF _charge_cents IS NULL OR _charge_cents < 0 OR _charge_cents > 1000000 THEN
    RAISE EXCEPTION 'Invalid charge amount';
  END IF;
  IF _months IS NULL OR array_length(_months, 1) > 12
     OR EXISTS (SELECT 1 FROM unnest(_months) m WHERE m < 1 OR m > 12) THEN
    RAISE EXCEPTION 'Invalid months';
  END IF;

  UPDATE public.organizations
     SET seasonal_deepclean_enabled = COALESCE(_enabled, false),
         seasonal_deepclean_months = _months,
         seasonal_deepclean_charge_cents = _charge_cents
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.update_org_deepclean_settings(uuid, boolean, integer[], integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_org_deepclean_settings(uuid, boolean, integer[], integer) TO authenticated;
