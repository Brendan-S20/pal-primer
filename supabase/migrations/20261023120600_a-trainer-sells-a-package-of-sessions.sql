-- A training package is charged once. Its lessons reserve sessions, and
-- completing one (or a billable skip) recounts usage. Skill scores, the
-- session note and homework live beside the lesson.
--
-- Customers still cannot ask for training. public_services and
-- portal_request_one_off leave the line out until the customer path
-- (buy a package, see progress, book the next lesson) is finished.
-- The office sells, books and records progress here.

CREATE TABLE IF NOT EXISTS public.service_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  sessions_count integer NOT NULL CHECK (sessions_count BETWEEN 1 AND 100),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  expires_after_days integer CHECK (expires_after_days BETWEEN 1 AND 730),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_packages_organization_idx ON public.service_packages(organization_id);
ALTER TABLE public.service_packages ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.service_packages');
REVOKE ALL ON TABLE public.service_packages FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_packages TO authenticated, service_role;
DROP POLICY IF EXISTS service_packages_read ON public.service_packages;
CREATE POLICY service_packages_read ON public.service_packages FOR SELECT TO authenticated
  USING (public.is_org_member((select auth.uid()), organization_id));
DROP POLICY IF EXISTS service_packages_insert ON public.service_packages;
CREATE POLICY service_packages_insert ON public.service_packages FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS service_packages_update ON public.service_packages;
CREATE POLICY service_packages_update ON public.service_packages FOR UPDATE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS service_packages_delete ON public.service_packages;
CREATE POLICY service_packages_delete ON public.service_packages FOR DELETE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id));

CREATE TABLE IF NOT EXISTS public.client_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL,
  service_package_id uuid NOT NULL REFERENCES public.service_packages(id),
  service_id uuid NOT NULL REFERENCES public.services(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  sessions_count integer NOT NULL CHECK (sessions_count BETWEEN 1 AND 100),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  purchased_on date NOT NULL,
  expires_on date,
  sessions_used integer NOT NULL DEFAULT 0 CHECK (sessions_used BETWEEN 0 AND sessions_count),
  invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL,
  request_id uuid,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled')),
  canceled_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, request_id)
);
CREATE INDEX IF NOT EXISTS client_packages_organization_idx ON public.client_packages(organization_id);
CREATE INDEX IF NOT EXISTS client_packages_client_idx ON public.client_packages(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS client_packages_invoice_idx ON public.client_packages(invoice_id) WHERE invoice_id IS NOT NULL;
ALTER TABLE public.client_packages ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.client_packages');
REVOKE ALL ON TABLE public.client_packages FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.client_packages TO authenticated, service_role;
DROP POLICY IF EXISTS client_packages_read ON public.client_packages;
CREATE POLICY client_packages_read ON public.client_packages FOR SELECT TO authenticated
  USING (public.is_org_member((select auth.uid()), organization_id)
    AND public.may_read_client_row(organization_id, client_id));
DROP POLICY IF EXISTS client_packages_insert ON public.client_packages;
CREATE POLICY client_packages_insert ON public.client_packages FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS client_packages_update ON public.client_packages;
CREATE POLICY client_packages_update ON public.client_packages FOR UPDATE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS client_packages_delete ON public.client_packages;
CREATE POLICY client_packages_delete ON public.client_packages FOR DELETE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id));

ALTER TABLE public.visits ADD COLUMN IF NOT EXISTS client_package_id uuid REFERENCES public.client_packages(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions ADD COLUMN IF NOT EXISTS client_package_id uuid REFERENCES public.client_packages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS visits_client_package_idx ON public.visits(client_package_id);
CREATE INDEX IF NOT EXISTS subscriptions_client_package_idx ON public.subscriptions(client_package_id);

CREATE OR REPLACE FUNCTION public.training_service_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.services s WHERE s.id = NEW.service_id
    AND s.organization_id = NEW.organization_id AND s.service_line = 'training') THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a training service from this business.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_service_package_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_service_package_guard ON public.service_packages;
CREATE TRIGGER training_service_package_guard BEFORE INSERT OR UPDATE ON public.service_packages
FOR EACH ROW EXECUTE FUNCTION public.training_service_package_guard();

