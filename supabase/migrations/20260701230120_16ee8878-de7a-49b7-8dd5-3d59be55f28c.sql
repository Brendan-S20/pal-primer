
CREATE TABLE public.waste_disposal_facilities (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waste_disposal_facilities TO authenticated;
GRANT ALL ON public.waste_disposal_facilities TO service_role;
ALTER TABLE public.waste_disposal_facilities ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read facilities" ON public.waste_disposal_facilities FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write facilities" ON public.waste_disposal_facilities FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE TABLE public.waste_stations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  location_description TEXT,
  liner_size TEXT,
  capacity_liners INT,
  active BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_waste_stations_property ON public.waste_stations(property_id) WHERE active;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waste_stations TO authenticated;
GRANT ALL ON public.waste_stations TO service_role;
ALTER TABLE public.waste_stations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read stations" ON public.waste_stations FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write stations" ON public.waste_stations FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE TABLE public.station_service_logs (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  visit_id UUID NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  waste_station_id UUID NOT NULL REFERENCES public.waste_stations(id) ON DELETE CASCADE,
  serviced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bags_collected INT NOT NULL DEFAULT 0,
  liner_replaced BOOLEAN NOT NULL DEFAULT false,
  refill_bags_added INT NOT NULL DEFAULT 0,
  notes TEXT,
  photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (visit_id, waste_station_id)
);
CREATE INDEX idx_station_logs_visit ON public.station_service_logs(visit_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.station_service_logs TO authenticated;
GRANT ALL ON public.station_service_logs TO service_role;
ALTER TABLE public.station_service_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read station logs" ON public.station_service_logs FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write station logs" ON public.station_service_logs FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE TABLE public.waste_disposal_manifests (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  facility_id UUID REFERENCES public.waste_disposal_facilities(id) ON DELETE SET NULL,
  disposed_on DATE NOT NULL,
  disposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  weight_lbs NUMERIC(8,2),
  bag_count INT,
  ticket_number TEXT,
  photo_url TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_manifests_org_day ON public.waste_disposal_manifests(organization_id, disposed_on DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.waste_disposal_manifests TO authenticated;
GRANT ALL ON public.waste_disposal_manifests TO service_role;
ALTER TABLE public.waste_disposal_manifests ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org read manifests" ON public.waste_disposal_manifests FOR SELECT TO authenticated USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "org write manifests" ON public.waste_disposal_manifests FOR ALL TO authenticated USING (public.can_write_org(auth.uid(), organization_id)) WITH CHECK (public.can_write_org(auth.uid(), organization_id));

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS station_count_serviced INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.recalc_visit_station_count()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _visit UUID;
BEGIN
  _visit := COALESCE(NEW.visit_id, OLD.visit_id);
  UPDATE public.visits v
     SET station_count_serviced = (SELECT COUNT(*) FROM public.station_service_logs WHERE visit_id = _visit)
   WHERE v.id = _visit;
  RETURN NULL;
END $$;

CREATE TRIGGER trg_station_log_count
AFTER INSERT OR DELETE ON public.station_service_logs
FOR EACH ROW EXECUTE FUNCTION public.recalc_visit_station_count();

CREATE OR REPLACE FUNCTION public.log_station_service(
  _visit_id UUID,
  _waste_station_id UUID,
  _bags_collected INT DEFAULT 0,
  _liner_replaced BOOLEAN DEFAULT false,
  _refill_bags_added INT DEFAULT 0,
  _notes TEXT DEFAULT NULL,
  _photo_url TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org UUID; _id UUID;
BEGIN
  SELECT organization_id INTO _org FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN RAISE EXCEPTION 'forbidden'; END IF;

  INSERT INTO public.station_service_logs(
    organization_id, visit_id, waste_station_id, bags_collected, liner_replaced, refill_bags_added, notes, photo_url
  ) VALUES (_org, _visit_id, _waste_station_id, _bags_collected, _liner_replaced, _refill_bags_added, _notes, _photo_url)
  ON CONFLICT (visit_id, waste_station_id) DO UPDATE
    SET bags_collected = EXCLUDED.bags_collected,
        liner_replaced = EXCLUDED.liner_replaced,
        refill_bags_added = EXCLUDED.refill_bags_added,
        notes = EXCLUDED.notes,
        photo_url = COALESCE(EXCLUDED.photo_url, public.station_service_logs.photo_url),
        serviced_at = now()
  RETURNING id INTO _id;
  RETURN _id;
END $$;

REVOKE ALL ON FUNCTION public.log_station_service(UUID,UUID,INT,BOOLEAN,INT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_station_service(UUID,UUID,INT,BOOLEAN,INT,TEXT,TEXT) TO authenticated;
