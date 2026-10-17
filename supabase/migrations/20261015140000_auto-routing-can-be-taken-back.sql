-- Auto-routing can be taken back (#435, QA row 17).
--
-- Apply rewrites every selected technician's day across the whole range:
-- who has each stop, the order, and every arrival time. On 2026-08-19 the
-- owner asked for the preview to go ("let's just have apply"), so there is no
-- step before the write, and until this there was nothing after it either: a
-- dispatcher who picked the wrong range or the wrong people had to put a
-- week back by hand.
--
-- The owner's choice stands. Instead of a preview, the run keeps what it
-- replaced, and the one who can route the business can put it back:
--
--   routing_run_undo         one row per visit the run could touch: its
--                            technician, order and times BEFORE the write,
--                            and the same three AFTER it.
--
--   capture_routing_run_undo(run)
--                            called by the run immediately before
--                            apply_route_plans. Records the before half for
--                            every scheduled visit in the run's days that is
--                            unassigned or belongs to someone in the run:
--                            exactly the set apply_route_plan may write.
--   seal_routing_run_undo(run)
--                            called once the write committed. Records the
--                            after half, so "has anything changed since" is
--                            a comparison of values, not of clocks.
--   routing_run_undo_state(run)
--                            whether Undo is still on offer, and what the run
--                            changed: "Moved 14 visits across 3 techs".
--   undo_routing_run(run)    puts every changed visit back: technician,
--                            order, arrival times, drive.
--
-- Undo is on offer for UNDO_MINUTES after the write, and only while nothing
-- it would overwrite has moved since: a visit dragged, reassigned, moved to
-- another day, started, completed or skipped, or a later run applied, and
-- the offer is withdrawn rather than undoing on top of somebody's newer
-- work. After an undo the rows are deleted, so it cannot be pressed twice.
-- Rows older than a day are cleared on the next capture.
--
-- Authorization is the run's own: capture and seal ask for the person who
-- started the run (as apply_route_plans does); the state and the undo ask
-- can_write_org, the gate on every routing write. No role gains anything.
--
-- Replays into an empty database: a table and functions over helpers that
-- exist by this point (routing_runs, can_write_org, require_mfa_policy).
-- Nothing here needs a row; the check at the bottom asserts only what this
-- file establishes.

CREATE TABLE IF NOT EXISTS public.routing_run_undo (
  run_id uuid NOT NULL REFERENCES public.routing_runs(id) ON DELETE CASCADE,
  visit_id uuid NOT NULL REFERENCES public.visits(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  before_staff uuid,
  before_sequence integer,
  before_eta_start timestamptz,
  before_eta_end timestamptz,
  before_travel_km numeric,
  before_travel_min numeric,
  before_window_violated boolean,
  sealed boolean NOT NULL DEFAULT false,
  after_staff uuid,
  after_sequence integer,
  after_eta_start timestamptz,
  after_scheduled_on date,
  after_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, visit_id)
);

COMMENT ON TABLE public.routing_run_undo IS
  'What an auto-routing run replaced, per visit, so it can be undone. Written only by capture_routing_run_undo and seal_routing_run_undo; read only by routing_run_undo_state and undo_routing_run.';

CREATE INDEX IF NOT EXISTS routing_run_undo_org_created
  ON public.routing_run_undo (organization_id, created_at);

ALTER TABLE public.routing_run_undo ENABLE ROW LEVEL SECURITY;
-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.routing_run_undo');

-- No policy for the API roles: every read and write is one of the functions
-- below, which ask first.
REVOKE ALL ON public.routing_run_undo FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.routing_run_undo TO service_role;

-- ── capture ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.capture_routing_run_undo(_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _n integer;
BEGIN
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id;
  IF _run.id IS NULL
     OR _run.started_by IS DISTINCT FROM auth.uid()
     OR NOT public.can_write_org(auth.uid(), _run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;
  IF _run.status NOT IN ('queued', 'running') OR _run.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'This auto-routing run is not about to save.';
  END IF;

  -- Yesterday's offers are long gone; keep the table small.
  DELETE FROM public.routing_run_undo
   WHERE organization_id = _run.organization_id AND created_at < now() - interval '1 day';
  DELETE FROM public.routing_run_undo WHERE run_id = _run_id;

  INSERT INTO public.routing_run_undo (
    run_id, visit_id, organization_id,
    before_staff, before_sequence, before_eta_start, before_eta_end,
    before_travel_km, before_travel_min, before_window_violated)
  SELECT _run_id, v.id, v.organization_id,
         v.assigned_staff_id, v.sequence, v.eta_start, v.eta_end,
         v.travel_km, v.travel_min, v.window_violated
    FROM public.visits v
   WHERE v.organization_id = _run.organization_id
     AND v.scheduled_on BETWEEN _run.from_day AND _run.to_day
     AND v.status = 'scheduled'
     AND (v.assigned_staff_id IS NULL OR v.assigned_staff_id = ANY(_run.staff_ids));
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

-- ── seal ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.seal_routing_run_undo(_run_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _n integer;
BEGIN
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id;
  IF _run.id IS NULL
     OR _run.started_by IS DISTINCT FROM auth.uid()
     OR NOT public.can_write_org(auth.uid(), _run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;
  IF _run.applied_at IS NULL THEN
    -- Nothing was written, so there is nothing to take back.
    DELETE FROM public.routing_run_undo WHERE run_id = _run_id;
    RETURN 0;
  END IF;

  UPDATE public.routing_run_undo u
     SET sealed = true,
         after_staff = v.assigned_staff_id,
         after_sequence = v.sequence,
         after_eta_start = v.eta_start,
         after_scheduled_on = v.scheduled_on,
         after_status = v.status::text
    FROM public.visits v
   WHERE u.run_id = _run_id AND v.id = u.visit_id AND NOT u.sealed;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

-- ── state ────────────────────────────────────────────────────────────────
-- {available, reason, moved, techs, staff_ids, visit_ids, expires_at}
-- `reason` is null when available, else one of 'nothing_saved', 'expired',
-- 'changed_since', 'later_run', 'nothing_changed'.
CREATE OR REPLACE FUNCTION public.routing_run_undo_state(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _undo_minutes constant integer := 15;
  _expires timestamptz;
  _moved integer; _techs integer;
  _staff uuid[]; _vids uuid[];
  _reason text;
BEGIN
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id;
  IF _run.id IS NULL OR NOT public.can_write_org(auth.uid(), _run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;

  _expires := _run.applied_at + make_interval(mins => _undo_minutes);

  -- What the run changed: a different technician or a different place in
  -- the order.
  SELECT count(*)::int, count(DISTINCT u.after_staff)::int, array_agg(u.visit_id)
    INTO _moved, _techs, _vids
    FROM public.routing_run_undo u
   WHERE u.run_id = _run_id AND u.sealed
     AND (u.before_staff IS DISTINCT FROM u.after_staff
          OR u.before_sequence IS DISTINCT FROM u.after_sequence);
  -- Everyone whose day the undo would change: who had the stops, and who has them.
  _staff := ARRAY(
    SELECT DISTINCT s.id
      FROM public.routing_run_undo u
      CROSS JOIN LATERAL (VALUES (u.before_staff), (u.after_staff)) AS s(id)
     WHERE u.run_id = _run_id AND u.sealed AND s.id IS NOT NULL
       AND (u.before_staff IS DISTINCT FROM u.after_staff
            OR u.before_sequence IS DISTINCT FROM u.after_sequence));

  IF _run.applied_at IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.routing_run_undo u WHERE u.run_id = _run_id AND u.sealed) THEN
    _reason := 'nothing_saved';
  ELSIF COALESCE(_moved, 0) = 0 THEN
    _reason := 'nothing_changed';
  ELSIF now() > _expires THEN
    _reason := 'expired';
  ELSIF EXISTS (SELECT 1 FROM public.routing_runs r
                 WHERE r.organization_id = _run.organization_id
                   AND r.id <> _run.id AND r.applied_at > _run.applied_at) THEN
    _reason := 'later_run';
  ELSIF EXISTS (
    SELECT 1 FROM public.routing_run_undo u
      JOIN public.visits v ON v.id = u.visit_id
     WHERE u.run_id = _run_id AND u.sealed
       AND (v.assigned_staff_id IS DISTINCT FROM u.after_staff
            OR v.sequence IS DISTINCT FROM u.after_sequence
            OR v.eta_start IS DISTINCT FROM u.after_eta_start
            OR v.scheduled_on IS DISTINCT FROM u.after_scheduled_on
            OR v.status::text IS DISTINCT FROM u.after_status)) THEN
    _reason := 'changed_since';
  END IF;

  RETURN jsonb_build_object(
    'available', _reason IS NULL,
    'reason', _reason,
    'moved', COALESCE(_moved, 0),
    'techs', COALESCE(_techs, 0),
    'staff_ids', to_jsonb(COALESCE(_staff, '{}'::uuid[])),
    'visit_ids', to_jsonb(COALESCE(_vids, '{}'::uuid[])),
    'expires_at', _expires);
END;
$function$;

-- ── undo ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.undo_routing_run(_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _state jsonb;
  _n integer;
BEGIN
  -- Locked, so two presses of Undo (or Undo and a new run) take turns.
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id FOR UPDATE;
  _state := public.routing_run_undo_state(_run_id);
  IF NOT (_state->>'available')::boolean THEN
    RAISE EXCEPTION '%', CASE _state->>'reason'
      WHEN 'expired' THEN 'Undo is no longer available: it lasts 15 minutes after auto-routing saves.'
      WHEN 'changed_since' THEN 'Undo is no longer available: the schedule has changed since auto-routing saved it.'
      WHEN 'later_run' THEN 'Undo is no longer available: auto-routing has run again since.'
      WHEN 'nothing_changed' THEN 'Auto-routing did not change anything to undo.'
      ELSE 'There is nothing to undo for this auto-routing run.'
    END;
  END IF;

  UPDATE public.visits v
     SET assigned_staff_id = u.before_staff,
         sequence          = u.before_sequence,
         eta_start         = u.before_eta_start,
         eta_end           = u.before_eta_end,
         travel_km         = u.before_travel_km,
         travel_min        = u.before_travel_min,
         window_violated   = COALESCE(u.before_window_violated, false),
         updated_at        = now()
    FROM public.routing_run_undo u
   WHERE u.run_id = _run_id AND u.sealed AND v.id = u.visit_id
     AND (u.before_staff IS DISTINCT FROM u.after_staff
          OR u.before_sequence IS DISTINCT FROM u.after_sequence
          OR u.before_eta_start IS DISTINCT FROM u.after_eta_start);
  GET DIAGNOSTICS _n = ROW_COUNT;

  DELETE FROM public.routing_run_undo WHERE run_id = _run_id;

  RETURN jsonb_build_object('restored', _n, 'staff_ids', _state->'staff_ids',
                            'from_day', _run.from_day, 'to_day', _run.to_day);
END;
$function$;

REVOKE ALL ON FUNCTION public.capture_routing_run_undo(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.seal_routing_run_undo(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.routing_run_undo_state(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.undo_routing_run(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.capture_routing_run_undo(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.seal_routing_run_undo(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.routing_run_undo_state(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.undo_routing_run(uuid) TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────
DO $check$
BEGIN
  IF NOT (SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.routing_run_undo'::regclass) THEN
    RAISE EXCEPTION 'row level security is not enabled on public.routing_run_undo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'routing_run_undo'
                    AND permissive = 'RESTRICTIVE') THEN
    RAISE EXCEPTION 'public.routing_run_undo has no two-step sign-in policy';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'routing_run_undo'
                AND permissive = 'PERMISSIVE') THEN
    RAISE EXCEPTION 'public.routing_run_undo should be reached only through its functions';
  END IF;
  IF has_table_privilege('authenticated', 'public.routing_run_undo', 'SELECT')
     OR has_table_privilege('anon', 'public.routing_run_undo', 'SELECT') THEN
    RAISE EXCEPTION 'the API roles must not read public.routing_run_undo directly';
  END IF;
  IF has_function_privilege('anon', 'public.undo_routing_run(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must not undo a routing run';
  END IF;
END
$check$;
