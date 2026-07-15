-- Client detail refactor, Stage 1 foundations (docs/client-detail-refactor.md).
--
-- 1. Three note systems: client_notes table with an audience column
--    (office / technician / client) replacing the single clients.notes blob.
--    Office notes are hidden from technicians at the RLS layer.
-- 2. Unified activity timeline: activity_log, insert-only for org members.
-- 3. Scheduling: every-N-weeks (interval_weeks on weekly) and every-X-days
--    (new every_n_days frequency + interval_days). Calendar monthly stays the
--    existing monthly value.
-- 4. Service lifecycle: end_reason/end_notes/paused_at/ended_by metadata.
-- 5. Properties: archive flag, per-property account type + commercial fields,
--    zone auto-assign vs override, estimated-time override metadata, and
--    yard_size derived from boundary area by trigger (manual entry removed).
-- 6. Dogs: active flag (deactivate instead of delete).
-- 7. Clients: tags, preferred contact channel, referral source.
-- 8. Organizations: standard pricing + estimated-time tunables.

-- ── Frequency: every N weeks / every X days ────────────────────────────────

ALTER TYPE public.service_frequency ADD VALUE IF NOT EXISTS 'every_n_days';

ALTER TABLE public.subscriptions
  ADD COLUMN interval_weeks smallint CHECK (interval_weeks BETWEEN 1 AND 26),
  ADD COLUMN interval_days smallint CHECK (interval_days BETWEEN 1 AND 90),
  ADD COLUMN end_reason text,
  ADD COLUMN end_notes text,
  ADD COLUMN paused_at timestamptz,
  ADD COLUMN ended_by uuid;

-- ── Dogs ────────────────────────────────────────────────────────────────────

ALTER TABLE public.dogs ADD COLUMN active boolean NOT NULL DEFAULT true;

-- ── Clients ─────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN preferred_contact text CHECK (preferred_contact IN ('sms', 'email', 'phone')),
  ADD COLUMN referral_source text;

-- ── Properties ──────────────────────────────────────────────────────────────

ALTER TABLE public.properties
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN account_type public.account_type,
  ADD COLUMN commercial_sections text[],
  ADD COLUMN building_labels text[],
  ADD COLUMN auto_zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  ADD COLUMN zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL,
  ADD COLUMN zone_override_reason text,
  ADD COLUMN zone_override_by uuid,
  ADD COLUMN est_override_reason text,
  ADD COLUMN est_override_by uuid,
  ADD COLUMN est_override_at timestamptz;

-- Yard size is derived from the sketched boundary, never hand-picked.
-- Thresholds (sq ft): <5k small, <10k medium, <21,780 (half acre) large,
-- otherwise xlarge. Runs whenever the stored area changes; when a boundary
-- is removed the last derived value is kept as a hint rather than nulled.
CREATE OR REPLACE FUNCTION public.tg_properties_derive_yard_size()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
DECLARE
  _sqft numeric;
BEGIN
  IF NEW.boundary_area_sqm IS NOT NULL THEN
    _sqft := NEW.boundary_area_sqm * 10.7639;
    NEW.yard_size := CASE
      WHEN _sqft < 5000 THEN 'small'
      WHEN _sqft < 10000 THEN 'medium'
      WHEN _sqft < 21780 THEN 'large'
      ELSE 'xlarge'
    END;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS properties_derive_yard_size ON public.properties;
CREATE TRIGGER properties_derive_yard_size
  BEFORE INSERT OR UPDATE OF boundary_area_sqm ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.tg_properties_derive_yard_size();

-- Backfill the derived category for properties that already have a boundary.
UPDATE public.properties
   SET yard_size = CASE
     WHEN boundary_area_sqm * 10.7639 < 5000 THEN 'small'
     WHEN boundary_area_sqm * 10.7639 < 10000 THEN 'medium'
     WHEN boundary_area_sqm * 10.7639 < 21780 THEN 'large'
     ELSE 'xlarge'
   END
 WHERE boundary_area_sqm IS NOT NULL;

-- ── Organizations: standard pricing + estimated-time tunables ───────────────