CREATE OR REPLACE FUNCTION public.training_client_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.service_packages%ROWTYPE; _actual integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO _p FROM public.service_packages WHERE id = NEW.service_package_id FOR SHARE;
    IF NOT FOUND OR _p.organization_id <> NEW.organization_id THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a package from this business.';
    END IF;
    IF NOT _p.active THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package is not available for sale.';
    END IF;
    NEW.service_id := _p.service_id;
    NEW.name := _p.name;
    NEW.sessions_count := _p.sessions_count;
    NEW.price_cents := _p.price_cents;
    SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO NEW.purchased_on
      FROM public.organizations o WHERE o.id = NEW.organization_id;
    NEW.expires_on := NEW.purchased_on + _p.expires_after_days;
    IF NEW.sessions_used <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session usage is maintained by visits.';
    END IF;
  ELSE
    IF ROW(NEW.organization_id, NEW.client_id, NEW.service_package_id, NEW.service_id,
      NEW.name, NEW.sessions_count, NEW.price_cents, NEW.purchased_on, NEW.request_id)
      IS DISTINCT FROM ROW(OLD.organization_id, OLD.client_id, OLD.service_package_id, OLD.service_id,
      OLD.name, OLD.sessions_count, OLD.price_cents, OLD.purchased_on, OLD.request_id) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'A sold package keeps its original details.';
    END IF;
    IF NEW.sessions_used IS DISTINCT FROM OLD.sessions_used THEN
      SELECT count(*) INTO _actual FROM public.visits v WHERE v.client_package_id = NEW.id
        AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));
      -- Nested recounts must match reality. A caller cannot forge usage.
      IF pg_trigger_depth() < 2 OR NEW.sessions_used <> _actual THEN
        RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Session usage is maintained by visits.';
      END IF;
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients c WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a client from this business.';
  END IF;
  IF NEW.dog_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d JOIN public.properties p ON p.id = d.property_id
    WHERE d.id = NEW.dog_id AND d.organization_id = NEW.organization_id AND p.client_id = NEW.client_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a dog belonging to this client.';
  END IF;
  IF NEW.invoice_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.invoices i
    WHERE i.id = NEW.invoice_id AND i.organization_id = NEW.organization_id AND i.client_id = NEW.client_id
      AND (TG_OP <> 'INSERT' OR i.subtotal_cents = NEW.price_cents)) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose an invoice belonging to this client.';
  END IF;
  -- OLD is unassigned on INSERT. A package sold already canceled is unusual
  -- and still gets a timestamp; an update keeps the first one.
  NEW.canceled_at := CASE
    WHEN NEW.status <> 'canceled' THEN NULL
    WHEN TG_OP = 'UPDATE' THEN COALESCE(OLD.canceled_at, now())
    ELSE now()
  END;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_client_package_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_client_package_guard ON public.client_packages;
CREATE TRIGGER training_client_package_guard BEFORE INSERT OR UPDATE ON public.client_packages
FOR EACH ROW EXECUTE FUNCTION public.training_client_package_guard();

