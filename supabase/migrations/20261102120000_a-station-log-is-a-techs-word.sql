-- A station log is a tech's word, and the office's Complete asks what the
-- tech's does (#658, F-14 and F-15).
--
-- WHY THIS IS A MIGRATION. Both faults live in SQL, and nothing in src/ can
-- reach them: finalize_visit_completion is revoked from every signed-in role
-- and is called only from complete_visit, office_complete_visit,
-- confirm_open_visit and seed_demo_org; office_complete_visit is the RPC the
-- office's Complete calls, and a gate in the server function alone would
-- leave the RPC itself as the way around it. So the fix has to be here.
--
-- ── F-14: station logs that no tech recorded ──────────────────────────────
-- finalize_visit_completion began with
--
--     PERFORM public.record_visit_station_service(_visit_id);
--
-- which wrote a station_service_logs row for EVERY active station on the
-- property when ANY visit there completed: bags 0, liner not replaced, no
-- note, no photo (20260717200500, "so Last serviced populates"). That is a
-- proof-of-service record nobody made. The office pressing Complete, or a tech
-- who serviced three of eight stations, produced eight "serviced" stations,
-- and the board, the portal's Stations panel and "Last serviced" all read
-- them as fact. A station log now exists only when log_station_service
-- writes it, which is the tech (or the office) saying what was done at that
-- station.
--
-- record_visit_station_service is dropped rather than left as a no-op: its
-- only caller is the function redefined below, it is revoked from every
-- signed-in role (20260731240000), and a function named "record ... service"
-- that records nothing would be the next thing somebody wires back in.
--
-- No rows are deleted. A fabricated row carries nothing that tells it apart
-- from a tech who logged a station with zero bags, so a cleanup would delete
-- real work along with it; the count of rows with the fabricated signature is
-- printed below for the owner to decide on.
--
-- ── F-15: the office's Complete skipped the photo and the checklist ────────
-- complete_visit (the tech) refuses without a completion photo, unless the
-- tech says why there is none, and refuses while a required checklist item
-- for the visit's service line is unchecked. office_complete_visit asked
-- neither, so any visit could be closed from the office with no proof at all.
-- It now asks the same two questions, and the office may still close the
-- visit -- it is often the one who knows the work was done -- but only by
-- saying why (_override_reason). The reason is recorded on the visit as
-- completion_photo_waived_reason when the photo is missing, and on the
-- client's timeline either way (completeVisitFromOffice); the checklist's
-- answers (every asked item, checked = false) are recorded so the visit says
-- what was not confirmed rather than nothing.
--
-- The signature gains a parameter, so the one-argument function is dropped
-- first: two overloads would make office_complete_visit(_visit_id => ...)
-- ambiguous.
--
-- Replays into an empty database: function definitions, grants, and
-- assertions about what this file establishes. The fabricated-row count is a
-- measurement, so it is a WARNING.

