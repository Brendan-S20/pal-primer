-- Nobody was on the clock, because there was no clock.
--
-- Found 2026-09-28 by the persona review of an owner moving three trucks over
-- from Jobber. Jobber and Sweep&Go both keep a time clock: a tech taps in when
-- the day starts and out when it ends, and the office pays from the sheet.
-- This product had no clock-in, no timesheet and no payroll input anywhere, so
-- an owner switching over would be back to a paper sheet on the dashboard.
--
-- time_entries is one row per shift. A row with no clock_out is the shift
-- that is still running, and a partial unique index allows exactly one of
-- those per person, so a double tap, a second device or an offline replay
-- arriving after the live tap landed cannot open a second.
--
-- NOBODY WRITES THE TABLE DIRECTLY. There is a SELECT policy and nothing
-- else, and the write privileges are revoked from the API roles on top of
-- that. A tech's own row is where their pay comes from, so it is written only
-- by four SECURITY DEFINER functions that each say what they check:
--
--   clock_in(_at)   the caller's own staff row, idempotent while a shift is
--                   open. `_at` is the tap time from an offline replay and is
--                   believed on the same terms complete_visit believes
--                   `_completed_at` (20260928050000): not in the future, not
--                   more than seven days back. A replay is recorded as one
--                   whether or not its time survived.
--   clock_out(_at)  closes the caller's open shift; a no-op returning NULL
--                   when there is none, so a replay of a tap the live path
--                   already handled does nothing.
--   office_edit_time_entry / office_add_time_entry
--                   the forgotten clock-out and the forgotten day, for
--                   whoever holds manage_users (owner, office manager). Each
--                   edited end is marked 'office' and the row carries who
--                   edited it and when, because a pay record that changed
--                   after the fact has to say so.
--
-- Two shifts for one person may not overlap: hours on a timesheet are summed,
-- and an overlap is the same hour paid twice. The tech functions clamp a
-- replayed clock-in to the end of the previous shift; the office functions
-- refuse, and the timesheet beside the form shows which shift is in the way.
--
-- Replays into an empty database: one table, its indexes and policy, four
-- functions and their grants. Every assertion below is about what this file
-- establishes; none needs a tenant or a row.

CREATE TABLE IF NOT EXISTS public.time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  staff_id uuid NOT NULL REFERENCES public.staff(id) ON DELETE CASCADE,
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  clock_in_source text NOT NULL DEFAULT 'tech_live',
  clock_out_source text,
  note text,
  edited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  edited_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT time_entries_out_after_in CHECK (clock_out IS NULL OR clock_out > clock_in),
  CONSTRAINT time_entries_clock_in_source CHECK (
    clock_in_source IN ('tech_live', 'tech_offline_replay', 'office')
  ),
  CONSTRAINT time_entries_clock_out_source CHECK (
    clock_out_source IS NULL OR clock_out_source IN ('tech_live', 'tech_offline_replay', 'office')
  ),
  -- An end with no source, or a source with no end, is a row that cannot say
  -- how its end was measured.
  CONSTRAINT time_entries_out_source_with_out CHECK ((clock_out IS NULL) = (clock_out_source IS NULL)),
  CONSTRAINT time_entries_note_length CHECK (note IS NULL OR char_length(note) <= 500)
);

COMMENT ON TABLE public.time_entries IS
  'One row per shift on the time clock. clock_out NULL is the shift still running. Written only by clock_in, clock_out, office_edit_time_entry and office_add_time_entry.';
COMMENT ON COLUMN public.time_entries.clock_in_source IS
  'How clock_in was measured: tech_live (the server clock at the tap), tech_offline_replay (the device''s tap time, replayed), office (entered or corrected by the office).';
COMMENT ON COLUMN public.time_entries.edited_by IS
  'Who last corrected this entry from the office, when anyone has.';

-- One running shift per person. The idempotency of clock_in rests on this, not
-- on the SELECT that precedes the INSERT: two transactions can both read "no
-- open shift", and only one of them can then write one.
CREATE UNIQUE INDEX IF NOT EXISTS time_entries_one_open_per_staff
  ON public.time_entries (staff_id) WHERE clock_out IS NULL;

-- The timesheet reads a week of an org by clock_in.
CREATE INDEX IF NOT EXISTS time_entries_org_clock_in
  ON public.time_entries (organization_id, clock_in);