CREATE OR REPLACE FUNCTION public.training_visit_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.client_packages%ROWTYPE; _derived boolean := false; _held integer; _message text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.client_package_id IS DISTINCT FROM OLD.client_package_id
     AND (select auth.uid()) IS NOT NULL AND NOT public.can_write_org((select auth.uid()), OLD.organization_id) THEN
    RAISE EXCEPTION USING ERRCODE = 'insufficient_privilege', MESSAGE = 'Not authorized to change this visit package.';
  END IF;
  IF NEW.client_package_id IS NULL AND NEW.subscription_id IS NOT NULL THEN
    -- A deleted package must stay unlinked during ON DELETE SET NULL.
    SELECT s.client_package_id INTO NEW.client_package_id FROM public.subscriptions s
      JOIN public.client_packages p ON p.id = s.client_package_id WHERE s.id = NEW.subscription_id;
    _derived := NEW.client_package_id IS NOT NULL AND TG_OP = 'INSERT';
  END IF;
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  -- Give a session back even after cancellation or expiry.
  IF TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id
     AND NOT (NEW.status IN ('scheduled', 'in_progress', 'completed') OR (NEW.status = 'skipped' AND NEW.skip_billable = true)) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO _p FROM public.client_packages WHERE id = NEW.client_package_id FOR UPDATE;
  IF NOT FOUND OR _p.organization_id <> NEW.organization_id OR _p.client_id <> NEW.client_id
     OR _p.service_id <> NEW.service_id THEN
    _message := 'Choose a package for this client and training service.';
  ELSIF _p.status = 'canceled' THEN
    _message := 'This package was canceled.';
  ELSIF _p.expires_on IS NOT NULL AND NEW.scheduled_on > _p.expires_on THEN
    _message := 'This package expired on ' || to_char(_p.expires_on, 'YYYY-MM-DD') || '.';
  ELSE
    SELECT count(*) INTO _held FROM public.visits v
      WHERE v.client_package_id = _p.id AND v.id <> NEW.id
      AND (v.status IN ('scheduled', 'in_progress', 'completed') OR (v.status = 'skipped' AND v.skip_billable = true));
    IF _held + (CASE WHEN NEW.status IN ('scheduled', 'in_progress', 'completed') OR (NEW.status = 'skipped' AND NEW.skip_billable = true) THEN 1 ELSE 0 END) > _p.sessions_count THEN
      _message := format('No sessions left in this package: %s of %s are booked or used.', _held, _p.sessions_count);
    END IF;
  END IF;
  IF _message IS NOT NULL THEN
    IF _derived THEN RETURN NULL; END IF;
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = _message;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_visit_package_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_training_visit_package_guard ON public.visits;
-- Service derivation runs first, so the package can check the service too.
CREATE TRIGGER zz_training_visit_package_guard BEFORE INSERT OR UPDATE OF client_package_id, status, skip_billable, scheduled_on, subscription_id, service_id, client_id, organization_id ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.training_visit_package_guard();

CREATE OR REPLACE FUNCTION public.training_package_recount()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _old uuid; _new uuid; _id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.client_package_id, OLD.status, OLD.skip_billable) IS NOT DISTINCT FROM
       ROW(NEW.client_package_id, NEW.status, NEW.skip_billable) THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN _old := OLD.client_package_id; END IF;
  IF TG_OP <> 'DELETE' THEN _new := NEW.client_package_id; END IF;
  -- Lock in a consistent order when a visit changes package.
  FOR _id IN SELECT DISTINCT p.id FROM public.client_packages p WHERE p.id IN (_old, _new) ORDER BY p.id LOOP
    PERFORM 1 FROM public.client_packages WHERE id = _id FOR UPDATE;
    UPDATE public.client_packages SET sessions_used = (
      SELECT count(*) FROM public.visits v WHERE v.client_package_id = _id
        AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
    ), updated_at = now() WHERE id = _id;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.training_package_recount() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_package_recount ON public.visits;
CREATE TRIGGER training_package_recount AFTER INSERT OR UPDATE OR DELETE ON public.visits
FOR EACH ROW EXECUTE FUNCTION public.training_package_recount();

CREATE OR REPLACE FUNCTION public.training_subscription_package_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE _p public.client_packages%ROWTYPE; _held integer;
BEGIN
  IF NEW.client_package_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO _p FROM public.client_packages WHERE id = NEW.client_package_id FOR UPDATE;
  IF NOT FOUND OR _p.organization_id <> NEW.organization_id OR _p.client_id <> NEW.client_id OR _p.service_id <> NEW.service_id THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a package for this client and training service.';
  END IF;
  -- A plan cannot be converted to prepaid or charged per session later.
  NEW.price_cents := 0;
  NEW.billing_cadence := 'postpaid';
  IF TG_OP = 'UPDATE' AND NEW.client_package_id = OLD.client_package_id
    AND NEW.started_on = OLD.started_on THEN RETURN NEW; END IF;
  IF _p.status = 'canceled' THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package was canceled.';
  END IF;
  IF _p.expires_on IS NOT NULL AND NEW.started_on > _p.expires_on THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'This package expired on ' || to_char(_p.expires_on, 'YYYY-MM-DD') || '.';
  END IF;
  SELECT count(*) INTO _held FROM public.visits v WHERE v.client_package_id = _p.id
    AND (v.status IN ('scheduled', 'in_progress', 'completed') OR (v.status = 'skipped' AND v.skip_billable = true));
  IF _held >= _p.sessions_count THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = format('No sessions left in this package: %s of %s are booked or used.', _held, _p.sessions_count);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_subscription_package_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS zz_training_subscription_package_guard ON public.subscriptions;
