-- A stay is a sitter's booking: pet sitting (#411), part 2 of 2.
--
-- A client going away books a sitter for a run of days: drop-ins (one to four
-- visits a day, each in its own arrival window) or overnights (the sitter
-- arrives in the evening and stays the night). This file adds the booking and
-- makes its visits ordinary visits, so the board, routes, My Day, completion
-- and invoices handle them the way they handle every other visit.
--
-- ── THE SCHEMA ───────────────────────────────────────────────────────────
--
--   public.stays             the booking: client, property, the pet-sitting
--                            service, first and last day, drop-in windows or
--                            an overnight arrival window, the pets, the
--                            sitter, a status, an optional deposit, and the
--                            pets' care instructions as they were when the
--                            stay was confirmed (care_snapshot).
--   subscriptions.stay_id    the plans a stay's visits come from.
--
-- kind is not chosen by the caller: it follows the service (a service priced
-- per night is an overnight, anything else a drop-in), set on every write by
-- tg_stays_validate so the two cannot disagree.
--
-- pet_ids lists the pets on the stay (public.dogs rows at the stay's
-- property). The task asked for "pets on the stay" in the booking form; a
-- column rather than a join table because the list is read whole, with the
-- stay, and never on its own.
--
-- ── VISITS ───────────────────────────────────────────────────────────────
--
-- A stay's visits come from sibling plans, the way #468's walk times do: one
-- plan per drop-in window, or one plan for the overnight arrival window. Each
-- plan is weekly on every weekday, bounded by started_on and ends_on, sold as
-- the stay's service at the service's price for the stay's pets. The days:
--
--   drop-in     starts_on .. ends_on, both included. Mon..Fri with two
--               windows is ten visits.
--   overnight   starts_on .. ends_on - 1. ends_on is the checkout morning, so
--               Mon -> Sat is five nights and five visits.
--
-- generate_visits_core gains one branch for a plan with a stay, spliced in the
-- way 20261010010000 spliced the weekday branch. It differs from that branch
-- in one respect, on purpose: it does NOT skip a client hold or a business
-- blackout. A client who books a sitter is very often the same client who
-- paused their scooping for the trip, and a pet still has to be fed on a
-- holiday. It still leaves alone a day a visit was rescheduled away from.
-- Its INSERT uses ON CONFLICT DO NOTHING without naming the target, so the
-- count 20261010010000 asserts (four INSERTs naming (subscription_id,
-- scheduled_on)) still holds if that file is re-applied in a proof.
--
-- The sitter: a stay visit inserted with no one assigned takes the stay's
-- sitter (tg_visits_stay_sitter). Changing the stay's sitter moves its future
-- scheduled visits to the new one (tg_stays_follow).
--
-- One sitter, one bed: a staff member cannot have two overnight stay visits
-- on the same night. tg_visits_stay_sitter refuses it with a sentence naming
-- the night, whatever wrote the visit (the booking, a sitter change, the
-- board). The generator never trips it: a stay visit it inserts takes the
-- sitter only when that night is free, and is left unassigned otherwise.
--
-- Canceling a stay cancels its scheduled visits from the business's today on
-- (status 'canceled', the status the board already uses; a visit on an
-- invoice is left alone) and ends its plans (status 'canceled').
--
-- ── PERMISSIONS ──────────────────────────────────────────────────────────
--
-- Writes: can_write_org, as public.dogs and walk_groups. The plans are written
-- by the server function, which requires manage_pricing as every plan writer
-- does. Reads: a member of the business who may see the stay's property
-- (may_read_property_row): the office sees every stay, a sitter the ones at
-- homes they have a visit at. Role redesign is #460; nothing new here.
--
-- Replays into an empty database: tables, functions, triggers and one splice
-- of a function the earlier files define. No row is needed and no number is
-- asserted.

-- ── 1. The table ─────────────────────────────────────────────────────────

