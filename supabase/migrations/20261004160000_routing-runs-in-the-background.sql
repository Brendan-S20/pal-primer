-- Auto-routing can run in the background.
--
-- The owner, 2026-10-04: "When utilizing the auto-routing and it takes a
-- while, allow it to be dismissed to run in a background."
--
-- Until this, a run was one HTTP request (applyOptimize) that read, solved and
-- WROTE each day in turn, and nothing recorded that it was happening. Three
-- things followed from that, and only the first was the complaint:
--
--   * the panel had to stay open, with a disabled Cancel, for as long as the
--     request took -- seconds on a warm day, much longer on a cold road-time
--     cache or a busy public router;
--   * closing the app mid-run cancelled the request on the Worker, and a
--     multi-day run that was cut off had already written the days before the
--     cut and none after: half a week routed, and nobody told which half;
--   * there was no row to come back to, so a person who left could not find
--     out what had happened except by reading the board.
--
-- This adds the row, and moves the write to the END of the run so that it is
-- one transaction:
--
--   routing_runs        one per press: who, which org, which days, which
--                       people, the stage it has reached, and the result or
--                       the error. The panel and the header indicator poll it.
--
--   start_routing_run   records a run, or ATTACHES to the organization's
--                       active one. A partial unique index allows one active
--                       run per organization, so two presses (or two people)
--                       cannot plan the same days at once and race each
--                       other's writes. A run whose heartbeat stopped more
--                       than three minutes ago is declared abandoned first,
--                       so a Worker that died does not block the next press.
--
--   routing_run_progress  the heartbeat: the stage (road times, optimizing,
--                       saving) and how many days are done.
--
--   apply_route_plans   the write, for the whole run, in one transaction: it
--                       calls apply_route_plan once per day. A day that
--                       apply_route_plan refuses ("the day changed while it
--                       was being planned") is rolled back on its own and
--                       reported, exactly as a refused day was before; every
--                       other day commits together, and the run is stamped
--                       applied in the same transaction. A run that dies
--                       before this statement has written nothing. A run that
--                       was already declared abandoned is refused, so a slow
--                       Worker cannot write a plan after its owner was told
--                       nothing changed.
--
--   finish_routing_run  succeeded or failed, with the result. Succeeded
--                       requires applied_at: a run that says it routed the
--                       day is one whose write committed.
--
--   my_routing_runs     what the indicator polls: this person's active runs
--                       and the finished ones they have not looked at yet.
--                       It stamps watched_at while the person is on the page,
--                       which is how the server decides whether to push.
--
--   routing_run_seen    the person looked at the result.
--
-- Every write is one of these functions. The table is read-only to the API,
-- and each function asks can_write_org first -- the same gate route_day_inputs
-- and apply_route_plan already ask, because a run IS those two calls.
--
-- Replays into an empty database: a table and functions over helpers that
-- exist by this point (can_write_org, require_mfa_policy, apply_route_plan).
-- Nothing here needs a row, and the check at the bottom asserts only what this
-- file establishes.

CREATE TABLE IF NOT EXISTS public.routing_runs (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- auth.users.id of whoever pressed Apply. The push goes to them, and only
  -- they can move the run forward.
  started_by uuid NOT NULL,
  from_day date NOT NULL,
  to_day date NOT NULL,
  staff_ids uuid[] NOT NULL,
  windows text NOT NULL DEFAULT 'org',
  status text NOT NULL DEFAULT 'queued',
  stage text,
  days_total integer NOT NULL DEFAULT 1,
  days_done integer NOT NULL DEFAULT 0,
  result jsonb,
  error text,
  -- Set by apply_route_plans in the same transaction as the write.
  applied_at timestamptz,
  -- Last time the person who started it was looking at /routes. See
  -- my_routing_runs; the push is skipped for someone who is watching.
  watched_at timestamptz,
  seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The heartbeat. Only the run itself moves it.
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT routing_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  CONSTRAINT routing_runs_stage_check
    CHECK (stage IS NULL OR stage IN ('road_times', 'optimizing', 'saving')),
  CONSTRAINT routing_runs_windows_check CHECK (windows IN ('org', 'honour', 'ignore')),
  CONSTRAINT routing_runs_range_check CHECK (to_day >= from_day AND to_day - from_day <= 92),
  CONSTRAINT routing_runs_staff_check
    CHECK (cardinality(staff_ids) BETWEEN 1 AND 50),
  CONSTRAINT routing_runs_days_check
    CHECK (days_total BETWEEN 1 AND 93 AND days_done BETWEEN 0 AND days_total),
  CONSTRAINT routing_runs_finished_check
    CHECK ((status IN ('succeeded', 'failed')) = (finished_at IS NOT NULL)),
  CONSTRAINT routing_runs_succeeded_means_saved_check
    CHECK (status <> 'succeeded' OR applied_at IS NOT NULL),
  CONSTRAINT routing_runs_error_length CHECK (error IS NULL OR char_length(error) <= 2000)
);

COMMENT ON TABLE public.routing_runs IS
  'One auto-routing press. Written only through start_routing_run, routing_run_progress, apply_route_plans, finish_routing_run, my_routing_runs and routing_run_seen; the whole run''s write is one transaction (apply_route_plans).';

-- One active run per organization. Not per date range: two ranges that
-- overlap would write the same visits, and two that do not are not something
-- a one-or-two-truck business presses at once.
CREATE UNIQUE INDEX IF NOT EXISTS routing_runs_one_active_per_org
  ON public.routing_runs (organization_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS routing_runs_org_created
  ON public.routing_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS routing_runs_started_by_created
  ON public.routing_runs (started_by, created_at DESC);

ALTER TABLE public.routing_runs ENABLE ROW LEVEL SECURITY;

-- Two-step sign-in, like every RLS table (20261002010000_a-password-was-the-only-lock).
SELECT public.require_mfa_policy('public.routing_runs');

REVOKE ALL ON public.routing_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.routing_runs TO authenticated;
GRANT ALL ON public.routing_runs TO service_role;

-- Whoever can route the organization can see its runs: the active one is what
-- their own press would attach to.
DROP POLICY IF EXISTS "routing runs: whoever can route the org (select)" ON public.routing_runs;
CREATE POLICY "routing runs: whoever can route the org (select)" ON public.routing_runs
  FOR SELECT TO authenticated
  USING (public.can_write_org((SELECT auth.uid()), organization_id));

-- ── start ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.start_routing_run(
  _id uuid, _org_id uuid, _from date, _to date, _staff_ids uuid[], _windows text DEFAULT 'org')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
  _n integer;
  _row public.routing_runs;
BEGIN
  IF _uid IS NULL OR NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;
  IF _id IS NULL THEN
    RAISE EXCEPTION 'A run needs an id';
  END IF;
  IF _from IS NULL OR _to IS NULL OR _to < _from THEN
    RAISE EXCEPTION 'The end date is before the start date.';
  END IF;
  IF _to - _from > 92 THEN
    RAISE EXCEPTION 'Route at most 92 days at a time.';
  END IF;
  IF COALESCE(cardinality(_staff_ids), 0) = 0 THEN
    RAISE EXCEPTION 'Select at least one technician to route';
  END IF;

  -- A run whose heartbeat stopped is not running, whatever its row says: the
  -- Worker that held it is gone. Declared so here, before the insert, or the
  -- unique index would keep refusing this organization forever.
  UPDATE public.routing_runs
     SET status = 'failed', stage = NULL, error = 'abandoned',
         finished_at = now(), updated_at = now()
   WHERE organization_id = _org_id
     AND status IN ('queued', 'running')
     AND updated_at < now() - interval '3 minutes';

  INSERT INTO public.routing_runs
    (id, organization_id, started_by, from_day, to_day, staff_ids, windows, status, days_total)
  VALUES
    (_id, _org_id, _uid, _from, _to, _staff_ids, COALESCE(_windows, 'org'), 'queued', (_to - _from) + 1)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS _n = ROW_COUNT;
  IF _n = 1 THEN
    RETURN jsonb_build_object('run_id', _id, 'attached', false);
  END IF;

  -- Somebody's run is active (the unique index), or this id was used before
  -- (a retried press). Either way the caller attaches rather than starting a
  -- second planner over the same visits.
  SELECT * INTO _row FROM public.routing_runs
   WHERE organization_id = _org_id AND status IN ('queued', 'running')
   LIMIT 1;
  IF _row.id IS NULL THEN
    SELECT * INTO _row FROM public.routing_runs WHERE id = _id AND organization_id = _org_id;
  END IF;
  IF _row.id IS NULL THEN
    RAISE EXCEPTION 'That run id belongs to another organization' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'run_id', _row.id, 'attached', true,
    'from_day', _row.from_day, 'to_day', _row.to_day,
    'mine', _row.started_by = _uid);
END;
$function$;

REVOKE ALL ON FUNCTION public.start_routing_run(uuid, uuid, date, date, uuid[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_routing_run(uuid, uuid, date, date, uuid[], text) TO authenticated, service_role;

-- ── progress ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.routing_run_progress(_id uuid, _stage text, _days_done integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- False when the run is no longer the caller's to move: finished, declared
  -- abandoned, already saved, or not theirs. The job stops on false.
  UPDATE public.routing_runs r
     SET status = 'running', stage = _stage,
         days_done = LEAST(GREATEST(COALESCE(_days_done, 0), 0), r.days_total),
         updated_at = now()
   WHERE r.id = _id
     AND r.status IN ('queued', 'running')
     AND r.applied_at IS NULL
     AND r.started_by = auth.uid()
     AND public.can_write_org(auth.uid(), r.organization_id);
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.routing_run_progress(uuid, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.routing_run_progress(uuid, text, integer) TO authenticated, service_role;

-- ── the write, for the whole run ────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.apply_route_plans(_run_id uuid, _reassign boolean, _plans jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _run public.routing_runs;
  _p jsonb;
  _day date;
  _r jsonb;
  _out jsonb := '[]'::jsonb;
BEGIN
  -- Locked, so a concurrent abandon (start_routing_run's sweep) waits for
  -- this transaction or this one waits for it -- never both.
  SELECT * INTO _run FROM public.routing_runs WHERE id = _run_id FOR UPDATE;
  IF _run.id IS NULL
     OR _run.started_by IS DISTINCT FROM auth.uid()
     OR NOT public.can_write_org(auth.uid(), _run.organization_id) THEN
    RAISE EXCEPTION 'Not authorized to plan routes for this organization' USING ERRCODE = '42501';
  END IF;
  IF _run.status NOT IN ('queued', 'running') THEN
    RAISE EXCEPTION 'This auto-routing run already ended (%), so its plan was not saved.', _run.status;
  END IF;
  IF _run.applied_at IS NOT NULL THEN
    RAISE EXCEPTION 'This auto-routing run was already saved.';
  END IF;
  IF _plans IS NULL OR jsonb_typeof(_plans) <> 'array' THEN
    RAISE EXCEPTION 'A run''s plan is a list of days';
  END IF;
  IF EXISTS (
       SELECT 1 FROM jsonb_array_elements(_plans) e
        GROUP BY e->>'day' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'The plan has the same day twice';
  END IF;

  FOR _p IN SELECT value FROM jsonb_array_elements(_plans) LOOP
    _day := (_p->>'day')::date;
    IF _day IS NULL OR _day < _run.from_day OR _day > _run.to_day THEN
      RAISE EXCEPTION 'The plan has a day outside the run: %', _p->>'day';
    END IF;
    -- Its own subtransaction: a day apply_route_plan refuses is undone on its
    -- own and reported, and the others still commit, which is what a refused
    -- day has always meant. A statement timeout is NOT caught here (it is not
    -- in OTHERS), so a run too big to save aborts whole, writing nothing.
    BEGIN
      _r := public.apply_route_plan(
        _run.organization_id, _run.staff_ids, _day, COALESCE(_reassign, false),
        _p->'routes', COALESCE((_p->>'honour_windows')::boolean, true));
      _out := _out || jsonb_build_array(jsonb_build_object('day', _day, 'ok', true, 'result', _r));
    EXCEPTION WHEN OTHERS THEN
      _out := _out || jsonb_build_array(jsonb_build_object('day', _day, 'ok', false, 'error', SQLERRM));
    END;
  END LOOP;

  UPDATE public.routing_runs
     SET applied_at = now(), status = 'running', stage = 'saving', updated_at = now()
   WHERE id = _run_id;

  RETURN _out;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_route_plans(uuid, boolean, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_route_plans(uuid, boolean, jsonb) TO authenticated, service_role;

-- ── finish ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.finish_routing_run(
  _id uuid, _status text, _result jsonb DEFAULT NULL, _error text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _row public.routing_runs;
BEGIN
  IF _status NOT IN ('succeeded', 'failed') THEN
    RAISE EXCEPTION 'A run finishes as succeeded or failed, not %', _status;
  END IF;
  UPDATE public.routing_runs r
     SET status = _status, stage = NULL, result = _result,
         error = left(_error, 2000), finished_at = now(), updated_at = now()
   WHERE r.id = _id
     AND r.status IN ('queued', 'running')
     AND r.started_by = auth.uid()
     AND public.can_write_org(auth.uid(), r.organization_id)
  RETURNING r.* INTO _row;
  RETURN jsonb_build_object(
    'finished', _row.id IS NOT NULL,
    'watched_at', _row.watched_at,
    'applied_at', _row.applied_at);
END;
$function$;

REVOKE ALL ON FUNCTION public.finish_routing_run(uuid, text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_routing_run(uuid, text, jsonb, text) TO authenticated, service_role;

-- ── what the indicator reads ────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.my_routing_runs(_watching boolean DEFAULT false, _also uuid[] DEFAULT '{}')
RETURNS SETOF public.routing_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _uid uuid := auth.uid();
BEGIN
  IF _uid IS NULL THEN
    RETURN;
  END IF;

  -- The same abandonment rule start_routing_run applies, for this person's
  -- own runs, so the indicator stops spinning for a Worker that is gone.
  UPDATE public.routing_runs
     SET status = 'failed', stage = NULL, error = 'abandoned',
         finished_at = now(), updated_at = now()
   WHERE started_by = _uid
     AND status IN ('queued', 'running')
     AND updated_at < now() - interval '3 minutes';

  IF COALESCE(_watching, false) THEN
    UPDATE public.routing_runs
       SET watched_at = now()
     WHERE started_by = _uid AND status IN ('queued', 'running');
  END IF;

  RETURN QUERY
    SELECT r.* FROM public.routing_runs r
     WHERE r.created_at > now() - interval '1 day'
       AND public.can_write_org(_uid, r.organization_id)
       AND (
         (r.started_by = _uid AND (r.status IN ('queued', 'running') OR r.seen_at IS NULL))
         -- A run this person attached to (somebody else's press), while it
         -- is running and until it has been looked at.
         OR (r.id = ANY(COALESCE(_also, '{}')) AND (r.status IN ('queued', 'running') OR r.seen_at IS NULL))
       )
     ORDER BY r.created_at DESC
     LIMIT 5;
END;
$function$;

REVOKE ALL ON FUNCTION public.my_routing_runs(boolean, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_routing_runs(boolean, uuid[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.routing_run_seen(_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The starter's to clear. Somebody who attached to the run drops it from
  -- their own list instead, so their look does not hide it from the person
  -- who pressed Apply.
  UPDATE public.routing_runs r
     SET seen_at = now()
   WHERE r.id = _id
     AND r.status IN ('succeeded', 'failed')
     AND r.seen_at IS NULL
     AND r.started_by = auth.uid()
     AND public.can_write_org(auth.uid(), r.organization_id);
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.routing_run_seen(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.routing_run_seen(uuid) TO authenticated, service_role;

-- ── What this file establishes ──────────────────────────────────────────────

DO $check$
DECLARE
  _fn regprocedure;
  _fk record;
BEGIN
  IF to_regclass('public.routing_runs') IS NULL THEN
    RAISE EXCEPTION 'routing_runs was not created';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.routing_runs'::regclass) THEN
    RAISE EXCEPTION 'RLS is not enabled on routing_runs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'routing_runs' AND permissive = 'RESTRICTIVE'
  ) THEN
    RAISE EXCEPTION 'routing_runs has no two-step sign-in policy';
  END IF;
  IF has_table_privilege('anon', 'public.routing_runs', 'SELECT')
     OR has_table_privilege('anon', 'public.routing_runs', 'INSERT') THEN
    RAISE EXCEPTION 'anon holds a privilege on routing_runs';
  END IF;
  IF has_table_privilege('authenticated', 'public.routing_runs', 'INSERT')
     OR has_table_privilege('authenticated', 'public.routing_runs', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.routing_runs', 'DELETE')
     OR has_table_privilege('authenticated', 'public.routing_runs', 'TRUNCATE') THEN
    RAISE EXCEPTION 'authenticated can write routing_runs directly, past its functions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'routing_runs' AND cmd <> 'SELECT'
       AND permissive = 'PERMISSIVE'  -- the two-step policy is restrictive: it grants nothing
  ) THEN
    RAISE EXCEPTION 'routing_runs has a write policy; every write is a function';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'routing_runs_one_active_per_org'
       AND indexdef ILIKE '%UNIQUE%(organization_id)%WHERE%'
  ) THEN
    RAISE EXCEPTION 'routing_runs allows two active runs per organization';
  END IF;

  FOR _fk IN
    SELECT c.conname, c.conkey FROM pg_constraint c
     WHERE c.conrelid = 'public.routing_runs'::regclass AND c.contype = 'f'
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_index i
       WHERE i.indrelid = 'public.routing_runs'::regclass
         AND i.indkey[0] = _fk.conkey[1]
         AND i.indpred IS NULL
    ) THEN
      RAISE EXCEPTION 'foreign key % on routing_runs has no index', _fk.conname;
    END IF;
  END LOOP;

  FOREACH _fn IN ARRAY ARRAY[
    'public.start_routing_run(uuid, uuid, date, date, uuid[], text)'::regprocedure,
    'public.routing_run_progress(uuid, text, integer)'::regprocedure,
    'public.apply_route_plans(uuid, boolean, jsonb)'::regprocedure,
    'public.finish_routing_run(uuid, text, jsonb, text)'::regprocedure,
    'public.my_routing_runs(boolean, uuid[])'::regprocedure,
    'public.routing_run_seen(uuid)'::regprocedure
  ] LOOP
    IF has_function_privilege('anon', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is executable with the publishable key', _fn;
    END IF;
    IF NOT has_function_privilege('authenticated', _fn, 'EXECUTE') THEN
      RAISE EXCEPTION '% is not callable by a signed-in dispatcher', _fn;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = _fn) THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER: routing_runs is closed to its caller', _fn;
    END IF;
    IF strpos((SELECT prosrc FROM pg_proc WHERE oid = _fn), 'can_write_org(') = 0 THEN
      RAISE EXCEPTION '% does not ask can_write_org', _fn;
    END IF;
  END LOOP;

  -- The run's write is apply_route_plan, called, not reimplemented.
  IF strpos((SELECT prosrc FROM pg_proc WHERE oid = 'public.apply_route_plans(uuid, boolean, jsonb)'::regprocedure),
            'public.apply_route_plan(') = 0 THEN
    RAISE EXCEPTION 'apply_route_plans must write through apply_route_plan';
  END IF;
END
$check$;
