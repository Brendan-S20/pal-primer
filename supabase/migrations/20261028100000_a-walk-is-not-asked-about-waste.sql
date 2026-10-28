-- A walk is not asked about waste (#565).
--
-- organizations.visit_checklist was one list for every visit. complete_visit
-- (20260929040000) refuses while a required item on it is unchecked, so a
-- business that scoops AND walks, and kept the pet-waste suggestions ("Waste
-- bagged and disposed", "Gate latched"), could not finish a walk without
-- ticking a waste item. Hiding the item in My Day would not have helped: the
-- database still refused.
--
-- The fix is a key on the item, not a new column or a list per line:
--
--   {id, label, required, line?}   `line` is one of the service lines
--                                  (service_lines_are_valid). An item with
--                                  no line is asked on every visit, which is
--                                  what every list saved before this file
--                                  means, so no existing list changes.
--
-- complete_visit asks only the items for the visit's own line: its service's
-- service_line, and for a visit with no service, pet waste (the same rule as
-- the app after #564). Only those items are recorded on the visit.
--
-- visit_checklist_is_valid guards both the owner's list and a visit's
-- answers, so its count rule changes from "twelve items" to "twelve asked on
-- any one visit": the every-line items plus the largest line's. A list with
-- no line keys is held to twelve exactly as before. The new rule accepts
-- everything the old one did, so the existing CHECK constraints need no
-- re-validation.
--
-- CREATE OR REPLACE with the same signature keeps complete_visit's grants;
-- they are restated anyway, and the check block asserts them.
--
-- Replays into an empty database: two functions, grants, and assertions on
-- values rather than rows.

CREATE OR REPLACE FUNCTION public.visit_checklist_is_valid(_items jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _items IS NULL OR jsonb_typeof(_items) <> 'array' THEN false
    WHEN jsonb_array_length(_items) > 72 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(_items) AS e(item)
            WHERE jsonb_typeof(item) <> 'object'
               OR jsonb_typeof(item -> 'id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(item -> 'label') IS DISTINCT FROM 'string'
               OR jsonb_typeof(item -> 'required') IS DISTINCT FROM 'boolean'
               OR char_length(item ->> 'id') NOT BETWEEN 1 AND 64
               OR char_length(btrim(item ->> 'label')) NOT BETWEEN 1 AND 120
               OR (item ? 'line'
                   AND (jsonb_typeof(item -> 'line') IS DISTINCT FROM 'string'
                        OR NOT public.service_lines_are_valid(ARRAY[item ->> 'line'])))
         )
     AND (SELECT count(DISTINCT item ->> 'id') FROM jsonb_array_elements(_items) AS e(item))
         = jsonb_array_length(_items)
     -- Twelve asked on any one visit: the every-line items plus each line's.
     AND (SELECT count(*) FROM jsonb_array_elements(_items) AS e(item) WHERE NOT (item ? 'line'))
         + COALESCE((SELECT max(n) FROM (
             SELECT count(*) AS n FROM jsonb_array_elements(_items) AS e(item)
              WHERE item ? 'line' GROUP BY item ->> 'line') per_line), 0)
         <= 12
  END;
$function$;

REVOKE ALL ON FUNCTION public.visit_checklist_is_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visit_checklist_is_valid(jsonb) TO authenticated, service_role;

COMMENT ON COLUMN public.organizations.visit_checklist IS
  'What a tech confirms on a visit: items of {id, label, required, line?}. An item with a line is asked only on visits of that service line; one without is asked on every visit. At most 12 asked on any one visit. Empty means no checklist.';

CREATE OR REPLACE FUNCTION public.complete_visit(
  _visit_id uuid,
  -- When the tech actually finished, from the queued action. NULL means "now",
  -- which is the live path.
  _completed_at timestamptz DEFAULT NULL,
  _note text DEFAULT NULL,
  -- Why there is no completion photo, when the organization requires one.
  _no_photo_reason text DEFAULT NULL,
  -- The ids of the checklist items the tech checked. Only ids: the labels on
  -- the record come from the organization's own list.
  _checked_items text[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _has_photo boolean;
  _required boolean;
  _waived text;
  _started timestamptz;
  _when timestamptz := now();
  _source text := 'tech_live';
  _checklist jsonb;
  _line text;
  _checked text[] := COALESCE(_checked_items, '{}'::text[]);
  _missing text;
  _answers jsonb;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  -- The visit's line: its service's, and pet waste for a visit with none.
  SELECT COALESCE(o.require_completion_photo, true), COALESCE(o.visit_checklist, '[]'::jsonb),
         COALESCE(s.service_line, 'pet_waste')
    INTO _required, _checklist, _line
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
    LEFT JOIN public.services s ON s.id = v.service_id
   WHERE v.id = _visit_id;

  -- Only the items this visit is asked: every-line items and its own line's,
  -- in the owner's order.
  IF jsonb_typeof(_checklist) = 'array' THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ord), '[]'::jsonb)
      INTO _checklist
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
     WHERE NOT (item ? 'line') OR item ->> 'line' = _line;
  END IF;

  SELECT EXISTS (SELECT 1 FROM public.visit_photos WHERE visit_id = _visit_id AND kind = 'completion')
    INTO _has_photo;

  IF _required AND NOT _has_photo THEN
    _waived := NULLIF(btrim(COALESCE(_no_photo_reason, '')), '');
    IF _waived IS NULL THEN
      RAISE EXCEPTION 'A completion photo is required before completing this visit. If you could not take one, say why.';
    END IF;
    _waived := left(_waived, 300);
  END IF;

  -- The checklist, held the same way as the photo: a required item that is
  -- not checked refuses the completion, and names what is missing.
  IF jsonb_typeof(_checklist) = 'array' AND jsonb_array_length(_checklist) > 0 THEN
    SELECT string_agg(item ->> 'label', ', ' ORDER BY ord)
      INTO _missing
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord)
     WHERE COALESCE((item ->> 'required')::boolean, false)
       AND NOT ((item ->> 'id') = ANY (_checked));
    IF _missing IS NOT NULL THEN
      RAISE EXCEPTION 'Check off every required item before completing this visit: %', _missing;
    END IF;

    -- Every item this visit was asked, answered. Copied, so a later edit to
    -- the list leaves this visit's record as it was.
    SELECT jsonb_agg(
             jsonb_build_object(
               'id', item ->> 'id',
               'label', item ->> 'label',
               'required', COALESCE((item ->> 'required')::boolean, false),
               'checked', (item ->> 'id') = ANY (_checked)
             ) ORDER BY ord)
      INTO _answers
      FROM jsonb_array_elements(_checklist) WITH ORDINALITY AS c(item, ord);
  END IF;

  IF _completed_at IS NOT NULL THEN
    SELECT started_at INTO _started FROM public.visits WHERE id = _visit_id;
    -- Believe it only if it is possible. Each rejection falls back to now()
    -- rather than failing: the completion is real either way, and losing a
    -- tech's work over a phone clock they cannot fix in the field would be a
    -- worse answer than an approximate time that says so.
    IF _completed_at <= now()
       AND _completed_at >= now() - interval '7 days'
       AND (_started IS NULL OR _completed_at >= _started)
    THEN
      _when := _completed_at;
    END IF;
    -- The source records the REPLAY, not whether the timestamp survived
    -- validation. Either way this was not measured live, and that is the fact
    -- every reader of this column needs.
    _source := 'tech_offline_replay';
  END IF;

  UPDATE public.visits
     SET status = 'completed', completed_at = _when, updated_at = now(),
         completion_source = _source,
         tech_note = COALESCE(left(NULLIF(btrim(COALESCE(_note, '')), ''), 1000), tech_note),
         completion_photo_waived_reason = COALESCE(_waived, completion_photo_waived_reason),
         visit_checklist = COALESCE(_answers, visit_checklist)
   WHERE id = _visit_id AND status IN ('scheduled','in_progress','missed');
  IF NOT FOUND THEN RETURN; END IF;

  PERFORM public.finalize_visit_completion(_visit_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.complete_visit(uuid, timestamptz, text, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_visit(uuid, timestamptz, text, text, text[])
  TO authenticated, service_role;

-- What this file establishes.
DO $check$
DECLARE
  _src text;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'complete_visit') <> 1 THEN
    RAISE EXCEPTION 'complete_visit must have exactly one signature, or a call that omits _checked_items is ambiguous';
  END IF;
  SELECT prosrc INTO _src FROM pg_proc
   WHERE oid = 'public.complete_visit(uuid, timestamptz, text, text, text[])'::regprocedure;
  IF _src !~ 'Check off every required item' THEN
    RAISE EXCEPTION 'complete_visit does not refuse an unchecked required item';
  END IF;
  IF _src !~ 'require_completion_photo' THEN
    RAISE EXCEPTION 'complete_visit no longer reads the organization''s photo rule';
  END IF;
  IF _src !~ 'COALESCE\(s\.service_line, ''pet_waste''\)' THEN
    RAISE EXCEPTION 'complete_visit does not read the visit''s line, with pet waste for no service';
  END IF;
  IF has_function_privilege('anon', 'public.complete_visit(uuid, timestamptz, text, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute complete_visit';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.complete_visit(uuid, timestamptz, text, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute complete_visit';
  END IF;
  IF has_function_privilege('anon', 'public.visit_checklist_is_valid(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute visit_checklist_is_valid';
  END IF;

  -- The shape rule, on values rather than rows: nothing here needs a tenant.
  IF NOT public.visit_checklist_is_valid('[]'::jsonb)
     OR NOT public.visit_checklist_is_valid(
       '[{"id":"a","label":"Gate latched","required":true,"checked":false}]'::jsonb)
     OR NOT public.visit_checklist_is_valid(
       '[{"id":"a","label":"Gate latched","required":true},
         {"id":"b","label":"Waste bagged and disposed","required":true,"line":"pet_waste"},
         {"id":"c","label":"Dog collected and returned","required":true,"line":"dog_walking"}]'::jsonb)
     -- Twelve on each of two lines: no visit is asked more than twelve.
     OR NOT public.visit_checklist_is_valid(
       (SELECT jsonb_agg(jsonb_build_object('id', g::text, 'label', 'x', 'required', false,
                                            'line', CASE WHEN g <= 12 THEN 'pet_waste' ELSE 'dog_walking' END))
          FROM generate_series(1, 24) g)) THEN
    RAISE EXCEPTION 'visit_checklist_is_valid refuses a valid list';
  END IF;
  IF public.visit_checklist_is_valid('[{"id":"a","label":"  ","required":true}]'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x","required":true},{"id":"a","label":"y","required":false}]'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x"}]'::jsonb)
     OR public.visit_checklist_is_valid('{"id":"a"}'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x","required":true,"line":"plumbing"}]'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x","required":true,"line":null}]'::jsonb)
     -- Thirteen with no line, as before.
     OR public.visit_checklist_is_valid(
       (SELECT jsonb_agg(jsonb_build_object('id', g::text, 'label', 'x', 'required', false))
          FROM generate_series(1, 13) g))
     -- One every-line item plus twelve for walks: a walk would be asked thirteen.
     OR public.visit_checklist_is_valid(
       (SELECT jsonb_agg(CASE WHEN g = 0 THEN jsonb_build_object('id', g::text, 'label', 'x', 'required', false)
                              ELSE jsonb_build_object('id', g::text, 'label', 'x', 'required', false, 'line', 'dog_walking') END)
          FROM generate_series(0, 12) g)) THEN
    RAISE EXCEPTION 'visit_checklist_is_valid accepts a list it must refuse';
  END IF;
END
$check$;
