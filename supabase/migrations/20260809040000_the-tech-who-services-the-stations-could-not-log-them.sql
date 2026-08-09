-- The only person who services a waste station could not record having done it.
--
-- `log_station_service` (20260701230120) guards with
-- `can_write_org(auth.uid(), _org)`, and `can_write_org` is
-- `role IN ('owner','office_manager','dispatcher')`. A `tech` is none of those.
--
-- The button that calls it is on the tech's own screen. `StationsSubpanel` in
-- routes/_authenticated/my-day.tsx renders for any visit whose property is
-- commercial or has units, and RoleGuard sends every `tech` to /my-day on sign
-- in. So the flow is: the tech drives to the apartment complex, empties five
-- stations, counts the bags, taps Save, and gets a red toast reading
-- "forbidden" — five times, once per station, with no way forward.
--
-- Probed against the live database before this was written, because a guard
-- three functions deep is exactly the kind of claim that turns out to be
-- wrong. Impersonating a real tech assigned to a real visit at a property with
-- real stations: REFUSED forbidden. The same call as that org's owner:
-- ALLOWED. The report was accurate.
--
-- What that costs is not a UI annoyance. Station service logs ARE the
-- proof-of-service record for commercial accounts — an HOA that disputes a
-- month of invoices is answered with bag counts and liner replacements per
-- station per visit, or it is not answered at all. `record_visit_station_service`
-- does write a row per station on completion, which is why "Last serviced"
-- looked populated and hid this for so long, but those rows are blank: bags 0,
-- liner false, no notes. They prove somebody completed a visit, not that
-- anybody emptied anything.
--
-- ── WHY NOT WIDEN can_write_org ───────────────────────────────────────────
--
-- Because it is the write guard for most of this schema and for the RLS
-- policies on dozens of tables. Adding 'tech' to it would hand every field
-- tech the ability to write pricing, invoices, subscriptions and client
-- records org-wide. The defect here is not that techs cannot write — it is
-- that this function asks the wrong question. It asks "may this person
-- administer the organization" when what it needs to know is "is this person
-- the one out there doing this visit".
--
-- The second question already has an answer, and it is the one the rest of the
-- field path uses: `is_visit_tech(_user_id, _visit_id)`, which joins
-- visits → staff on assigned_staff_id. start_visit and skip_visit authorize on
-- it alone. So the guard becomes org-writer OR the assigned tech FOR THIS
-- VISIT — a tech gains nothing beyond the stations on the property they were
-- dispatched to today, and only for the visit they were dispatched on.
--
-- ── AND WHY THE SIGNATURE CHANGES IN THE SAME MIGRATION ───────────────────
--
-- Station logging is about to join the offline queue, and a queued action is
-- replayed whenever signal returns. `serviced_at` was hardcoded to `now()` in
-- both halves of the upsert, so a log queued at 9:15am in a basement garage
-- and replayed at 4pm would record 4pm. For a proof-of-service record that is
-- worse than having none: it is a confident, specific, wrong answer to the
-- exact question the record exists to settle.
--
-- `_serviced_at` carries when the tech actually did the work, bounded exactly
-- as `skip_visit` bounds `_skipped_at` (20260804110000) — a device clock is a
-- hint, never a safeguard, and anything outside the window silently falls back
-- to `now()` rather than failing, because the service itself really happened
-- either way. Defaulted to NULL so every existing caller, all of which pass
-- seven arguments and none of which knows about this one, is unaffected.
--
-- The 7-argument signature is DROPPED rather than left beside the new one, for
-- the reason the skip_visit re-signing gives: Postgres overloads on the
-- argument list, and PostgREST resolving an RPC by named arguments would find
-- both candidates ambiguous the moment the new parameter has a default. Every
-- online station log makes exactly that call.
--
-- ── IDEMPOTENCY, RESTATED BECAUSE THE QUEUE DEPENDS ON IT ─────────────────
--
-- `runOrQueue` (lib/offline/run-or-queue.ts) queues on timeout WITHOUT
-- cancelling the request that timed out, so a station log can land twice: once
-- from the original request and once from the replay. That is only safe if the
-- second one is harmless.
--
-- It is, and it still is after this migration. The upsert targets the UNIQUE
-- (visit_id, waste_station_id) constraint and ON CONFLICT DO UPDATE writes the
-- same values again — the payload is the tech's counts for one station on one
-- visit, not an increment, so applying it twice yields the same row. The
-- constraint was verified present on the live table before this was written.
-- `serviced_at` now moves toward the value the caller passed rather than to
-- whenever the duplicate arrived, which makes the second landing MORE
-- faithful, not less: the replay carries the real time and the racing online
-- request carries none, so whichever lands last, the row ends up holding a
-- time the tech was actually on site.

