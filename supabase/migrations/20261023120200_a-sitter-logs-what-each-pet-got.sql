-- A sitter logs what each pet got: pet sitting (#411), the sitter's day.
--
-- 1. public.care_log: one row per thing a sitter did for a pet on a visit.
--    Fed, water, litter or yard, a walk, a medication given, or a medication
--    missed with the reason. pet_id is NULL for "all pets" (the water bowl in
--    the kitchen). at is when it was done; given_by is the sitter's staff row.
--
--    Read by a member of the business who may see the visit's home
--    (may_read_property_row, the rule pets and stays read by). Written only
--    through the two functions below: no policy grants INSERT, UPDATE or
--    DELETE, and authenticated holds SELECT alone.
--
-- 2. record_care_entry writes one entry. The assigned sitter or the office
--    (is_visit_tech or can_write_org, the walk report's rule); a pet sitting
--    visit that is under way, or completed today on the business's clock; a
--    pet that lives at the visit's home. _id is minted on the device, so the
--    replay of a request that landed after the app stopped waiting for it
--    finds its row instead of logging the same dose twice.
--
--    delete_care_entry undoes a mis-tap: the same people, within 12 hours.
--
-- 3. sit_visit_facts answers what My Day needs about a stay visit that a tech
--    cannot read for themselves (a tech has no read on subscriptions): the
--    stay's kind and dates, its pets, the plan's window, and which visit of
--    the stay this is ("Night 2 of 5"). Only for visits the caller works or
--    the office.
--
-- 4. organizations.notify_email_missed_meds, on by default: the client is
--    emailed when a visit ends with a medication missed. Pet sitting visits
--    only (src/lib/sit-report.server.ts).
--
-- The office hears about a missed medication from the app, not from here:
-- recordCareEntry calls notifyRoles after this function returns. A row SQL
-- writes into app_notifications never reaches a phone (20261004150000, whose
-- check block warns on a second SQL writer), and a missed insulin dose is
-- worth a push.
--
-- Replays into an empty database: one table, three functions, one column. No
-- row is needed and no number measured from a live database is asserted.

-- ── 1. The log ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.care_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  pet_id uuid REFERENCES public.dogs(id) ON DELETE SET NULL,
  kind text NOT NULL,
  med_name text,
  status text NOT NULL DEFAULT 'done',
  missed_reason text,
  at timestamptz NOT NULL DEFAULT now(),
  given_by uuid REFERENCES public.staff(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid DEFAULT auth.uid(),
  CONSTRAINT care_log_kind_check
    CHECK (kind IN ('feed', 'meds', 'litter', 'walk', 'water', 'other')),
  CONSTRAINT care_log_status_check CHECK (status IN ('done', 'missed')),
  CONSTRAINT care_log_med_name_fits_kind CHECK (
    (kind = 'meds' AND med_name IS NOT NULL AND btrim(med_name) <> '' AND char_length(med_name) <= 80)
    OR (kind <> 'meds' AND med_name IS NULL)
  ),
  CONSTRAINT care_log_missed_has_reason CHECK (
    (status = 'missed' AND missed_reason IS NOT NULL AND btrim(missed_reason) <> ''
      AND char_length(missed_reason) <= 300)
    OR (status = 'done' AND missed_reason IS NULL)
  ),
  CONSTRAINT care_log_note_length CHECK (note IS NULL OR char_length(note) <= 300)
);

CREATE INDEX IF NOT EXISTS care_log_visit_idx ON public.care_log(visit_id, at);
CREATE INDEX IF NOT EXISTS care_log_org_at_idx ON public.care_log(organization_id, at);
CREATE INDEX IF NOT EXISTS care_log_pet_idx ON public.care_log(pet_id);
CREATE INDEX IF NOT EXISTS care_log_given_by_idx ON public.care_log(given_by);

COMMENT ON TABLE public.care_log IS
  'What a sitter did for each pet on a pet sitting visit (#411): fed, water, litter, walk, a medication given or missed (with the reason). Written only by record_care_entry and delete_care_entry. Migration 20261023120200.';
COMMENT ON COLUMN public.care_log.pet_id IS
  'The pet (public.dogs). NULL for all pets at the home.';
COMMENT ON COLUMN public.care_log.med_name IS
  'For kind meds: the medication, as named in the pet''s care instructions. NULL for every other kind.';
COMMENT ON COLUMN public.care_log.missed_reason IS
  'Why it was not done, required when status is missed. Up to 300 characters. Goes to the office and the client.';
COMMENT ON COLUMN public.care_log.given_by IS
  'The staff row of whoever logged it. NULL when the office logged it without a staff row.';

ALTER TABLE public.care_log ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.care_log');

DROP POLICY IF EXISTS "Members read care log" ON public.care_log;
CREATE POLICY "Members read care log" ON public.care_log
  FOR SELECT TO authenticated
  USING (
    public.is_org_member((SELECT auth.uid()), organization_id)
    AND EXISTS (
      SELECT 1 FROM public.visits v
       WHERE v.id = visit_id
         AND public.may_read_property_row(v.organization_id, v.property_id)
    )
  );

REVOKE ALL ON TABLE public.care_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.care_log TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.care_log TO service_role;

-- ── 2. Writing it ────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid);

CREATE FUNCTION public.record_care_entry(
  _visit_id uuid,
  _pet_id uuid,
  _kind text,
  _med_name text,
  _status text,
  _missed_reason text,
  _note text,
  _at timestamptz DEFAULT NULL,
  _id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _property uuid;
  _vstatus public.visit_status;
  _completed_at timestamptz;
  _line text;
  _tz text;
  _today date;
  _status_v text := COALESCE(NULLIF(btrim(COALESCE(_status, '')), ''), 'done');
  _med text := NULLIF(btrim(COALESCE(_med_name, '')), '');
  _reason text := NULLIF(btrim(COALESCE(_missed_reason, '')), '');
  _note_v text := NULLIF(btrim(COALESCE(_note, '')), '');
  _when timestamptz := COALESCE(_at, now());
  _given uuid;
  _existing uuid;
  _new uuid;
BEGIN
  SELECT v.organization_id, v.property_id, v.status, v.completed_at, s.service_line
    INTO _org, _property, _vstatus, _completed_at, _line
    FROM public.visits v
    LEFT JOIN public.services s ON s.id = v.service_id
   WHERE v.id = _visit_id;
  IF _org IS NULL THEN
    RAISE EXCEPTION 'Visit not found';
  END IF;

  IF NOT (public.is_visit_tech(auth.uid(), _visit_id)
          OR public.can_write_org(auth.uid(), _org)) THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The same entry again (a replay of a request that had landed).
  IF _id IS NOT NULL THEN
    SELECT c.visit_id INTO _existing FROM public.care_log c WHERE c.id = _id;
    IF FOUND THEN
      IF _existing IS DISTINCT FROM _visit_id THEN
        RAISE EXCEPTION 'That entry belongs to another visit.' USING ERRCODE = 'check_violation';
      END IF;
      RETURN _id;
    END IF;
  END IF;

  IF _line IS DISTINCT FROM 'pet_sitting' THEN
    RAISE EXCEPTION 'Only a pet sitting visit has a care log.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT COALESCE(o.timezone, 'America/Chicago') INTO _tz
    FROM public.organizations o WHERE o.id = _org;
  _today := (now() AT TIME ZONE COALESCE(_tz, 'America/Chicago'))::date;
  IF NOT (_vstatus = 'in_progress'
          OR (_vstatus = 'completed' AND _completed_at IS NOT NULL
              AND (_completed_at AT TIME ZONE COALESCE(_tz, 'America/Chicago'))::date = _today)) THEN
    RAISE EXCEPTION 'The care log is open while the visit is under way, and on the day it ended.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF _pet_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.dogs d
     WHERE d.id = _pet_id AND d.property_id = _property AND d.organization_id = _org
  ) THEN
    RAISE EXCEPTION 'That pet does not live at this home.' USING ERRCODE = 'check_violation';
  END IF;

  IF _kind IS NULL OR _kind NOT IN ('feed', 'meds', 'litter', 'walk', 'water', 'other') THEN
    RAISE EXCEPTION 'Unknown care entry kind.' USING ERRCODE = 'check_violation';
  END IF;
  IF _status_v NOT IN ('done', 'missed') THEN
    RAISE EXCEPTION 'A care entry is done or missed.' USING ERRCODE = 'check_violation';
  END IF;

  IF _kind = 'meds' THEN
    IF _med IS NULL THEN
      RAISE EXCEPTION 'Name the medication.' USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(_med) > 80 THEN
      RAISE EXCEPTION 'A medication name is up to 80 characters.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    _med := NULL;
  END IF;

  IF _status_v = 'missed' THEN
    IF _reason IS NULL THEN
      RAISE EXCEPTION 'Say why it was missed.' USING ERRCODE = 'check_violation';
    END IF;
    IF char_length(_reason) > 300 THEN
      RAISE EXCEPTION 'The reason can be up to 300 characters.' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    _reason := NULL;
  END IF;

  IF _note_v IS NOT NULL AND char_length(_note_v) > 300 THEN
    RAISE EXCEPTION 'A care note can be up to 300 characters.' USING ERRCODE = 'check_violation';
  END IF;

  -- A phone clock is a hint. Ahead of the server is now; days behind is a
  -- queue that should not be believed.
  IF _when > now() THEN
    _when := now();
  END IF;
  IF _when < now() - interval '2 days' THEN
    RAISE EXCEPTION 'That entry is too old to log.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT s.id INTO _given
    FROM public.staff s
   WHERE s.user_id = auth.uid() AND s.organization_id = _org
   LIMIT 1;

  INSERT INTO public.care_log
    (id, organization_id, visit_id, pet_id, kind, med_name, status, missed_reason, at, given_by, note)
  VALUES
    (COALESCE(_id, gen_random_uuid()), _org, _visit_id, _pet_id, _kind, _med, _status_v, _reason,
     _when, _given, _note_v)
  RETURNING id INTO _new;
  RETURN _new;
END;
$function$;

REVOKE ALL ON FUNCTION public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid) IS
  'Logs one thing a sitter did for a pet (#411). The assigned sitter or the office; a pet sitting visit under way or completed today; a pet at the visit''s home. _id is minted on the device, so a replay returns the same row. Migration 20261023120200.';

