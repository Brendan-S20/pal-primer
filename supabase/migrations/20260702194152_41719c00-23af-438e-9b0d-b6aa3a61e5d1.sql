ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS seasonal_deepclean_charge_cents integer NOT NULL DEFAULT 4900;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS is_deepclean boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deepclean_charge_cents integer NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS visits_deepclean_month_unique
  ON public.visits (subscription_id, (date_trunc('month', scheduled_on::timestamp)))
  WHERE is_deepclean = true;

CREATE OR REPLACE FUNCTION public.admin_generate_seasonal_deepcleans(
  _org_id uuid,
  _year int,
  _month int
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _target date;
  _charge int;
  _inserted int := 0;
BEGIN
  SELECT COALESCE(seasonal_deepclean_charge_cents, 4900) INTO _charge
  FROM public.organizations WHERE id = _org_id;

  _target := make_date(_year, _month, 1);
  IF EXTRACT(DOW FROM _target) = 0 THEN _target := _target + 1; END IF;
  IF EXTRACT(DOW FROM _target) = 6 THEN _target := _target + 2; END IF;

  INSERT INTO public.visits (
    organization_id, subscription_id, client_id, property_id,
    scheduled_on, status, is_deepclean, deepclean_charge_cents
  )
  SELECT
    s.organization_id, s.id, s.client_id, s.property_id,
    _target, 'scheduled'::visit_status, true, _charge
  FROM public.subscriptions s
  WHERE s.organization_id = _org_id
    AND s.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM public.visits v
      WHERE v.subscription_id = s.id
        AND v.is_deepclean = true
        AND date_trunc('month', v.scheduled_on::timestamp) = date_trunc('month', _target::timestamp)
    )
  ON CONFLICT DO NOTHING;

  GET DIAGNOSTICS _inserted = ROW_COUNT;
  RETURN _inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_generate_seasonal_deepcleans(uuid, int, int) FROM public, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.admin_generate_seasonal_deepcleans(uuid, int, int) TO service_role;

CREATE TABLE IF NOT EXISTS public.dna_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL,
  client_id uuid REFERENCES public.clients(id) ON DELETE SET NULL,
  sample_kind text NOT NULL CHECK (sample_kind IN ('cheek_swab', 'pile_sample')),
  collected_at timestamptz NOT NULL DEFAULT now(),
  location_note text,
  lab_reference text,
  status text NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'sent_to_lab', 'matched', 'unmatched', 'billed', 'closed')),
  matched_dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL,
  matched_at timestamptz,
  fine_cents integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dna_matches_org_idx ON public.dna_matches (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS dna_matches_status_idx ON public.dna_matches (organization_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.dna_matches TO authenticated;
GRANT ALL ON public.dna_matches TO service_role;

ALTER TABLE public.dna_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members read dna_matches"
  ON public.dna_matches FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "org staff insert dna_matches"
  ON public.dna_matches FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "org staff update dna_matches"
  ON public.dna_matches FOR UPDATE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id))
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "org staff delete dna_matches"
  ON public.dna_matches FOR DELETE TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE TRIGGER dna_matches_touch
  BEFORE UPDATE ON public.dna_matches
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();
