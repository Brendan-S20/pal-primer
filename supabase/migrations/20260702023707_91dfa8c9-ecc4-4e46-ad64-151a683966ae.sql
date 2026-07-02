
CREATE TABLE public.inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  unit TEXT NOT NULL DEFAULT 'each',
  unit_cost_cents INTEGER NOT NULL DEFAULT 0,
  reorder_threshold NUMERIC(12,2) NOT NULL DEFAULT 0,
  on_hand NUMERIC(12,2) NOT NULL DEFAULT 0,
  category TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(organization_id, sku)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_items TO authenticated;
GRANT ALL ON public.inventory_items TO service_role;
ALTER TABLE public.inventory_items ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_inv_items_org ON public.inventory_items(organization_id);
CREATE POLICY "Members read inventory items" ON public.inventory_items FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write inventory items" ON public.inventory_items FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));
CREATE TRIGGER trg_inv_items_updated BEFORE UPDATE ON public.inventory_items
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE public.inventory_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  quantity NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(item_id, staff_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_assignments TO authenticated;
GRANT ALL ON public.inventory_assignments TO service_role;
ALTER TABLE public.inventory_assignments ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_inv_assign_org ON public.inventory_assignments(organization_id);
CREATE INDEX idx_inv_assign_staff ON public.inventory_assignments(staff_id);
CREATE POLICY "Members read inventory assignments" ON public.inventory_assignments FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write inventory assignments" ON public.inventory_assignments FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));
CREATE TRIGGER trg_inv_assign_updated BEFORE UPDATE ON public.inventory_assignments
  FOR EACH ROW EXECUTE FUNCTION public.tg_touch_updated_at();

CREATE TABLE public.inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  staff_id UUID REFERENCES public.staff(id) ON DELETE SET NULL,
  visit_id UUID REFERENCES public.visits(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchase','assign','unassign','consume','adjust')),
  quantity NUMERIC(12,2) NOT NULL,
  note TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_movements TO authenticated;
GRANT ALL ON public.inventory_movements TO service_role;
ALTER TABLE public.inventory_movements ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_inv_mov_org ON public.inventory_movements(organization_id);
CREATE INDEX idx_inv_mov_item ON public.inventory_movements(item_id);
CREATE POLICY "Members read inventory movements" ON public.inventory_movements FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Members write inventory movements" ON public.inventory_movements FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers manage inventory movements" ON public.inventory_movements FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

CREATE OR REPLACE FUNCTION public.apply_inventory_movement()
RETURNS TRIGGER AS $$
DECLARE
  v_delta_item NUMERIC(12,2);
  v_delta_assign NUMERIC(12,2);
BEGIN
  v_delta_item := CASE NEW.kind
    WHEN 'purchase' THEN NEW.quantity
    WHEN 'consume'  THEN -NEW.quantity
    WHEN 'adjust'   THEN NEW.quantity
    ELSE 0 END;
  v_delta_assign := CASE NEW.kind
    WHEN 'assign'   THEN NEW.quantity
    WHEN 'unassign' THEN -NEW.quantity
    WHEN 'consume'  THEN CASE WHEN NEW.staff_id IS NOT NULL THEN -NEW.quantity ELSE 0 END
    ELSE 0 END;

  IF v_delta_item <> 0 THEN
    UPDATE public.inventory_items
      SET on_hand = on_hand + v_delta_item, updated_at = now()
      WHERE id = NEW.item_id;
  END IF;

  IF v_delta_assign <> 0 AND NEW.staff_id IS NOT NULL THEN
    INSERT INTO public.inventory_assignments(organization_id, item_id, staff_id, quantity)
      VALUES (NEW.organization_id, NEW.item_id, NEW.staff_id, v_delta_assign)
      ON CONFLICT (item_id, staff_id)
      DO UPDATE SET quantity = public.inventory_assignments.quantity + EXCLUDED.quantity,
                    updated_at = now();
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE TRIGGER trg_inv_mov_apply AFTER INSERT ON public.inventory_movements
  FOR EACH ROW EXECUTE FUNCTION public.apply_inventory_movement();