CREATE TRIGGER zz_training_subscription_package_guard BEFORE INSERT OR UPDATE OF client_package_id, price_cents, billing_cadence, started_on, service_id, client_id, organization_id ON public.subscriptions
FOR EACH ROW EXECUTE FUNCTION public.training_subscription_package_guard();

CREATE OR REPLACE FUNCTION public.client_package_session_number(_visit_id uuid)
RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  -- Check the target before reading the whole package, including other trainers' visits.
  WITH target AS (
    SELECT v.client_package_id FROM public.visits v WHERE v.id = _visit_id
      AND ((select auth.role()) = 'service_role' OR (public.is_org_member((select auth.uid()), v.organization_id)
        AND public.may_read_client_row(v.organization_id, v.client_id)))
  )
  SELECT numbered.n::integer FROM (
    SELECT v.id, row_number() OVER (ORDER BY v.scheduled_on, v.id) AS n
    FROM public.visits v JOIN target t ON t.client_package_id = v.client_package_id
    WHERE v.status IN ('scheduled', 'in_progress', 'completed') OR (v.status = 'skipped' AND v.skip_billable = true)
  ) numbered WHERE numbered.id = _visit_id;
$$;
REVOKE ALL ON FUNCTION public.client_package_session_number(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.client_package_session_number(uuid) TO authenticated, service_role;

-- Package lessons are already on the package invoice. Spliced into the
-- current postpaid generator rather than retyped, so a later billing change
-- is not dropped. generate_prepaid_invoice refuses a non-prepaid plan, and
-- the subscription guard forces package plans to postpaid.
DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND li.id IS NULL';
  _to   CONSTANT text := 'AND li.id IS NULL AND v.client_package_id IS NULL';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.admin_generate_invoice_for_client(uuid, date)'::regprocedure);
  IF strpos(_def, 'v.client_package_id IS NULL') > 0 THEN
    RAISE NOTICE 'admin_generate_invoice_for_client already excludes package lessons; leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 2 THEN
    RAISE EXCEPTION
      'admin_generate_invoice_for_client contains "%" % time(s), not twice; the splice anchor moved. Re-cut this migration against the current body.',
      _from, _n;
  END IF;
  _def := replace(_def, _from, _to);
  EXECUTE _def;
END
$splice$;

-- A customer cannot ask for a training lesson from the portal yet.
DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'IF (SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = ''pet_waste'' THEN';
  _to   CONSTANT text := 'IF (SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = ''training'' THEN
      RAISE EXCEPTION ''service_not_offered'';
    END IF;
    IF (SELECT s.service_line FROM public.services s WHERE s.id = _service_id) = ''pet_waste'' THEN';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.portal_request_one_off(uuid, uuid, date, text, uuid)'::regprocedure);
  IF strpos(_def, 'bookable_service_lines()') > 0 OR strpos(_def, 'service_line) = ''training''') > 0 THEN
    RAISE NOTICE 'portal_request_one_off already refuses training; leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION
      'portal_request_one_off contains the pet-waste service check % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- Signup and the public quote form do not list training.
DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 'AND (s.service_line = ''pet_waste'' OR s.base_price_cents IS NOT NULL)';
  _to   CONSTANT text := 'AND s.service_line <> ''training''
       AND (s.service_line = ''pet_waste'' OR s.base_price_cents IS NOT NULL)';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_services(text)'::regprocedure);
  IF strpos(_def, 's.service_line <> ''training''') > 0 THEN
    RAISE NOTICE 'public_services already hides training; leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION
      'public_services contains the priced-service filter % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── What a lesson worked on ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.training_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS training_skills_name_idx
  ON public.training_skills (organization_id, lower(btrim(name)));