ALTER TABLE public.organizations
  ADD COLUMN std_base_price_cents integer CHECK (std_base_price_cents >= 0),
  ADD COLUMN std_per_dog_addl_cents integer CHECK (std_per_dog_addl_cents >= 0),
  ADD COLUMN est_time_config jsonb;

-- ── Three note systems ──────────────────────────────────────────────────────

CREATE TABLE public.client_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  audience text NOT NULL CHECK (audience IN ('office', 'technician', 'client')),
  body text NOT NULL CHECK (char_length(body) <= 4000),
  pinned boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_notes_client_idx ON public.client_notes (client_id, audience, created_at DESC);
CREATE INDEX client_notes_org_idx ON public.client_notes (organization_id);

CREATE OR REPLACE FUNCTION public.tg_client_notes_touch()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$fn$;

CREATE TRIGGER client_notes_touch
  BEFORE UPDATE ON public.client_notes
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_notes_touch();

ALTER TABLE public.client_notes ENABLE ROW LEVEL SECURITY;

-- Office notes stay office-side: technicians only ever see technician and
-- client-visible notes. Office roles see everything in their org.
CREATE POLICY client_notes_select ON public.client_notes
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (
      audience <> 'office'
      OR public.has_role(auth.uid(), organization_id, 'owner')
      OR public.has_role(auth.uid(), organization_id, 'office_manager')
      OR public.has_role(auth.uid(), organization_id, 'dispatcher')
    )
  );

-- Office roles write any audience; technicians may add technician notes only.
CREATE POLICY client_notes_insert ON public.client_notes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_org_member(auth.uid(), organization_id)
    AND created_by = auth.uid()
    AND (
      audience = 'technician'
      OR public.has_role(auth.uid(), organization_id, 'owner')
      OR public.has_role(auth.uid(), organization_id, 'office_manager')
      OR public.has_role(auth.uid(), organization_id, 'dispatcher')
    )
  );

CREATE POLICY client_notes_update ON public.client_notes
  FOR UPDATE TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (
      public.has_role(auth.uid(), organization_id, 'owner')
      OR public.has_role(auth.uid(), organization_id, 'office_manager')
      OR public.has_role(auth.uid(), organization_id, 'dispatcher')
      OR (audience = 'technician' AND created_by = auth.uid())
    )
  );

CREATE POLICY client_notes_delete ON public.client_notes
  FOR DELETE TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    AND (
      public.has_role(auth.uid(), organization_id, 'owner')
      OR public.has_role(auth.uid(), organization_id, 'office_manager')
    )
  );

-- Existing free-form client notes become office notes so nothing is lost.
-- clients.notes stays in place (read-only legacy) until the UI cutover lands.
INSERT INTO public.client_notes (organization_id, client_id, audience, body, created_at)
SELECT organization_id, id, 'office', notes, COALESCE(updated_at, created_at, now())
  FROM public.clients
 WHERE notes IS NOT NULL AND btrim(notes) <> '';

-- ── Activity timeline ───────────────────────────────────────────────────────

CREATE TABLE public.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id uuid,
  subscription_id uuid,
  actor_user_id uuid,
  actor_label text,
  kind text NOT NULL CHECK (char_length(kind) <= 60),
  summary text NOT NULL CHECK (char_length(summary) <= 500),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX activity_log_client_idx ON public.activity_log (client_id, created_at DESC);
CREATE INDEX activity_log_org_idx ON public.activity_log (organization_id, created_at DESC);

ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY activity_log_select ON public.activity_log
  FOR SELECT TO authenticated
  USING (public.is_org_member(auth.uid(), organization_id));

-- Insert-only audit trail: rows are written by org members as themselves
-- (or by the service role for system events); never updated or deleted.
CREATE POLICY activity_log_insert ON public.activity_log
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_org_member(auth.uid(), organization_id)
    AND actor_user_id = auth.uid()
  );

-- ── Visit generation: every N weeks / every X days ─────────────────────────