CREATE OR REPLACE FUNCTION public.delete_care_entry(_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _org uuid;
  _visit uuid;
  _created timestamptz;
BEGIN
  SELECT c.organization_id, c.visit_id, c.created_at INTO _org, _visit, _created
    FROM public.care_log c WHERE c.id = _id;
  -- Already gone: an undo replayed twice is the same undo.
  IF _org IS NULL THEN
    RETURN;
  END IF;

  IF NOT (public.is_visit_tech(auth.uid(), _visit)
          OR public.can_write_org(auth.uid(), _org)) THEN
    RAISE EXCEPTION 'Not authorized for this visit' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF _created < now() - interval '12 hours' THEN
    RAISE EXCEPTION 'An entry can be removed within 12 hours of logging it.'
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM public.care_log WHERE id = _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.delete_care_entry(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_care_entry(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.delete_care_entry(uuid) IS
  'Undoes a care log entry logged by mistake: the assigned sitter or the office, within 12 hours. Migration 20261023120200.';

-- ── 3. What My Day needs about a stay visit ──────────────────────────────

DROP FUNCTION IF EXISTS public.sit_visit_facts(uuid[]);

CREATE FUNCTION public.sit_visit_facts(_visit_ids uuid[])
RETURNS TABLE (
  visit_id uuid,
  stay_id uuid,
  kind text,
  starts_on date,
  ends_on date,
  pet_ids uuid[],
  visit_number integer,
  visit_total integer,
  window_earliest time,
  window_latest time
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH asked AS (
    SELECT DISTINCT a.id FROM unnest(_visit_ids[1:200]) AS a(id)
  ), mine AS (
    SELECT v.id, s.stay_id, s.earliest_time, s.latest_time
      FROM asked
      JOIN public.visits v ON v.id = asked.id
      JOIN public.subscriptions s ON s.id = v.subscription_id
     WHERE s.stay_id IS NOT NULL
       AND (public.is_visit_tech(auth.uid(), v.id)
            OR public.can_write_org(auth.uid(), v.organization_id))
  ), numbered AS (
    SELECT v.id, s.stay_id,
           row_number() OVER (PARTITION BY s.stay_id
                              ORDER BY v.scheduled_on, s.earliest_time NULLS LAST, v.id) AS n,
           count(*) OVER (PARTITION BY s.stay_id) AS total
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
     WHERE s.stay_id IN (SELECT m.stay_id FROM mine m)
       AND v.status <> 'canceled'
  )
  SELECT m.id, st.id, st.kind, st.starts_on, st.ends_on, st.pet_ids,
         nb.n::integer, nb.total::integer, m.earliest_time, m.latest_time
    FROM mine m
    JOIN public.stays st ON st.id = m.stay_id
    LEFT JOIN numbered nb ON nb.id = m.id;
$function$;

REVOKE ALL ON FUNCTION public.sit_visit_facts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sit_visit_facts(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.sit_visit_facts(uuid[]) IS
  'For My Day (#411): each stay visit''s stay (kind, dates, pets), its plan window, and which visit of the stay it is, for visits the caller works or the office. Up to 200 ids. Migration 20261023120200.';

-- ── 4. The client's email switch ─────────────────────────────────────────

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_missed_meds boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.notify_email_missed_meds IS
  'Email the client when a pet sitting visit ends with a medication missed, with the reason. Pet sitting visits only. Migration 20261023120200.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _missing text;
BEGIN
  IF to_regclass('public.care_log') IS NULL THEN
    RAISE EXCEPTION 'public.care_log is missing';
  END IF;

  SELECT string_agg(expected.name, ', ') INTO _missing
    FROM (VALUES
      ('care_log_kind_check'), ('care_log_status_check'), ('care_log_med_name_fits_kind'),
      ('care_log_missed_has_reason'), ('care_log_note_length')
    ) AS expected(name)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.care_log'::regclass AND conname = expected.name);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'care_log constraints are missing: %', _missing;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'care_log'
                    AND indexname = 'care_log_visit_idx') THEN
    RAISE EXCEPTION 'care_log_visit_idx is missing';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.care_log'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'care_log'
                       AND policyname = 'two-step sign-in, when the user has it'
                       AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'care_log lacks row level security or the two-step policy';
  END IF;
  -- Read only: one permissive policy, for SELECT. Writes go through the
  -- functions.
  IF (SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'care_log' AND permissive = 'PERMISSIVE') <> 1
     OR NOT EXISTS (SELECT 1 FROM pg_policies
                     WHERE schemaname = 'public' AND tablename = 'care_log'
                       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT') THEN
    RAISE EXCEPTION 'care_log should have exactly one permissive policy, for SELECT';
  END IF;
  IF has_table_privilege('authenticated', 'public.care_log', 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
    RAISE EXCEPTION 'a signed-in user can write care_log directly';
  END IF;
  IF has_table_privilege('anon', 'public.care_log',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'anonymous callers can reach care_log';
  END IF;

  IF to_regprocedure('public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)') IS NULL
     OR to_regprocedure('public.delete_care_entry(uuid)') IS NULL
     OR to_regprocedure('public.sit_visit_facts(uuid[])') IS NULL THEN
    RAISE EXCEPTION 'a care log function is missing';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid IN (
       'public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)'::regprocedure,
       'public.delete_care_entry(uuid)'::regprocedure,
       'public.sit_visit_facts(uuid[])'::regprocedure)
       AND (NOT p.prosecdef
            OR p.prosrc !~ 'is_visit_tech'
            OR p.prosrc !~ 'can_write_org'
            OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) AS c(setting)
                            WHERE c.setting LIKE 'search_path=%'))
  ) THEN
    RAISE EXCEPTION 'every care log function is SECURITY DEFINER, pins search_path and checks the sitter and the office';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)'::regprocedure)
     !~ 'd\.property_id = _property' THEN
    RAISE EXCEPTION 'record_care_entry does not check the pet lives at the visit''s home';
  END IF;
  IF has_function_privilege('anon', 'public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.delete_care_entry(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.sit_visit_facts(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a care log function';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.record_care_entry(uuid, uuid, text, text, text, text, text, timestamptz, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.delete_care_entry(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.sit_visit_facts(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute a care log function';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
       AND c.column_name = 'notify_email_missed_meds'
       AND c.is_nullable = 'NO' AND c.column_default = 'true' AND c.data_type = 'boolean'
  ) THEN
    RAISE EXCEPTION 'organizations.notify_email_missed_meds must be boolean NOT NULL DEFAULT true';
  END IF;
END
$check$;