-- Drop-in windows: an array of one to four {earliest, latest} "HH:MM" with
-- earliest before latest, no two the same. plpgsql so every step runs in
-- order (jsonb_array_length raises on a non-array).
CREATE OR REPLACE FUNCTION public.stay_windows_are_valid(_windows jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  _w jsonb;
  _key text;
  _seen text[] := '{}';
  _pair text;
BEGIN
  IF _windows IS NULL OR jsonb_typeof(_windows) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(_windows) NOT BETWEEN 1 AND 4 THEN RETURN false; END IF;
  FOR _w IN SELECT value FROM jsonb_array_elements(_windows) LOOP
    IF jsonb_typeof(_w) <> 'object' THEN RETURN false; END IF;
    FOR _key IN SELECT jsonb_object_keys(_w) LOOP
      IF _key NOT IN ('earliest', 'latest') THEN RETURN false; END IF;
    END LOOP;
    IF jsonb_typeof(_w -> 'earliest') IS DISTINCT FROM 'string'
       OR jsonb_typeof(_w -> 'latest') IS DISTINCT FROM 'string'
       OR (_w ->> 'earliest') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR (_w ->> 'latest') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
       OR (_w ->> 'earliest') >= (_w ->> 'latest') THEN
      RETURN false;
    END IF;
    _pair := (_w ->> 'earliest') || '/' || (_w ->> 'latest');
    IF _pair = ANY(_seen) THEN RETURN false; END IF;
    _seen := _seen || _pair;
  END LOOP;
  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.stay_windows_are_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stay_windows_are_valid(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.stay_windows_are_valid(jsonb) IS
  'True for one to four distinct drop-in windows [{earliest, latest}] in "HH:MM", earliest before latest. Mirrored by stayWindowsProblem in src/lib/stays.ts. Migration 20261023120100.';

CREATE TABLE IF NOT EXISTS public.stays (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES public.services(id),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  kind text NOT NULL,
  drop_in_windows jsonb,
  overnight_arrival_earliest time,
  overnight_arrival_latest time,
  pet_ids uuid[] NOT NULL DEFAULT '{}',
  assigned_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'confirmed',
  deposit_cents integer,
  care_snapshot jsonb,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  CONSTRAINT stays_kind_check CHECK (kind IN ('drop_in', 'overnight')),
  CONSTRAINT stays_status_check CHECK (status IN ('requested', 'confirmed', 'canceled', 'completed')),
  CONSTRAINT stays_dates_check CHECK (ends_on >= starts_on),
  CONSTRAINT stays_overnight_has_a_night CHECK (kind <> 'overnight' OR ends_on > starts_on),
  CONSTRAINT stays_windows_fit_kind CHECK (
    (kind = 'drop_in' AND drop_in_windows IS NOT NULL AND public.stay_windows_are_valid(drop_in_windows)
      AND overnight_arrival_earliest IS NULL AND overnight_arrival_latest IS NULL)
    OR (kind = 'overnight' AND drop_in_windows IS NULL
      AND overnight_arrival_earliest IS NOT NULL AND overnight_arrival_latest IS NOT NULL
      AND overnight_arrival_earliest < overnight_arrival_latest)
  ),
  CONSTRAINT stays_deposit_check CHECK (deposit_cents IS NULL OR deposit_cents BETWEEN 0 AND 10000000),
  CONSTRAINT stays_care_snapshot_is_array CHECK (care_snapshot IS NULL OR jsonb_typeof(care_snapshot) = 'array'),
  CONSTRAINT stays_notes_length CHECK (notes IS NULL OR char_length(notes) <= 1000),
  CONSTRAINT stays_pet_count CHECK (cardinality(pet_ids) <= 30)
);

CREATE INDEX IF NOT EXISTS stays_org_starts_idx ON public.stays(organization_id, starts_on);
CREATE INDEX IF NOT EXISTS stays_client_idx ON public.stays(client_id);
CREATE INDEX IF NOT EXISTS stays_property_idx ON public.stays(property_id);
CREATE INDEX IF NOT EXISTS stays_service_idx ON public.stays(service_id);
CREATE INDEX IF NOT EXISTS stays_staff_idx ON public.stays(assigned_staff_id);

COMMENT ON TABLE public.stays IS
  'A pet sitter''s booking (#411): drop-ins or overnights at a client''s home from starts_on to ends_on. Its visits come from plans with subscriptions.stay_id. kind follows the service (priced per night = overnight). Migration 20261023120100.';
COMMENT ON COLUMN public.stays.ends_on IS
  'Drop-in: the last day with visits. Overnight: the checkout morning, so the last night is ends_on - 1.';
COMMENT ON COLUMN public.stays.pet_ids IS
  'The pets on the stay: public.dogs rows at the stay''s property. Their number prices the stay.';
COMMENT ON COLUMN public.stays.care_snapshot IS
  'The pets'' care instructions as they were when the stay was confirmed: [{pet_id, name, species, species_note, feeding, meds, other_care}].';

-- ── 2. Every write agrees with itself ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_stays_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _line text;
  _unit text;
  _svc_org uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients c
                  WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That client was not found.' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties p
                  WHERE p.id = NEW.property_id AND p.client_id = NEW.client_id
                    AND p.organization_id = NEW.organization_id) THEN
    RAISE EXCEPTION 'That property does not belong to this client.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.service_line, s.price_unit, s.organization_id INTO _line, _unit, _svc_org
    FROM public.services s WHERE s.id = NEW.service_id;
  IF _svc_org IS DISTINCT FROM NEW.organization_id OR _line IS DISTINCT FROM 'pet_sitting' THEN
    RAISE EXCEPTION 'Choose a pet sitting service.' USING ERRCODE = 'check_violation';
  END IF;
  NEW.kind := CASE WHEN _unit = 'night' THEN 'overnight' ELSE 'drop_in' END;

  IF NEW.kind = 'overnight' THEN
    NEW.overnight_arrival_earliest := COALESCE(NEW.overnight_arrival_earliest, '19:00'::time);
    NEW.overnight_arrival_latest := COALESCE(NEW.overnight_arrival_latest, '21:00'::time);
    IF NEW.ends_on <= NEW.starts_on THEN
      RAISE EXCEPTION 'An overnight stay checks out at least one day after it checks in.'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.drop_in_windows IS NULL OR NOT public.stay_windows_are_valid(NEW.drop_in_windows) THEN
    RAISE EXCEPTION 'Set one to four drop-in times, each with an earliest and latest arrival.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.staff s
     WHERE s.id = NEW.assigned_staff_id AND s.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'Choose a sitter from this business.' USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM unnest(NEW.pet_ids) AS p(id)
     WHERE NOT EXISTS (SELECT 1 FROM public.dogs d
                        WHERE d.id = p.id AND d.property_id = NEW.property_id
                          AND d.organization_id = NEW.organization_id)
  ) THEN
    RAISE EXCEPTION 'Every pet on a stay has to live at its property.' USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'canceled' AND NEW.status <> 'canceled' THEN
      RAISE EXCEPTION 'A canceled stay cannot be reopened. Book a new one.' USING ERRCODE = 'check_violation';
    END IF;
    -- Its plans already carry these; changing them here would leave the
    -- visits saying something else.
    IF (NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.client_id IS DISTINCT FROM OLD.client_id
        OR NEW.property_id IS DISTINCT FROM OLD.property_id
        OR NEW.service_id IS DISTINCT FROM OLD.service_id
        OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
        OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
        OR NEW.drop_in_windows IS DISTINCT FROM OLD.drop_in_windows
        OR NEW.overnight_arrival_earliest IS DISTINCT FROM OLD.overnight_arrival_earliest
        OR NEW.overnight_arrival_latest IS DISTINCT FROM OLD.overnight_arrival_latest)
       AND EXISTS (SELECT 1 FROM public.subscriptions s WHERE s.stay_id = OLD.id) THEN
      RAISE EXCEPTION 'To change a stay''s dates, times or service, cancel it and book a new one.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_validate() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stays_validate ON public.stays;