-- Every foreign key indexed. organization_id is the leading column above.
CREATE INDEX IF NOT EXISTS time_entries_staff_clock_in
  ON public.time_entries (staff_id, clock_in);
CREATE INDEX IF NOT EXISTS time_entries_edited_by
  ON public.time_entries (edited_by) WHERE edited_by IS NOT NULL;

ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;

-- Belt and braces with the policy set below: the API roles cannot write this
-- table even if a permissive write policy is ever added by mistake, and anon
-- cannot read it at all.
REVOKE ALL ON public.time_entries FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.time_entries FROM authenticated;
GRANT SELECT ON public.time_entries TO authenticated;
GRANT ALL ON public.time_entries TO service_role;

DROP POLICY IF EXISTS "Own time, or the org's for managers" ON public.time_entries;
CREATE POLICY "Own time, or the org's for managers" ON public.time_entries
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.staff s
       WHERE s.id = time_entries.staff_id
         AND s.user_id = (SELECT auth.uid())
    )
    OR public.has_permission((SELECT auth.uid()), organization_id, 'manage_users')
  );

-- ── clock_in ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.clock_in(_at timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _staff_id uuid;
  _org_id uuid;
  _open uuid;
  _last_out timestamptz;
  _when timestamptz := now();
  _source text := 'tech_live';
  _id uuid;
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to clock in';
  END IF;

  -- The caller's own staff row, in the org they belong to. Locked, so two
  -- taps from two devices take turns rather than racing to the index.
  SELECT s.id, s.organization_id INTO _staff_id, _org_id
    FROM public.staff s
    JOIN public.user_roles ur ON ur.user_id = s.user_id AND ur.organization_id = s.organization_id
   WHERE s.user_id = _uid AND s.active
   ORDER BY s.created_at
   LIMIT 1
   FOR UPDATE OF s;
  IF _staff_id IS NULL THEN
    RAISE EXCEPTION 'Only an active member of the team can clock in';
  END IF;

  -- Already on the clock: that shift is the answer. A double tap, a second
  -- device and a replay of a tap whose live request landed late all end here.
  SELECT id INTO _open FROM public.time_entries WHERE staff_id = _staff_id AND clock_out IS NULL;
  IF _open IS NOT NULL THEN
    RETURN _open;
  END IF;

  IF _at IS NOT NULL THEN
    -- Believe the tap time only if it is possible; otherwise now(). Either way
    -- this was not measured live, and the source says so.
    IF _at <= now() AND _at >= now() - interval '7 days' THEN
      _when := _at;
    END IF;
    _source := 'tech_offline_replay';
  END IF;

  -- A replayed tap cannot reach back into the previous shift.
  SELECT max(clock_out) INTO _last_out FROM public.time_entries WHERE staff_id = _staff_id;
  IF _last_out IS NOT NULL AND _when < _last_out THEN
    _when := _last_out;
  END IF;

  BEGIN
    INSERT INTO public.time_entries (organization_id, staff_id, clock_in, clock_in_source)
    VALUES (_org_id, _staff_id, _when, _source)
    RETURNING id INTO _id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO _id FROM public.time_entries WHERE staff_id = _staff_id AND clock_out IS NULL;
  END;
  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.clock_in(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_in(timestamptz) TO authenticated, service_role;

-- ── clock_out ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.clock_out(_at timestamptz DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _staff_id uuid;
  _open uuid;
  _in timestamptz;
  _when timestamptz := now();
  _source text := 'tech_live';
BEGIN
  IF _uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to clock out';
  END IF;

  SELECT s.id INTO _staff_id
    FROM public.staff s
    JOIN public.user_roles ur ON ur.user_id = s.user_id AND ur.organization_id = s.organization_id
   WHERE s.user_id = _uid AND s.active
   ORDER BY s.created_at
   LIMIT 1
   FOR UPDATE OF s;
  IF _staff_id IS NULL THEN
    RAISE EXCEPTION 'Only an active member of the team can clock out';
  END IF;

  SELECT id, clock_in INTO _open, _in
    FROM public.time_entries
   WHERE staff_id = _staff_id AND clock_out IS NULL
   FOR UPDATE;
  -- Nothing running: the live tap already closed it, or the office did.
  IF _open IS NULL THEN
    RETURN NULL;
  END IF;

  IF _at IS NOT NULL THEN
    IF _at <= now() AND _at >= now() - interval '7 days' AND _at > _in THEN
      _when := _at;
    END IF;
    _source := 'tech_offline_replay';
  END IF;
  -- now() is the transaction's start, and a shift opened by a replay can in
  -- principle carry the same instant. A zero-length shift violates the CHECK;
  -- a one-second one is the honest nearest thing.
  IF _when <= _in THEN
    _when := _in + interval '1 second';
  END IF;

  UPDATE public.time_entries
     SET clock_out = _when, clock_out_source = _source, updated_at = now()
   WHERE id = _open;
  RETURN _open;
END;
$function$;

REVOKE ALL ON FUNCTION public.clock_out(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.clock_out(timestamptz) TO authenticated, service_role;

-- ── the office's corrections ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.office_edit_time_entry(
  _id uuid,
  _clock_in timestamptz,
  _clock_out timestamptz,
  _note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _e public.time_entries%ROWTYPE;
  _clash timestamptz;
BEGIN
  SELECT * INTO _e FROM public.time_entries WHERE id = _id FOR UPDATE;
  IF _e.id IS NULL THEN
    RAISE EXCEPTION 'Time entry not found';
  END IF;
  IF _uid IS NULL OR NOT public.has_permission(_uid, _e.organization_id, 'manage_users') THEN
    RAISE EXCEPTION 'Not authorized to change time entries';
  END IF;

  IF _clock_in IS NULL THEN
    RAISE EXCEPTION 'A time entry needs a clock-in time';
  END IF;
  IF _clock_out IS NULL AND _e.clock_out IS NOT NULL THEN
    RAISE EXCEPTION 'A finished shift needs a clock-out time';
  END IF;
  IF _clock_out IS NOT NULL AND _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'The clock-out must be after the clock-in';
  END IF;
  -- Five minutes of grace: "now" in the office's form is the office's
  -- clock, which is not the database's, and a forgotten clock-out closed "at
  -- now" should not be refused over a laptop running a few seconds fast.
  IF _clock_in > now() + interval '5 minutes' OR _clock_out > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A time entry cannot end in the future';
  END IF;

  SELECT clock_in INTO _clash
    FROM public.time_entries t
   WHERE t.staff_id = _e.staff_id
     AND t.id <> _e.id
     AND tstzrange(t.clock_in, COALESCE(t.clock_out, 'infinity'::timestamptz))
         && tstzrange(_clock_in, COALESCE(_clock_out, 'infinity'::timestamptz))
   LIMIT 1;
  IF _clash IS NOT NULL THEN
    -- No timestamp in the message: it would print in UTC, and the office
    -- reads its day on the org's clock. The timesheet shows the other shift.
    RAISE EXCEPTION 'That overlaps another shift for the same person. Fix or shorten that one first.';
  END IF;

  UPDATE public.time_entries
     SET clock_in = _clock_in,
         clock_out = _clock_out,
         clock_in_source = CASE WHEN _clock_in IS DISTINCT FROM _e.clock_in
                                THEN 'office' ELSE clock_in_source END,
         clock_out_source = CASE WHEN _clock_out IS DISTINCT FROM _e.clock_out
                                 THEN 'office' ELSE clock_out_source END,
         note = left(NULLIF(btrim(COALESCE(_note, '')), ''), 500),
         edited_by = _uid,
         edited_at = now(),
         updated_at = now()
   WHERE id = _e.id;
  RETURN _e.id;
END;
$function$;

REVOKE ALL ON FUNCTION public.office_edit_time_entry(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_edit_time_entry(uuid, timestamptz, timestamptz, text)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.office_add_time_entry(
  _staff_id uuid,
  _clock_in timestamptz,
  _clock_out timestamptz,
  _note text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _org_id uuid;
  _clash timestamptz;
  _id uuid;
BEGIN
  SELECT organization_id INTO _org_id FROM public.staff WHERE id = _staff_id;
  IF _org_id IS NULL THEN
    RAISE EXCEPTION 'Staff member not found';
  END IF;
  -- The permission is asked of the STAFF MEMBER's org, so a manager of one
  -- org cannot add hours to a person in another.
  IF _uid IS NULL OR NOT public.has_permission(_uid, _org_id, 'manage_users') THEN
    RAISE EXCEPTION 'Not authorized to add time entries';
  END IF;

  IF _clock_in IS NULL OR _clock_out IS NULL THEN
    RAISE EXCEPTION 'A missed day needs both a clock-in and a clock-out time';
  END IF;
  IF _clock_out <= _clock_in THEN
    RAISE EXCEPTION 'The clock-out must be after the clock-in';
  END IF;
  IF _clock_out > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'A time entry cannot end in the future';
  END IF;

  SELECT clock_in INTO _clash
    FROM public.time_entries t
   WHERE t.staff_id = _staff_id
     AND tstzrange(t.clock_in, COALESCE(t.clock_out, 'infinity'::timestamptz))
         && tstzrange(_clock_in, _clock_out)
   LIMIT 1;
  IF _clash IS NOT NULL THEN
    -- No timestamp in the message: it would print in UTC, and the office
    -- reads its day on the org's clock. The timesheet shows the other shift.
    RAISE EXCEPTION 'That overlaps another shift for the same person. Fix or shorten that one first.';
  END IF;

  INSERT INTO public.time_entries (
    organization_id, staff_id, clock_in, clock_out, clock_in_source, clock_out_source,
    note, edited_by, edited_at
  ) VALUES (
    _org_id, _staff_id, _clock_in, _clock_out, 'office', 'office',
    left(NULLIF(btrim(COALESCE(_note, '')), ''), 500), _uid, now()
  )
  RETURNING id INTO _id;
  RETURN _id;
END;
$function$;

REVOKE ALL ON FUNCTION public.office_add_time_entry(uuid, timestamptz, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_add_time_entry(uuid, timestamptz, timestamptz, text)
  TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE
  _fn text;
  _fk record;
BEGIN
  IF to_regclass('public.time_entries') IS NULL THEN
    RAISE EXCEPTION 'public.time_entries was not created';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.time_entries'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on public.time_entries';
  END IF;

  -- The index the idempotency of clock_in rests on: unique, on staff_id,
  -- and partial on the open shift only.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
     WHERE i.indrelid = 'public.time_entries'::regclass
       AND c.relname = 'time_entries_one_open_per_staff'
       AND i.indisunique
       AND i.indisvalid
       AND i.indnatts = 1
       AND i.indkey[0] = (SELECT attnum FROM pg_attribute
                           WHERE attrelid = 'public.time_entries'::regclass AND attname = 'staff_id')
       AND pg_get_expr(i.indpred, i.indrelid) ~* 'clock_out IS NULL'
  ) THEN
    RAISE EXCEPTION 'time_entries has no valid unique index allowing one open shift per staff member';
  END IF;

  -- Reads only. A write policy would let a tech edit their own hours.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'time_entries' AND cmd <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'time_entries has a write policy; every write goes through a function';
  END IF;
  IF has_table_privilege('authenticated', 'public.time_entries', 'INSERT')
     OR has_table_privilege('authenticated', 'public.time_entries', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.time_entries', 'DELETE') THEN
    RAISE EXCEPTION 'authenticated can write public.time_entries directly';
  END IF;
  IF has_table_privilege('anon', 'public.time_entries', 'SELECT') THEN
    RAISE EXCEPTION 'anon can read public.time_entries';
  END IF;

  -- Every foreign key has an index that leads with its column.
  FOR _fk IN
    SELECT con.conname, con.conkey[1] AS attnum
      FROM pg_constraint con
     WHERE con.conrelid = 'public.time_entries'::regclass AND con.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.time_entries'::regclass
         AND i.indkey[0] = _fk.attnum
    ) THEN
      RAISE EXCEPTION 'foreign key % on time_entries has no index', _fk.conname;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.clock_in(timestamptz)',
    'public.clock_out(timestamptz)',
    'public.office_edit_time_entry(uuid, timestamptz, timestamptz, text)',
    'public.office_add_time_entry(uuid, timestamptz, timestamptz, text)'
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'anon can execute %', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'authenticated cannot execute %, and the app calls it as authenticated', _fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn::regprocedure) THEN
      RAISE EXCEPTION '% is not SECURITY DEFINER, so it cannot write a table the caller cannot', _fn;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc, unnest(proconfig) AS cfg
       WHERE oid = _fn::regprocedure AND cfg LIKE 'search_path=%'
    ) THEN
      RAISE EXCEPTION '% has no fixed search_path', _fn;
    END IF;
  END LOOP;
END
$check$;