CREATE INDEX IF NOT EXISTS training_skills_organization_idx ON public.training_skills(organization_id);
ALTER TABLE public.training_skills ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.training_skills');
REVOKE ALL ON TABLE public.training_skills FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_skills TO authenticated, service_role;
DROP POLICY IF EXISTS training_skills_read ON public.training_skills;
CREATE POLICY training_skills_read ON public.training_skills FOR SELECT TO authenticated
  USING (public.is_org_member((select auth.uid()), organization_id));
DROP POLICY IF EXISTS training_skills_insert ON public.training_skills;
CREATE POLICY training_skills_insert ON public.training_skills FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS training_skills_update ON public.training_skills;
CREATE POLICY training_skills_update ON public.training_skills FOR UPDATE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((select auth.uid()), organization_id));
DROP POLICY IF EXISTS training_skills_delete ON public.training_skills;
CREATE POLICY training_skills_delete ON public.training_skills FOR DELETE TO authenticated
  USING (public.can_write_org((select auth.uid()), organization_id));

CREATE OR REPLACE FUNCTION public.training_skill_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.name := btrim(NEW.name);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_skill_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_skill_guard ON public.training_skills;
CREATE TRIGGER training_skill_guard BEFORE INSERT OR UPDATE ON public.training_skills
FOR EACH ROW EXECUTE FUNCTION public.training_skill_guard();