CREATE TRIGGER stays_validate
  BEFORE INSERT OR UPDATE ON public.stays
  FOR EACH ROW EXECUTE FUNCTION public.tg_stays_validate();

ALTER TABLE public.stays ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.stays');

DROP POLICY IF EXISTS "Members read stays" ON public.stays;
CREATE POLICY "Members read stays" ON public.stays
  FOR SELECT TO authenticated
  USING (
    public.is_org_member((SELECT auth.uid()), organization_id)
    AND public.may_read_property_row(organization_id, property_id)
  );
DROP POLICY IF EXISTS "Office inserts stays" ON public.stays;
CREATE POLICY "Office inserts stays" ON public.stays
  FOR INSERT TO authenticated
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office updates stays" ON public.stays;
CREATE POLICY "Office updates stays" ON public.stays
  FOR UPDATE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id))
  WITH CHECK (public.can_write_org((SELECT auth.uid()), organization_id));
DROP POLICY IF EXISTS "Office deletes stays" ON public.stays;
CREATE POLICY "Office deletes stays" ON public.stays
  FOR DELETE TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

REVOKE ALL ON TABLE public.stays FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stays TO authenticated, service_role;

-- ── 3. The plans ─────────────────────────────────────────────────────────

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS stay_id uuid REFERENCES public.stays(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS subscriptions_stay_idx ON public.subscriptions(stay_id);

COMMENT ON COLUMN public.subscriptions.stay_id IS
  'The stay (public.stays) this plan''s visits belong to: one plan per drop-in window, or one for the overnight arrival window. NULL on every other plan. Migration 20261023120100.';

-- A plan names a stay of its own client, property, business and service.
CREATE OR REPLACE FUNCTION public.tg_subscriptions_stay()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.stays st
     WHERE st.id = NEW.stay_id
       AND st.organization_id = NEW.organization_id
       AND st.client_id = NEW.client_id
       AND st.property_id = NEW.property_id
       AND st.service_id IS NOT DISTINCT FROM NEW.service_id
  ) THEN
    RAISE EXCEPTION 'That plan does not match its stay.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_subscriptions_stay() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS subscriptions_stay ON public.subscriptions;
