-- A visit had no checklist.
--
-- Found 2026-09-29 by the product review: Jobber has job forms, and the field
-- app had nothing to ask a tech "all areas walked? waste bagged? gate
-- latched? water bowl checked?". A note, a photo kind called 'gate' and
-- Complete were the whole of it, so what the owner wanted confirmed on every
-- visit lived in the owner's head.
--
--   organizations.visit_checklist   the owner's list, up to 12 items, each
--                                   {id, label, required}. '[]' by default,
--                                   so no existing organization changes until
--                                   its owner adds an item.
--   organizations.email_visit_checklist
--                                   whether the completion email lists what
--                                   was checked. Off by default.
--   visits.visit_checklist          what the tech answered, as
--                                   {id, label, required, checked} for every
--                                   item on the list at the time. NULL when
--                                   nothing asked: no list, or a completion
--                                   by the office or the end-of-day close-out.
--
-- A column rather than a table. The answers are written once, by
-- complete_visit, in the same UPDATE that completes the visit; they are read
-- only with their visit (the drawer, the email); nothing ever queries across
-- visits by item; and there are at most twelve. A table would need its own
-- RLS, grants, indexes and a second write that could land without the first.
--
-- The LABEL is copied into the visit, not referenced. An owner who renames
-- "Gate latched" to "Gate latched and chained" in October has not changed
-- what a tech confirmed in September. And it is copied by the SERVER, from
-- the owner's list, rather than accepted from the phone: the caller sends
-- only which ids were checked, so the words on the record are the owner's.
--
-- complete_visit gains `_checked_items text[]` and refuses while a required
-- item is unchecked, the way it refuses a missing completion photo with no
-- reason. The signature changes, so the four-argument form is DROPPED rather
-- than overloaded: two signatures would make every call that omits the new
-- argument ambiguous (see 20260804060000 for that failure). The grants are
-- restated because a dropped function takes its grants with it.
--
-- Replays into an empty database: three columns, two functions, grants. The
-- assertions are about what this file establishes.

-- ── The shape of a checklist, in one place ─────────────────────────────────
-- A CHECK cannot hold a subquery, so the rule is a function. Extra keys are
-- allowed, which is what lets the same rule guard a visit's answers (which
-- also carry `checked`) and the owner's list.
CREATE OR REPLACE FUNCTION public.visit_checklist_is_valid(_items jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _items IS NULL OR jsonb_typeof(_items) <> 'array' THEN false
    WHEN jsonb_array_length(_items) > 12 THEN false
    ELSE NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements(_items) AS e(item)
            WHERE jsonb_typeof(item) <> 'object'
               OR jsonb_typeof(item -> 'id') IS DISTINCT FROM 'string'
               OR jsonb_typeof(item -> 'label') IS DISTINCT FROM 'string'
               OR jsonb_typeof(item -> 'required') IS DISTINCT FROM 'boolean'
               OR char_length(item ->> 'id') NOT BETWEEN 1 AND 64
               OR char_length(btrim(item ->> 'label')) NOT BETWEEN 1 AND 120
         )
     AND (SELECT count(DISTINCT item ->> 'id') FROM jsonb_array_elements(_items) AS e(item))
         = jsonb_array_length(_items)
  END;
$function$;

