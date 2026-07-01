
-- =========================================================
-- Enums
-- =========================================================
CREATE TYPE public.account_type AS ENUM ('residential', 'commercial');
CREATE TYPE public.staff_role AS ENUM ('owner', 'office_manager', 'dispatcher', 'tech');
CREATE TYPE public.app_role AS ENUM ('owner', 'office_manager', 'dispatcher', 'tech');
CREATE TYPE public.subscription_status AS ENUM ('active', 'paused', 'canceled');
CREATE TYPE public.billing_cadence AS ENUM ('prepaid', 'postpaid');
CREATE TYPE public.dog_temperament AS ENUM ('friendly', 'nervous', 'aggressive', 'unknown');
CREATE TYPE public.service_frequency AS ENUM ('weekly', 'biweekly', 'twice_weekly', 'monthly', 'one_time');

-- =========================================================
-- organizations
-- =========================================================
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  active_client_count int NOT NULL DEFAULT 0,
  billing_tier text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- =========================================================
-- user_roles (separate from staff for security-definer has_role)
-- =========================================================
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, organization_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_user_roles_user ON public.user_roles(user_id);
CREATE INDEX idx_user_roles_org ON public.user_roles(organization_id);

-- =========================================================
-- Security-definer helpers
-- =========================================================
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _org_id uuid, _role public.app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id AND role = _role
  );
$$;

CREATE OR REPLACE FUNCTION public.is_org_member(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND organization_id = _org_id
  );
$$;

CREATE OR REPLACE FUNCTION public.can_write_org(_user_id uuid, _org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND organization_id = _org_id
      AND role IN ('owner', 'office_manager', 'dispatcher')
  );
$$;

-- =========================================================
-- organizations policies
-- =========================================================
CREATE POLICY "Members read own org"
  ON public.organizations FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), id));

CREATE POLICY "Owners update own org"
  ON public.organizations FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), id, 'owner'))
  WITH CHECK (public.has_role(auth.uid(), id, 'owner'));

-- Insert of a brand-new org is done via a SECURITY DEFINER server function (bootstrap),
-- so no INSERT policy for authenticated is granted here.

-- =========================================================
-- user_roles policies
-- =========================================================
CREATE POLICY "Users read their own role rows"
  ON public.user_roles FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), organization_id, 'owner'));

-- =========================================================
-- locations
-- =========================================================
CREATE TABLE public.locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  street text,
  city text,
  region text,
  postal_code text,
  country text DEFAULT 'US',
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.locations TO authenticated;
GRANT ALL ON public.locations TO service_role;
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_locations_org ON public.locations(organization_id);

CREATE POLICY "Members read locations" ON public.locations FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write locations" ON public.locations FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- staff
-- =========================================================
CREATE TABLE public.staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.staff_role NOT NULL,
  display_name text NOT NULL,
  email text,
  phone text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff TO authenticated;
GRANT ALL ON public.staff TO service_role;
ALTER TABLE public.staff ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_staff_org ON public.staff(organization_id);

CREATE POLICY "Members read staff" ON public.staff FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write staff" ON public.staff FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- clients
-- =========================================================
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  account_type public.account_type NOT NULL,
  display_name text NOT NULL,
  primary_email text,
  primary_phone text,
  active boolean NOT NULL DEFAULT true,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.clients TO authenticated;
GRANT ALL ON public.clients TO service_role;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_clients_org ON public.clients(organization_id);
CREATE INDEX idx_clients_org_active ON public.clients(organization_id) WHERE active;

CREATE POLICY "Members read clients" ON public.clients FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write clients" ON public.clients FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- properties
-- =========================================================
CREATE TABLE public.properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  label text,
  street text NOT NULL,
  city text NOT NULL,
  region text,
  postal_code text NOT NULL,
  country text DEFAULT 'US',
  -- Structured access fields (per spec: NOT a free-text notes dump)
  gate_code text,
  lock_box_code text,
  key_location text,
  parking_notes text,
  access_notes text,
  -- Structured hazard flags
  invisible_fence boolean NOT NULL DEFAULT false,
  escape_risk boolean NOT NULL DEFAULT false,
  dog_in_yard_during_service boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.properties TO authenticated;