CREATE TRIGGER subscriptions_stay
  BEFORE INSERT OR UPDATE OF stay_id, organization_id, client_id, property_id, service_id
  ON public.subscriptions
  FOR EACH ROW
  WHEN (NEW.stay_id IS NOT NULL)
  EXECUTE FUNCTION public.tg_subscriptions_stay();

-- ── 4. Generation: one branch, spliced ───────────────────────────────────

DO $mig$
DECLARE
  _def text;
  _n int;
  _cursor_from CONSTANT text := 's.interval_weeks, s.interval_days, s.weekdays';
  _cursor_to   CONSTANT text := 's.interval_weeks, s.interval_days, s.weekdays, s.stay_id';
  _branch_at   CONSTANT text := '-- weekday set (subscriptions.weekdays, 0 = Sunday): one visit on each';
  _branch      CONSTANT text := $branch$-- a sitter's stay (subscriptions.stay_id): one visit on every day from
    -- the later of the plan's start and the business's today to its end.
    -- No client-hold or blackout skip: the client is away and the pets still
    -- need feeding. Only a day a visit was rescheduled away from is left
    -- alone. Migration 20261023120100.
    IF _sub.stay_id IS NOT NULL THEN
      DECLARE
        _stay_today date;
      BEGIN
        SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _stay_today
          FROM public.organizations o WHERE o.id = _org_id;
        _candidate := GREATEST(_sub.started_on, COALESCE(_stay_today, CURRENT_DATE));
        WHILE _candidate <= _stop LOOP
          IF NOT EXISTS (SELECT 1 FROM public.visits rv
                          WHERE rv.subscription_id = _sub.id
                            AND rv.rescheduled_from = _candidate) THEN
            INSERT INTO public.visits
              (organization_id, subscription_id, client_id, property_id, zone_id, scheduled_on)
            VALUES (_org_id, _sub.id, _sub.client_id, _sub.property_id, _sub.zone_id, _candidate)
            ON CONFLICT DO NOTHING;
            IF FOUND THEN _inserted := _inserted + 1; END IF;
          END IF;
          _candidate := _candidate + 1;
        END LOOP;
      END;
      CONTINUE;
    END IF;

    $branch$;
BEGIN
  -- A named function, never a set.
  _def := pg_get_functiondef('public.generate_visits_core(uuid, date, uuid)'::regprocedure);

  IF strpos(_def, 'IF _sub.stay_id IS NOT NULL THEN') > 0 THEN
    RAISE NOTICE 'generate_visits_core already reads stays; leaving it alone.';
    RETURN;
  END IF;

  _n := (length(_def) - length(replace(_def, _cursor_from, ''))) / length(_cursor_from);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected the plan cursor''s column list exactly once in generate_visits_core, found %', _n;
  END IF;
  _n := (length(_def) - length(replace(_def, _branch_at, ''))) / length(_branch_at);
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 "%" in generate_visits_core, found %', _branch_at, _n;
  END IF;

  _def := replace(_def, _cursor_from, _cursor_to);
  _def := replace(_def, _branch_at, _branch || _branch_at);

  EXECUTE _def;
END
$mig$;

REVOKE EXECUTE ON FUNCTION public.generate_visits_core(uuid, date, uuid) FROM PUBLIC, anon, authenticated;

-- ── 5. The sitter, and one bed a night ───────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_visits_stay_sitter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _stay record;
  _name text;