CREATE OR REPLACE FUNCTION public.generate_visits_core(_org_id uuid, _through date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  _sub record;
  _next date;
  _candidate date;
  _stop date;
  _inserted integer := 0;
  _prefs int[];
  _step int;
  _dow int;
  _guard int;
BEGIN
  FOR _sub IN
    SELECT s.id, s.client_id, s.property_id, s.zone_id, s.frequency, s.started_on,
           s.ends_on, s.preferred_weekdays, s.interval_weeks, s.interval_days
      FROM public.subscriptions s
     WHERE s.organization_id = _org_id AND s.status = 'active'
  LOOP
    _prefs := _sub.preferred_weekdays;
    -- Generation never runs past the subscription's end date.
    _stop := LEAST(_through, COALESCE(_sub.ends_on, _through));
    IF _stop < _sub.started_on THEN CONTINUE; END IF;

    IF _sub.frequency = 'one_time' THEN
      _candidate := _sub.started_on;
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;
      IF _sub.ends_on IS NULL OR _candidate <= _sub.ends_on THEN
        INSERT INTO public.visits
          (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
        VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
        ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
        IF FOUND THEN _inserted := _inserted + 1; END IF;
      END IF;
      CONTINUE;
    END IF;

    IF _sub.frequency = 'twice_weekly' AND _prefs IS NOT NULL AND array_length(_prefs,1) >= 2 THEN
      _candidate := _sub.started_on;
      _candidate := _candidate - EXTRACT(DOW FROM _candidate)::int;
      WHILE _candidate <= _stop LOOP
        FOREACH _dow IN ARRAY _prefs LOOP
          _next := _candidate + _dow;
          IF _next >= _sub.started_on AND _next <= _stop
             AND NOT EXISTS (SELECT 1 FROM public.blackout_dates
                              WHERE organization_id = _org_id AND blackout_on = _next) THEN
            INSERT INTO public.visits
              (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _next)
            ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
        END LOOP;
        _candidate := _candidate + 7;
      END LOOP;
      CONTINUE;
    END IF;

    -- weekly honors interval_weeks (every N weeks); every_n_days uses
    -- interval_days. Both default to their base cadence when unset.
    _step := CASE _sub.frequency
      WHEN 'weekly'        THEN 7 * GREATEST(COALESCE(_sub.interval_weeks, 1), 1)
      WHEN 'biweekly'      THEN 14
      WHEN 'twice_weekly'  THEN 3
      WHEN 'every_n_days'  THEN GREATEST(COALESCE(_sub.interval_days, 1), 1)
      WHEN 'monthly'       THEN NULL
    END;

    SELECT MAX(scheduled_on) INTO _next FROM public.visits WHERE subscription_id = _sub.id;
    IF _next IS NULL THEN
      _candidate := _sub.started_on;
      IF _prefs IS NOT NULL AND _sub.frequency IN ('weekly','biweekly') THEN
        _guard := 0;
        WHILE NOT (EXTRACT(DOW FROM _candidate)::int = ANY(_prefs)) AND _guard < 7 LOOP
          _candidate := _candidate + 1;
          _guard := _guard + 1;
        END LOOP;
      END IF;
    ELSE
      IF _sub.frequency = 'monthly' THEN
        _candidate := (_next + INTERVAL '1 month')::date;
      ELSE
        _candidate := _next + _step;
      END IF;
    END IF;

    WHILE _candidate <= _stop LOOP
      _guard := 0;
      WHILE EXISTS (SELECT 1 FROM public.blackout_dates
                     WHERE organization_id = _org_id AND blackout_on = _candidate)
        AND _guard < 14 LOOP
        _candidate := _candidate + 1;
        _guard := _guard + 1;
      END LOOP;

      IF _candidate > _stop THEN EXIT; END IF;

      INSERT INTO public.visits
        (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
      VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
      ON CONFLICT (subscription_id, scheduled_on) DO NOTHING;
      IF FOUND THEN _inserted := _inserted + 1; END IF;

      IF _sub.frequency = 'monthly' THEN
        _candidate := (_candidate + INTERVAL '1 month')::date;
      ELSE
        _candidate := _candidate + _step;
      END IF;
    END LOOP;
  END LOOP;

  RETURN _inserted;
END;
$fn$;

-- Grant posture is unchanged: core stays internal to the two wrappers.
REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date) FROM PUBLIC, anon, authenticated;