GRANT ALL ON public.properties TO service_role;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_properties_client ON public.properties(client_id);
CREATE INDEX idx_properties_org ON public.properties(organization_id);

CREATE POLICY "Members read properties" ON public.properties FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write properties" ON public.properties FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- dogs
-- =========================================================
CREATE TABLE public.dogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  breed text,
  weight_class text,
  temperament public.dog_temperament NOT NULL DEFAULT 'unknown',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dogs TO authenticated;
GRANT ALL ON public.dogs TO service_role;
ALTER TABLE public.dogs ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_dogs_property ON public.dogs(property_id);

CREATE POLICY "Members read dogs" ON public.dogs FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write dogs" ON public.dogs FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- subscriptions (residential/commercial discriminator with CHECK)
-- =========================================================
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  account_type public.account_type NOT NULL,
  frequency public.service_frequency NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  billing_cadence public.billing_cadence NOT NULL DEFAULT 'postpaid',
  dog_count integer,
  unit_count integer,
  zone_id uuid,
  status public.subscription_status NOT NULL DEFAULT 'active',
  started_on date NOT NULL DEFAULT CURRENT_DATE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_account_shape_chk CHECK (
    (account_type = 'residential' AND dog_count IS NOT NULL AND dog_count > 0 AND unit_count IS NULL)
    OR
    (account_type = 'commercial' AND unit_count IS NOT NULL AND unit_count > 0 AND dog_count IS NULL)
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE INDEX idx_subs_org ON public.subscriptions(organization_id);
CREATE INDEX idx_subs_client ON public.subscriptions(client_id);

CREATE POLICY "Members read subscriptions" ON public.subscriptions FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));
CREATE POLICY "Managers write subscriptions" ON public.subscriptions FOR ALL TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- =========================================================
-- Maintain organizations.active_client_count
-- =========================================================
CREATE OR REPLACE FUNCTION public.refresh_active_client_count(_org_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
  UPDATE public.organizations
     SET active_client_count = (
       SELECT COUNT(*) FROM public.clients
        WHERE organization_id = _org_id AND active = true
     ),
     updated_at = now()
   WHERE id = _org_id;
$$;

CREATE OR REPLACE FUNCTION public.tg_clients_maintain_count()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.refresh_active_client_count(OLD.organization_id);
    RETURN OLD;
  ELSIF TG_OP = 'INSERT' THEN
    PERFORM public.refresh_active_client_count(NEW.organization_id);
    RETURN NEW;
  ELSE
    IF NEW.organization_id <> OLD.organization_id OR NEW.active <> OLD.active THEN
      PERFORM public.refresh_active_client_count(NEW.organization_id);
      IF NEW.organization_id <> OLD.organization_id THEN
        PERFORM public.refresh_active_client_count(OLD.organization_id);
      END IF;
    END IF;
    RETURN NEW;
  END IF;
END;
$$;

CREATE TRIGGER trg_clients_active_count
AFTER INSERT OR UPDATE OR DELETE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.tg_clients_maintain_count();

-- =========================================================
-- Bootstrap: create org + owner role + staff row for a signed-in user
-- =========================================================
CREATE OR REPLACE FUNCTION public.bootstrap_organization(_org_name text, _display_name text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _uid uuid := auth.uid();
  _org_id uuid;
  _existing uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- If the user already belongs to an org, return it (idempotent)
  SELECT organization_id INTO _existing FROM public.user_roles WHERE user_id = _uid LIMIT 1;
  IF _existing IS NOT NULL THEN
    RETURN _existing;
  END IF;

  INSERT INTO public.organizations(name) VALUES (_org_name) RETURNING id INTO _org_id;
  INSERT INTO public.user_roles(user_id, organization_id, role) VALUES (_uid, _org_id, 'owner');
  INSERT INTO public.staff(organization_id, user_id, role, display_name, active)
    VALUES (_org_id, _uid, 'owner', _display_name, true);

  RETURN _org_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_organization(text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.bootstrap_organization(text, text) TO authenticated;