BEGIN
  SELECT st.kind, st.assigned_staff_id INTO _stay
    FROM public.subscriptions s
    JOIN public.stays st ON st.id = s.stay_id
   WHERE s.id = NEW.subscription_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  -- The stay's sitter, unless that would put them in two beds tonight.
  IF TG_OP = 'INSERT' AND NEW.assigned_staff_id IS NULL AND _stay.assigned_staff_id IS NOT NULL THEN
    IF _stay.kind <> 'overnight' OR NOT EXISTS (
      SELECT 1 FROM public.visits v
        JOIN public.subscriptions s ON s.id = v.subscription_id
        JOIN public.stays st ON st.id = s.stay_id
       WHERE v.assigned_staff_id = _stay.assigned_staff_id
         AND v.scheduled_on = NEW.scheduled_on
         AND st.kind = 'overnight'
         AND v.status NOT IN ('canceled', 'skipped', 'missed')
    ) THEN
      NEW.assigned_staff_id := _stay.assigned_staff_id;
    END IF;
  END IF;

  IF _stay.kind = 'overnight' AND NEW.assigned_staff_id IS NOT NULL
     AND NEW.status NOT IN ('canceled', 'skipped', 'missed') THEN
    -- Two bookings for the same sitter and night take turns.
    PERFORM pg_advisory_xact_lock(hashtext('houndstack.stay-night'),
                                  hashtext(NEW.assigned_staff_id::text || NEW.scheduled_on::text));
    IF EXISTS (
      SELECT 1 FROM public.visits v
        JOIN public.subscriptions s ON s.id = v.subscription_id
        JOIN public.stays st ON st.id = s.stay_id
       WHERE v.assigned_staff_id = NEW.assigned_staff_id
         AND v.scheduled_on = NEW.scheduled_on
         AND v.id <> NEW.id
         AND st.kind = 'overnight'
         AND v.status NOT IN ('canceled', 'skipped', 'missed')
    ) THEN
      SELECT display_name INTO _name FROM public.staff WHERE id = NEW.assigned_staff_id;
      RAISE EXCEPTION '% already has an overnight stay on the night of %.',
        COALESCE(NULLIF(btrim(_name), ''), 'This sitter'),
        to_char(NEW.scheduled_on, 'FMDay, FMMonth FMDD, YYYY')
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_visits_stay_sitter() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS visits_stay_sitter ON public.visits;
CREATE TRIGGER visits_stay_sitter
  BEFORE INSERT OR UPDATE OF assigned_staff_id, scheduled_on, status, subscription_id
  ON public.visits
  FOR EACH ROW EXECUTE FUNCTION public.tg_visits_stay_sitter();