REVOKE ALL ON FUNCTION public.visit_checklist_is_valid(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.visit_checklist_is_valid(jsonb) TO authenticated, service_role;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS visit_checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS email_visit_checklist boolean NOT NULL DEFAULT false;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_visit_checklist_shape;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_visit_checklist_shape
  CHECK (public.visit_checklist_is_valid(visit_checklist));

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS visit_checklist jsonb;

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_visit_checklist_shape;
ALTER TABLE public.visits ADD CONSTRAINT visits_visit_checklist_shape
  CHECK (visit_checklist IS NULL OR public.visit_checklist_is_valid(visit_checklist));

COMMENT ON COLUMN public.organizations.visit_checklist IS
  'What a tech confirms on every visit: up to 12 items of {id, label, required}. Empty means no checklist.';
COMMENT ON COLUMN public.organizations.email_visit_checklist IS
  'Whether the visit-completed email lists the checklist items the tech checked.';
COMMENT ON COLUMN public.visits.visit_checklist IS
  'The checklist as the tech answered it: {id, label, required, checked} per item, labels copied from the organization''s list at completion. NULL when no checklist was asked.';

-- ── complete_visit, with the checklist ─────────────────────────────────────
DROP FUNCTION IF EXISTS public.complete_visit(uuid, timestamptz, text, text);

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
  _checked text[] := COALESCE(_checked_items, '{}'::text[]);
  _missing text;
  _answers jsonb;
BEGIN
  IF NOT public.is_visit_tech(auth.uid(), _visit_id) THEN
    RAISE EXCEPTION 'Not authorized for this visit';
  END IF;

  SELECT COALESCE(o.require_completion_photo, true), COALESCE(o.visit_checklist, '[]'::jsonb)
    INTO _required, _checklist
    FROM public.visits v
    JOIN public.organizations o ON o.id = v.organization_id
   WHERE v.id = _visit_id;

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

    -- Every item on the list as it reads now, answered. Copied, so a later
    -- edit to the list leaves this visit's record as it was.
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
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'complete_visit') <> 1 THEN
    RAISE EXCEPTION 'complete_visit must have exactly one signature, or a call that omits _checked_items is ambiguous';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.complete_visit(uuid, timestamptz, text, text, text[])'::regprocedure)
       !~ 'Check off every required item' THEN
    RAISE EXCEPTION 'complete_visit does not refuse an unchecked required item';
  END IF;
  IF (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.complete_visit(uuid, timestamptz, text, text, text[])'::regprocedure)
       !~ 'require_completion_photo' THEN
    RAISE EXCEPTION 'complete_visit no longer reads the organization''s photo rule';
  END IF;
  IF has_function_privilege('anon', 'public.complete_visit(uuid, timestamptz, text, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute complete_visit';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.complete_visit(uuid, timestamptz, text, text, text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated lost complete_visit when it was recreated';
  END IF;
  IF has_function_privilege('anon', 'public.visit_checklist_is_valid(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute visit_checklist_is_valid';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'visit_checklist' AND is_nullable = 'NO'
       AND column_default = '''[]''::jsonb'
  ) THEN
    RAISE EXCEPTION 'organizations.visit_checklist must default to an empty list, so no existing org changes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'email_visit_checklist' AND column_default = 'false'
  ) THEN
    RAISE EXCEPTION 'organizations.email_visit_checklist must default to off';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'visit_checklist'
  ) THEN
    RAISE EXCEPTION 'visits.visit_checklist is missing';
  END IF;

  -- The shape rule, on values rather than rows: nothing here needs a tenant.
  IF NOT public.visit_checklist_is_valid('[]'::jsonb)
     OR NOT public.visit_checklist_is_valid(
       '[{"id":"a","label":"Gate latched","required":true,"checked":false}]'::jsonb) THEN
    RAISE EXCEPTION 'visit_checklist_is_valid refuses a valid list';
  END IF;
  IF public.visit_checklist_is_valid('[{"id":"a","label":"  ","required":true}]'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x","required":true},{"id":"a","label":"y","required":false}]'::jsonb)
     OR public.visit_checklist_is_valid('[{"id":"a","label":"x"}]'::jsonb)
     OR public.visit_checklist_is_valid('{"id":"a"}'::jsonb)
     OR public.visit_checklist_is_valid(
       (SELECT jsonb_agg(jsonb_build_object('id', g::text, 'label', 'x', 'required', false))
          FROM generate_series(1, 13) g)) THEN
    RAISE EXCEPTION 'visit_checklist_is_valid accepts a list it must refuse';
  END IF;
END
$check$;