CREATE TABLE IF NOT EXISTS public.session_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  skill_id uuid NOT NULL REFERENCES public.training_skills(id) ON DELETE CASCADE,
  score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visit_id, skill_id)
);
CREATE INDEX IF NOT EXISTS session_progress_visit_idx ON public.session_progress(visit_id);
CREATE INDEX IF NOT EXISTS session_progress_organization_idx ON public.session_progress(organization_id);
ALTER TABLE public.session_progress ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.session_progress');
REVOKE ALL ON TABLE public.session_progress FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.session_progress TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.training_session_notes (
  visit_id uuid PRIMARY KEY REFERENCES public.visits(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS training_session_notes_organization_idx ON public.training_session_notes(organization_id);
ALTER TABLE public.training_session_notes ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.training_session_notes');
REVOKE ALL ON TABLE public.training_session_notes FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.training_session_notes TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.homework (
  visit_id uuid PRIMARY KEY REFERENCES public.visits(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dog_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  due_on date,
  client_marked_done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS homework_organization_idx ON public.homework(organization_id);
ALTER TABLE public.homework ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.homework');
REVOKE ALL ON TABLE public.homework FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.homework TO authenticated, service_role;

-- The office, or the trainer assigned to that lesson. No new permission:
-- can_write_org and is_visit_tech are the ones the visit itself already uses.
CREATE OR REPLACE FUNCTION public.training_progress_row_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.visits v
    WHERE v.id = NEW.visit_id AND v.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a lesson from this business.';
  END IF;
  -- Each table's own column is read inside its own IF. PL/pgSQL resolves every
  -- NEW field in an expression when it runs it, so NEW.skill_id in a shared
  -- condition fails on training_session_notes and homework, which lack it.
  IF TG_TABLE_NAME = 'session_progress' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.training_skills s
      WHERE s.id = NEW.skill_id AND s.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a skill from this business.';
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'homework' THEN
    IF NEW.dog_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.dogs d
      JOIN public.visits v ON v.property_id = d.property_id
      WHERE d.id = NEW.dog_id AND v.id = NEW.visit_id AND d.organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION USING ERRCODE = 'check_violation', MESSAGE = 'Choose a dog at this lesson.';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.training_progress_row_guard() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS training_progress_row_guard_scores ON public.session_progress;
CREATE TRIGGER training_progress_row_guard_scores BEFORE INSERT OR UPDATE ON public.session_progress
FOR EACH ROW EXECUTE FUNCTION public.training_progress_row_guard();
DROP TRIGGER IF EXISTS training_progress_row_guard_notes ON public.training_session_notes;
CREATE TRIGGER training_progress_row_guard_notes BEFORE INSERT OR UPDATE ON public.training_session_notes
FOR EACH ROW EXECUTE FUNCTION public.training_progress_row_guard();
DROP TRIGGER IF EXISTS training_progress_row_guard_homework ON public.homework;
CREATE TRIGGER training_progress_row_guard_homework BEFORE INSERT OR UPDATE ON public.homework
FOR EACH ROW EXECUTE FUNCTION public.training_progress_row_guard();

DO $policies$
DECLARE _table text;
BEGIN
  FOREACH _table IN ARRAY ARRAY['session_progress', 'training_session_notes', 'homework'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', _table || '_read', _table);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
      USING (EXISTS (
        SELECT 1 FROM public.visits v
        WHERE v.id = %I.visit_id
          AND v.organization_id = %I.organization_id
          AND public.is_org_member((select auth.uid()), v.organization_id)
          AND public.may_read_client_row(v.organization_id, v.client_id)
      ))
    $p$, _table || '_read', _table, _table, _table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', _table || '_insert', _table);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.organization_id = %I.organization_id)
        AND (public.can_write_org((select auth.uid()), organization_id) OR public.is_visit_tech((select auth.uid()), visit_id))
      )
    $p$, _table || '_insert', _table, _table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', _table || '_update', _table);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated
      USING (public.can_write_org((select auth.uid()), organization_id) OR public.is_visit_tech((select auth.uid()), visit_id))
      WITH CHECK (
        EXISTS (SELECT 1 FROM public.visits v WHERE v.id = visit_id AND v.organization_id = %I.organization_id)
        AND (public.can_write_org((select auth.uid()), organization_id) OR public.is_visit_tech((select auth.uid()), visit_id))
      )
    $p$, _table || '_update', _table, _table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', _table || '_delete', _table);
    EXECUTE format($p$
      CREATE POLICY %I ON public.%I FOR DELETE TO authenticated
      USING (public.can_write_org((select auth.uid()), organization_id) OR public.is_visit_tech((select auth.uid()), visit_id))
    $p$, _table || '_delete', _table);
  END LOOP;
END
$policies$;

DO $check$
DECLARE _table text; _trigger text; _src text;
BEGIN
  FOREACH _table IN ARRAY ARRAY[
    'service_packages', 'client_packages', 'training_skills',
    'session_progress', 'training_session_notes', 'homework'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = _table AND c.relrowsecurity) THEN
      RAISE EXCEPTION 'Training table or RLS is missing: %', _table;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = _table AND permissive = 'RESTRICTIVE') THEN
      RAISE EXCEPTION 'Training MFA policy is missing: %', _table;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'client_package_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'client_package_id')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'client_packages' AND column_name = 'request_id') THEN
    RAISE EXCEPTION 'Training package link columns are missing.';
  END IF;
  FOREACH _trigger IN ARRAY ARRAY[
    'training_service_package_guard', 'training_client_package_guard',
    'zz_training_visit_package_guard', 'training_package_recount',
    'zz_training_subscription_package_guard', 'training_skill_guard',
    'training_progress_row_guard_scores', 'training_progress_row_guard_notes',
    'training_progress_row_guard_homework'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = _trigger AND NOT tgisinternal AND tgenabled <> 'D') THEN
      RAISE EXCEPTION 'Training trigger is missing: %', _trigger;
    END IF;
  END LOOP;
  SELECT p.prosrc INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.admin_generate_invoice_for_client(uuid, date)'::regprocedure;
  IF _src IS NULL OR (SELECT count(*) FROM regexp_matches(_src, 'v\.client_package_id IS NULL', 'g')) <> 2 THEN
    RAISE EXCEPTION 'Both billing queries must exclude package visits.';
  END IF;
  IF to_regprocedure('public.client_package_session_number(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Training session number helper is missing.';
  END IF;
  SELECT p.prosrc INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.portal_request_one_off(uuid, uuid, date, text, uuid)'::regprocedure;
  IF _src IS NULL OR (strpos(_src, 'training') = 0 AND strpos(_src, 'bookable_service_lines()') = 0) THEN
    RAISE EXCEPTION 'portal_request_one_off still accepts a training lesson.';
  END IF;
  SELECT p.prosrc INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.public_services(text)'::regprocedure;
  IF _src IS NULL OR (strpos(_src, 'training') = 0 AND strpos(_src, 'bookable_service_lines()') = 0) THEN
    RAISE EXCEPTION 'public_services still lists training.';
  END IF;
END
$check$;