DO $pre$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'log_station_service'
     -- Types only: pg_get_function_identity_arguments prints the parameter
     -- names alongside them, so matching it against a bare type list never
     -- succeeds and the assertion would fire on a database that is fine.
     AND ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t)
         = ARRAY['uuid','uuid','integer','boolean','integer','text','text'];
  IF _def IS NULL THEN
    RAISE EXCEPTION 'log_station_service does not have the 7-argument signature this migration replaces';
  END IF;

  -- The defect itself. If the guard has already been changed, the reasoning
  -- above was written against a database that no longer exists.
  IF _def NOT LIKE '%can_write_org(auth.uid(), _org)%' THEN
    RAISE EXCEPTION 'log_station_service no longer guards on can_write_org alone; re-check before applying';
  END IF;
  IF _def LIKE '%is_visit_tech%' THEN
    RAISE EXCEPTION 'log_station_service already consults is_visit_tech';
  END IF;

  -- can_write_org excluding techs is the whole reason this is a bug, and it is
  -- also the thing this migration deliberately does NOT change.
  IF pg_get_functiondef('public.can_write_org(uuid,uuid)'::regprocedure) LIKE '%''tech''%' THEN
    RAISE EXCEPTION 'can_write_org already includes tech; this migration would be widening nothing';
  END IF;

  -- The upsert's conflict target, which is what makes a double-landing safe.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.station_service_logs'::regclass
       AND contype = 'u'
       AND pg_get_constraintdef(oid) = 'UNIQUE (visit_id, waste_station_id)'
  ) THEN
    RAISE EXCEPTION 'the (visit_id, waste_station_id) unique constraint is gone; the upsert is no longer idempotent';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.log_station_service(
  _visit_id uuid,
  _waste_station_id uuid,
  _bags_collected integer DEFAULT 0,
  _liner_replaced boolean DEFAULT false,
  _refill_bags_added integer DEFAULT 0,
  _notes text DEFAULT NULL::text,
  _photo_url text DEFAULT NULL::text,
  _serviced_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE _org UUID; _id UUID; _when timestamptz := now();
BEGIN
  SELECT organization_id INTO _org FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'visit not found'; END IF;

  -- Office staff for any visit in their org; the assigned tech for theirs, and
  -- nothing else. Widening can_write_org would have granted every tech write
  -- access to pricing and invoices across the whole organization.
  IF NOT (public.can_write_org(auth.uid(), _org)
          OR public.is_visit_tech(auth.uid(), _visit_id)) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  -- A phone in a basement is the reason this parameter exists, and a phone's
  -- clock is the reason it is bounded. Out-of-range falls back to now() rather
  -- than raising: the work was done, and refusing to record it because the
  -- device thinks it is 2019 would lose the very thing being protected.
  IF _serviced_at IS NOT NULL
     AND _serviced_at <= now()
     AND _serviced_at >= now() - interval '7 days'
  THEN
    _when := _serviced_at;
  END IF;

  INSERT INTO public.station_service_logs(
    organization_id, visit_id, waste_station_id, bags_collected, liner_replaced, refill_bags_added, notes, photo_url, serviced_at
  ) VALUES (_org, _visit_id, _waste_station_id, _bags_collected, _liner_replaced, _refill_bags_added, _notes, _photo_url, _when)
  ON CONFLICT (visit_id, waste_station_id) DO UPDATE
    SET bags_collected = EXCLUDED.bags_collected,
        liner_replaced = EXCLUDED.liner_replaced,
        refill_bags_added = EXCLUDED.refill_bags_added,
        notes = EXCLUDED.notes,
        photo_url = COALESCE(EXCLUDED.photo_url, public.station_service_logs.photo_url),
        serviced_at = EXCLUDED.serviced_at
  RETURNING id INTO _id;
  RETURN _id;
END $function$;

COMMENT ON FUNCTION public.log_station_service(uuid, uuid, integer, boolean, integer, text, text, timestamptz) IS
  'Records what a tech did at one waste station on one visit. Authorized for org writers OR the tech assigned to THIS visit — the tech is the person who does the work, and can_write_org deliberately excludes them. _serviced_at carries when a QUEUED action was actually performed, bounded exactly as skip_visit bounds its own. Idempotent on (visit_id, waste_station_id), which the offline queue relies on.';

REVOKE ALL ON FUNCTION public.log_station_service(uuid, uuid, integer, boolean, integer, text, text, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.log_station_service(uuid, uuid, integer, boolean, integer, text, text, timestamptz) TO authenticated, service_role;

DROP FUNCTION IF EXISTS public.log_station_service(uuid, uuid, integer, boolean, integer, text, text);

DO $post$
DECLARE _def text; _n integer;
BEGIN
  SELECT count(*) INTO _n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'log_station_service';
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly one log_station_service, found % — an ambiguous overload is a broken RPC', _n;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'log_station_service';

  IF _def NOT LIKE '%is_visit_tech(auth.uid(), _visit_id)%' THEN
    RAISE EXCEPTION 'the assigned-tech branch is not in the guard';
  END IF;
  IF _def NOT LIKE '%can_write_org(auth.uid(), _org)%' THEN
    RAISE EXCEPTION 'the org-writer branch was lost; office staff can no longer log stations';
  END IF;
  IF _def LIKE '%serviced_at = now()%' THEN
    RAISE EXCEPTION 'serviced_at is still hardcoded to now(); a replayed log would claim the sync time';
  END IF;

  -- Untouched on purpose. This migration is only worth its length if the
  -- function it does NOT change is still the narrow thing it was.
  IF pg_get_functiondef('public.can_write_org(uuid,uuid)'::regprocedure) LIKE '%''tech''%' THEN
    RAISE EXCEPTION 'can_write_org was widened to include tech — that is the regression this migration exists to avoid';
  END IF;

  IF NOT has_function_privilege('authenticated',
        'public.log_station_service(uuid,uuid,integer,boolean,integer,text,text,timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute the re-signed function';
  END IF;
END
$post$;
