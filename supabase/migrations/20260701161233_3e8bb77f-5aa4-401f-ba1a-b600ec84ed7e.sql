
-- ============================================================
-- Fix: RLS policies invoke these SECURITY DEFINER helpers,
-- so authenticated must have EXECUTE. (Prev migration revoked it.)
-- ============================================================
GRANT EXECUTE ON FUNCTION public.has_role(uuid, uuid, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_org_member(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_org(uuid, uuid) TO authenticated;

-- ============================================================
-- Enums
-- ============================================================
CREATE TYPE public.visit_status AS ENUM (
  'scheduled', 'in_progress', 'completed', 'skipped', 'canceled'
);

-- ============================================================
-- zones (territories)
-- ============================================================
CREATE TABLE public.zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  postal_prefix text, -- used for naive routing order
  account_type public.account_type,
  price_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.zones TO authenticated;
GRANT ALL ON public.zones TO service_role;
ALTER TABLE public.zones ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_zones_org ON public.zones(organization_id);

CREATE POLICY "Members read zones" ON public.zones FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write zones" ON public.zones FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- Now that zones exists, make subscriptions.zone_id an actual FK
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_zone_fk FOREIGN KEY (zone_id)
  REFERENCES public.zones(id) ON DELETE SET NULL;
CREATE INDEX idx_subs_zone ON public.subscriptions(zone_id);

-- ============================================================
-- visits
-- ============================================================
CREATE TABLE public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  assigned_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  scheduled_on date NOT NULL,
  sequence integer, -- ordering within a tech's day
  status public.visit_status NOT NULL DEFAULT 'scheduled',
  skip_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subscription_id, scheduled_on)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.visits TO authenticated;
GRANT ALL ON public.visits TO service_role;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_visits_org_date ON public.visits(organization_id, scheduled_on);
CREATE INDEX idx_visits_tech_date ON public.visits(assigned_staff_id, scheduled_on);
CREATE INDEX idx_visits_client ON public.visits(client_id);

CREATE POLICY "Members read visits" ON public.visits FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

CREATE POLICY "Managers write visits" ON public.visits FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- Techs may update the status/timing of visits assigned to them
CREATE POLICY "Techs update own visits" ON public.visits FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), organization_id, 'tech')
    AND assigned_staff_id IN (SELECT id FROM public.staff WHERE user_id = auth.uid())
  )
  WITH CHECK (
    public.has_role(auth.uid(), organization_id, 'tech')
    AND assigned_staff_id IN (SELECT id FROM public.staff WHERE user_id = auth.uid())
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.tg_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE TRIGGER trg_visits_touch
BEFORE UPDATE ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

-- ============================================================
-- Visit generation engine
-- ============================================================
CREATE OR REPLACE FUNCTION public.next_visit_date(_freq public.service_frequency, _from date)
RETURNS date
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE _freq
    WHEN 'weekly'        THEN _from + INTERVAL '7 days'
    WHEN 'biweekly'      THEN _from + INTERVAL '14 days'
    WHEN 'twice_weekly'  THEN _from + INTERVAL '3 days' -- naive: every 3-4 days
    WHEN 'monthly'       THEN _from + INTERVAL '1 month'
    WHEN 'one_time'      THEN NULL
  END::date;
$$;

-- Generates missing visits for an org up to _through date.
-- Idempotent thanks to UNIQUE (subscription_id, scheduled_on).
CREATE OR REPLACE FUNCTION public.generate_visits_through(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _sub record;
  _next date;
  _inserted integer := 0;
BEGIN
  -- Only allow callers who can write in this org
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to generate visits for this organization';
  END IF;

  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    -- Start from the latest scheduled visit for this sub, or from started_on - 1 day
    SELECT COALESCE(MAX(scheduled_on), _sub.started_on - INTERVAL '1 day')::date
      INTO _next
      FROM public.visits WHERE subscription_id = _sub.id;

    IF _sub.frequency = 'one_time' THEN
      -- Ensure a single visit exists on started_on
      INSERT INTO public.visits
        (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES
        (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _sub.started_on)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      GET DIAGNOSTICS _inserted = ROW_COUNT;
      CONTINUE;
    END IF;

    LOOP
      _next := public.next_visit_date(_sub.frequency, _next);
      EXIT WHEN _next IS NULL OR _next > _through;

      INSERT INTO public.visits
        (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES
        (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _next)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;

      _inserted := _inserted + 1;
    END LOOP;
  END LOOP;

  RETURN _inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_visits_through(uuid, date) FROM public;
GRANT EXECUTE ON FUNCTION public.generate_visits_through(uuid, date) TO authenticated;

-- ============================================================
-- Naive zone-ordered route assignment
-- ============================================================
CREATE OR REPLACE FUNCTION public.assign_route_for_day(
  _org_id uuid, _staff_id uuid, _day date, _reassign boolean DEFAULT false
)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _v record;
  _seq integer := 0;
BEGIN
  IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to assign routes for this organization';
  END IF;

  -- Verify staff belongs to org
  IF NOT EXISTS (
    SELECT 1 FROM public.staff WHERE id = _staff_id AND organization_id = _org_id
  ) THEN
    RAISE EXCEPTION 'Staff not in organization';
  END IF;

  FOR _v IN
    SELECT v.id
      FROM public.visits v
      LEFT JOIN public.zones z ON z.id = v.zone_id
      LEFT JOIN public.properties p ON p.id = v.property_id
     WHERE v.organization_id = _org_id
       AND v.scheduled_on = _day
       AND v.status = 'scheduled'
       AND (_reassign OR v.assigned_staff_id IS NULL)
     ORDER BY COALESCE(z.postal_prefix, ''), COALESCE(p.postal_code, ''), v.created_at
  LOOP
    _seq := _seq + 1;
    UPDATE public.visits
       SET assigned_staff_id = _staff_id, sequence = _seq
     WHERE id = _v.id;
  END LOOP;

  RETURN _seq;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_route_for_day(uuid, uuid, date, boolean) FROM public;
GRANT EXECUTE ON FUNCTION public.assign_route_for_day(uuid, uuid, date, boolean) TO authenticated;