-- ── 6. A new sitter, or a canceled stay ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_stays_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _today date;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(o.timezone, 'America/Chicago'))::date INTO _today
    FROM public.organizations o WHERE o.id = NEW.organization_id;
  _today := COALESCE(_today, CURRENT_DATE);

  IF NEW.status = 'canceled' AND OLD.status <> 'canceled' THEN
    UPDATE public.visits v
       SET status = 'canceled'
     WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
       AND v.status = 'scheduled'
       AND v.scheduled_on >= _today
       AND NOT EXISTS (SELECT 1 FROM public.invoice_line_items li WHERE li.visit_id = v.id);
    UPDATE public.subscriptions s
       SET status = 'canceled',
           end_reason = COALESCE(s.end_reason, 'Stay canceled'),
           ended_by = COALESCE(auth.uid(), s.ended_by)
     WHERE s.stay_id = NEW.id AND s.status <> 'canceled';
    RETURN NULL;
  END IF;

  IF NEW.assigned_staff_id IS DISTINCT FROM OLD.assigned_staff_id AND NEW.status <> 'canceled' THEN
    -- Each moved visit passes tg_visits_stay_sitter, which refuses a second
    -- overnight on one night and rolls this whole change back.
    UPDATE public.visits v
       SET assigned_staff_id = NEW.assigned_staff_id, sequence = NULL
     WHERE v.subscription_id IN (SELECT s.id FROM public.subscriptions s WHERE s.stay_id = NEW.id)
       AND v.status = 'scheduled'
       AND v.scheduled_on >= _today;
  END IF;
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_follow() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS stays_follow ON public.stays;
CREATE TRIGGER stays_follow
  AFTER UPDATE OF status, assigned_staff_id ON public.stays
  FOR EACH ROW
  WHEN (OLD.status IS DISTINCT FROM NEW.status
        OR OLD.assigned_staff_id IS DISTINCT FROM NEW.assigned_staff_id)
  EXECUTE FUNCTION public.tg_stays_follow();

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _src text;
BEGIN
  IF to_regclass('public.stays') IS NULL THEN
    RAISE EXCEPTION 'public.stays is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'stay_id'
  ) THEN
    RAISE EXCEPTION 'public.subscriptions.stay_id is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'stays'
                    AND indexname = 'stays_org_starts_idx')
     OR NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'subscriptions'
                    AND indexname = 'subscriptions_stay_idx') THEN
    RAISE EXCEPTION 'the stay indexes are missing';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.stays'::regclass AND relrowsecurity)
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'stays'
                       AND policyname = 'two-step sign-in, when the user has it'
                       AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'stays lacks row level security or the two-step policy';
  END IF;
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'stays' AND permissive = 'PERMISSIVE') <> 4
     OR EXISTS (SELECT 1 FROM pg_policies
                 WHERE schemaname = 'public' AND tablename = 'stays'
                   AND permissive = 'PERMISSIVE' AND cmd = 'ALL') THEN
    RAISE EXCEPTION 'stays should have four permissive policies, one per command';
  END IF;
  IF has_table_privilege('anon', 'public.stays',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'anonymous callers can reach stays';
  END IF;

  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('public.stays', 'stays_validate'),
      ('public.stays', 'stays_follow'),
      ('public.subscriptions', 'subscriptions_stay'),
      ('public.visits', 'visits_stay_sitter')
    ) AS expected(rel, name)
    WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                       WHERE t.tgrelid = expected.rel::regclass AND t.tgname = expected.name
                         AND NOT t.tgisinternal AND t.tgenabled <> 'D')
  ) THEN
    RAISE EXCEPTION 'a stay trigger is missing or disabled';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_stays_validate()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_follow()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_subscriptions_stay()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_visits_stay_sitter()', 'EXECUTE') THEN
    RAISE EXCEPTION 'a stay trigger function is callable through the API';
  END IF;

  -- The window rule, as the CHECK and the trigger apply it.
  IF NOT public.stay_windows_are_valid('[{"earliest": "08:00", "latest": "10:00"}]')
     OR NOT public.stay_windows_are_valid('[{"earliest": "08:00", "latest": "10:00"}, {"earliest": "17:00", "latest": "19:00"}]')
     OR public.stay_windows_are_valid('[]')
     OR public.stay_windows_are_valid('[{"earliest": "10:00", "latest": "08:00"}]')
     OR public.stay_windows_are_valid('[{"earliest": "08:00", "latest": "10:00"}, {"earliest": "08:00", "latest": "10:00"}]')
     OR public.stay_windows_are_valid('[{"earliest": "8am", "latest": "10:00"}]')
     OR public.stay_windows_are_valid('[{"earliest": "06:00", "latest": "07:00"}, {"earliest": "08:00", "latest": "09:00"}, {"earliest": "10:00", "latest": "11:00"}, {"earliest": "12:00", "latest": "13:00"}, {"earliest": "14:00", "latest": "15:00"}]')
     OR public.stay_windows_are_valid('{}') THEN
    RAISE EXCEPTION 'stay_windows_are_valid does not hold the rule it documents';
  END IF;

  -- Comments stripped first: prosrc keeps them.
  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p
   WHERE p.oid = 'public.generate_visits_core(uuid, date, uuid)'::regprocedure;
  IF _src NOT LIKE '%s.stay_id%' OR _src NOT LIKE '%IF _sub.stay_id IS NOT NULL THEN%' THEN
    RAISE EXCEPTION 'generate_visits_core does not read stays';
  END IF;
  -- The stay branch comes before the weekday branch, which would otherwise
  -- take a stay plan (every weekday) and skip the client's hold days.
  IF strpos(_src, 'IF _sub.stay_id IS NOT NULL THEN') > strpos(_src, 'IF _sub.weekdays IS NOT NULL THEN') THEN
    RAISE EXCEPTION 'the stay branch must come before the weekday branch in generate_visits_core';
  END IF;
  IF has_function_privilege('anon', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.generate_visits_core(uuid, date, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'generate_visits_core is callable through the API';
  END IF;
END
$check$;