-- ── F-14 ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_visit_completion(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  -- No station logs here: a station is logged by log_station_service, when
  -- somebody services it (#658).

  SELECT v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  -- Freeze the price onto the work (20260903150000). `price_cents IS NULL`
  -- because this function is reachable more than once for one visit.
  UPDATE public.visits
     SET price_cents = _price
   WHERE id = _visit_id AND price_cents IS NULL;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.finalize_visit_completion(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_visit_completion(uuid) FROM anon, authenticated;

DROP FUNCTION IF EXISTS public.record_visit_station_service(uuid);

-- ── F-15 ────────────────────────────────────────────────────────────────────
DROP FUNCTION IF EXISTS public.office_complete_visit(uuid);

CREATE OR REPLACE FUNCTION public.office_complete_visit(
  _visit_id uuid,
  -- Why the office is completing a visit with no completion photo, or with
  -- required checklist items nobody checked. Required exactly when one of
  -- those is missing.
  _override_reason text DEFAULT NULL
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid;
  _status public.visit_status;
  _required boolean;
  _checklist jsonb;
  _line text;
  _has_photo boolean;
  _photo_missing boolean;
  _missing text;
  _why text := left(NULLIF(btrim(COALESCE(_override_reason, '')), ''), 250);
  _answers jsonb;
BEGIN
  SELECT organization_id, status INTO _org, _status
    FROM public.visits WHERE id = _visit_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Visit not found'; END IF;
  IF NOT public.can_write_org(auth.uid(), _org) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF _status NOT IN ('scheduled','in_progress','missed') THEN
    RAISE EXCEPTION 'Only scheduled, in-progress, or missed visits can be completed';
  END IF;

  -- The same two questions complete_visit asks, decided the same way: the
  -- visit's line is its service's; with no service, the business's only line
  -- when it runs exactly one, else pet waste.
  SELECT COALESCE(o.require_completion_photo, true), COALESCE(o.visit_checklist, '[]'::jsonb),
         COALESCE(s.service_line,
                  CASE WHEN cardinality(o.service_lines) = 1 THEN o.service_lines[1] END,
                  'pet_waste')
    INTO _required, _checklist, _line
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
    LEFT JOIN public.services s ON s.id = v.service_id
   WHERE v.id = _visit_id;

  IF jsonb_typeof(_checklist) = 'array' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb)
      INTO _checklist
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
     WHERE NOT (item ? 'line') OR item ->> 'line' = _line;
  ELSE
    _checklist := '[]'::jsonb;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion')
    INTO _has_photo;
  _photo_missing := _required AND NOT _has_photo;

  -- Nobody in the office checked an item, so every required one is missing.
  SELECT string_agg(item ->> 'label', ', ' ORDER BY ord)
    INTO _missing
    FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
   WHERE COALESCE((item ->> 'required')::boolean, false);

  IF (_photo_missing OR _missing IS NOT NULL) AND _why IS NULL THEN
    RAISE EXCEPTION 'This visit has %. Say why you are completing it from the office.',
      concat_ws(' and ',
        CASE WHEN _photo_missing THEN 'no completion photo' END,
        CASE WHEN _missing IS NOT NULL THEN 'required checklist items nobody checked (' || _missing || ')' END);
  END IF;

  IF jsonb_array_length(_checklist) > 0 THEN
    SELECT jsonb_agg(
             jsonb_build_object(
               'id', item ->> 'id',
               'label', item ->> 'label',
               'required', COALESCE((item ->> 'required')::boolean, false),
               'checked', false
             ) ORDER BY ord)
      INTO _answers
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord);
  END IF;

  -- Note it still does NOT touch started_at (BUG-9).
  UPDATE public.visits
     SET status = 'completed', completed_at = now(), updated_at = now(),
         completion_source = 'office',
         completion_photo_waived_reason = CASE
           WHEN _photo_missing THEN 'Completed from the office: ' || _why
           ELSE completion_photo_waived_reason END,
         -- Answers already on the visit are kept: only complete_visit writes
         -- them, and only on completion, so today there are none here; if
         -- that changes, the tech's answers outrank the office's "unchecked".
         visit_checklist = COALESCE(visit_checklist, _answers)
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

COMMENT ON FUNCTION public.office_complete_visit(uuid, text) IS
  'The office marks a visit completed. Asks what complete_visit asks -- a completion photo when the business requires one, and the required checklist items for the visit''s line -- and when either is missing completes only with _override_reason, which it records on the visit (#658).';

REVOKE ALL ON FUNCTION public.office_complete_visit(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_complete_visit(uuid, text) TO authenticated;

-- ── what this file establishes ──────────────────────────────────────────────
DO $check$
DECLARE _n bigint;
BEGIN
  IF to_regprocedure('public.record_visit_station_service(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'record_visit_station_service still exists';
  END IF;
  IF position('station_service_logs' IN
       (SELECT prosrc FROM pg_proc WHERE oid = 'public.finalize_visit_completion(uuid)'::regprocedure)) > 0
  THEN
    RAISE EXCEPTION 'finalize_visit_completion still writes station logs';
  END IF;
  IF to_regprocedure('public.office_complete_visit(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'the one-argument office_complete_visit is still there beside the new one';
  END IF;
  IF has_function_privilege('anon', 'public.office_complete_visit(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'office_complete_visit is executable by anon';
  END IF;
  IF has_function_privilege('authenticated', 'public.finalize_visit_completion(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'finalize_visit_completion is executable by a signed-in session';
  END IF;

  -- A measurement, not a product: rows with the signature the dropped
  -- function wrote (all zeros, no note, no photo, stamped in the same
  -- transaction that completed the visit). Not deleted -- see the header.
  SELECT count(*) INTO _n
    FROM public.station_service_logs l
    JOIN public.visits v ON v.id = l.visit_id
   WHERE l.serviced_at = v.completed_at
     AND COALESCE(l.bags_collected, 0) = 0
     AND NOT COALESCE(l.liner_replaced, false)
     AND COALESCE(l.refill_bags_added, 0) = 0
     AND l.notes IS NULL AND l.photo_url IS NULL;
  RAISE WARNING 'station_service_logs with the auto-recorded signature (not deleted): %', _n;
END
$check$;
