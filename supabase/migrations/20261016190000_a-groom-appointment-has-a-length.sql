-- A booked groom keeps the length and the price that were quoted for these
-- pets. Routing reads the visit's minutes ahead of the service default.
-- Customers still cannot pick a groom: public_services and public_quote
-- leave the line out until that path books the same way the office does.

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS duration_min integer,
  ADD COLUMN IF NOT EXISTS groom_summary text;

ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_duration_min_check;
ALTER TABLE public.visits ADD CONSTRAINT visits_duration_min_check
  CHECK (duration_min IS NULL OR duration_min BETWEEN 1 AND 10000);
ALTER TABLE public.visits DROP CONSTRAINT IF EXISTS visits_groom_summary_check;
ALTER TABLE public.visits ADD CONSTRAINT visits_groom_summary_check
  CHECK (groom_summary IS NULL OR char_length(groom_summary) <= 240);

COMMENT ON COLUMN public.visits.duration_min IS
  'Minutes on site when this visit is not the service default. A groom stores the size and add-on total. Null keeps stop_service_min on the service, then the yard.';
COMMENT ON COLUMN public.visits.groom_summary IS
  'Which pets this groom was booked for, in the office''s words. The invoice still names the service; this is what the visit list and the groomer read.';

-- Prefer the visit, then the service, then the yard, then 8. The two-argument
-- function stays for every caller that does not have a visit length.
CREATE OR REPLACE FUNCTION public.stop_service_min(_visit_min integer, _service_min integer, _property_min integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN _visit_min IS NOT NULL AND _visit_min > 0 THEN _visit_min
    ELSE public.stop_service_min(_service_min, _property_min)
  END;
$function$;

COMMENT ON FUNCTION public.stop_service_min(integer, integer, integer) IS
  'Minutes on site: the visit''s duration_min when it is set, else stop_service_min(service, property). Mirrored by visitServiceMinutes. Migration 20261016190000.';

REVOKE ALL ON FUNCTION public.stop_service_min(integer, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stop_service_min(integer, integer, integer) TO authenticated, service_role;

-- The planner's two readers. Named functions only, and a no-op if this file
-- is applied again after the call already prefers the visit.
DO $patch$
DECLARE
  fn text;
  def text;
  old_call constant text := 'public.stop_service_min(sv.default_duration_min, p.service_duration_min)';
  new_call constant text := 'public.stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)';
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.route_day_inputs(uuid,uuid[],date,boolean)',
    'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])'
  ]
  LOOP
    def := pg_get_functiondef(fn::regprocedure);
    IF strpos(def, new_call) > 0 THEN
      CONTINUE;
    END IF;
    IF strpos(def, old_call) = 0 THEN
      RAISE EXCEPTION '% does not read stop_service_min(service, property); the splice anchor moved.', fn;
    END IF;
    def := replace(def, old_call, new_call);
    IF strpos(def, old_call) > 0 THEN
      RAISE EXCEPTION '% still has a stop that ignores the visit length.', fn;
    END IF;
    EXECUTE def;
  END LOOP;
END
$patch$;

-- Strangers and the portal's public list. The office catalog is unchanged.
-- 20261016180000 (#476) spliced the training line out of this function, and
-- this file runs after it, so the full definition below hides both lines.
CREATE OR REPLACE FUNCTION public.public_services(_slug text)
RETURNS TABLE(
  id uuid,
  name text,
  service_line text,
  price_unit text,
  base_price_cents integer,
  extra_pet_cents integer,
  default_duration_min integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  _org public.organizations;
BEGIN
  SELECT * INTO _org FROM public.organizations o
    WHERE (o.portal_slug = _slug OR o.slug = _slug)
      AND o.public_signup_enabled = true
      AND o.deleted_at IS NULL
    ORDER BY (o.portal_slug = _slug) DESC NULLS LAST
    LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY
    SELECT s.id, s.name, s.service_line, s.price_unit,
           s.base_price_cents, s.extra_pet_cents, s.default_duration_min::integer
      FROM public.services s
     WHERE s.organization_id = _org.id
       AND s.active
       AND s.service_line <> 'mobile_grooming'
       AND s.service_line <> 'training'
       AND (s.service_line = 'pet_waste' OR s.base_price_cents IS NOT NULL)
     ORDER BY array_position(ARRAY['pet_waste','dog_walking','pet_sitting','mobile_grooming','training','other'], s.service_line),
              lower(s.name),
              s.id;
END;
$$;

REVOKE ALL ON FUNCTION public.public_services(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_services(text) TO anon, authenticated, service_role;

-- A named groom id quotes nothing. The office prices by pet size, which this
-- function cannot see.
DO $quote$
DECLARE
  _def text;
  _anchor constant text := 'IF _svc.id IS NOT NULL AND _svc.service_line <> ''pet_waste'' THEN';
  _count integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text,text,integer,text,text,uuid)'::regprocedure);
  IF strpos(_def, 'service_line = ''mobile_grooming''') > 0 THEN
    RETURN;
  END IF;
  _count := (length(_def) - length(replace(_def, _anchor, ''))) / length(_anchor);
  IF _count <> 1 THEN
    RAISE EXCEPTION 'public_quote contains the service branch % time(s), not once.', _count;
  END IF;
  _def := replace(
    _def,
    _anchor,
    'IF _svc.id IS NOT NULL AND _svc.service_line = ''mobile_grooming'' THEN' || E'\n    RETURN;\n  END IF;\n\n  ' || _anchor
  );
  EXECUTE _def;
END
$quote$;

DO $post$
DECLARE
  _src text;
BEGIN
  IF public.stop_service_min(90, 60, 12) <> 90
     OR public.stop_service_min(NULL, 60, 12) <> 60
     OR public.stop_service_min(NULL, NULL, 12) <> 12
     OR public.stop_service_min(0, 60, 12) <> 60
     OR public.stop_service_min(NULL, NULL, NULL) <> 8 THEN
    RAISE EXCEPTION 'stop_service_min does not prefer the visit, then the service, then the yard, then 8';
  END IF;
  IF has_function_privilege('anon', 'public.stop_service_min(integer,integer,integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call the three-argument stop_service_min';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'duration_min'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'groom_summary'
  ) THEN
    RAISE EXCEPTION 'visits is missing duration_min or groom_summary';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.route_day_inputs(uuid,uuid[],date,boolean)'::regprocedure;
  IF _src NOT LIKE '%stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)%'
     OR _src LIKE '%stop_service_min(sv.default_duration_min, p.service_duration_min)%' THEN
    RAISE EXCEPTION 'route_day_inputs does not prefer the visit length';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.apply_route_plan(uuid,uuid[],date,boolean,jsonb,boolean,uuid[])'::regprocedure;
  IF _src NOT LIKE '%stop_service_min(v.duration_min, sv.default_duration_min, p.service_duration_min)%'
     OR _src LIKE '%stop_service_min(sv.default_duration_min, p.service_duration_min)%' THEN
    RAISE EXCEPTION 'apply_route_plan does not prefer the visit length';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.public_services(text)'::regprocedure;
  IF _src NOT LIKE '%service_line <> ''mobile_grooming''%' THEN
    RAISE EXCEPTION 'public_services still lists mobile grooming';
  END IF;
  IF _src NOT LIKE '%service_line <> ''training''%' THEN
    RAISE EXCEPTION 'public_services lists training again';
  END IF;
  IF pg_get_function_result('public.public_services(text)'::regprocedure) ~* 'organization|slug|stripe|key|email|phone' THEN
    RAISE EXCEPTION 'public_services returns an organization column';
  END IF;

  SELECT p.prosrc INTO _src FROM pg_proc p
   WHERE p.oid = 'public.public_quote(text,text,integer,text,text,uuid)'::regprocedure;
  IF strpos(_src, 'service_line = ''mobile_grooming''') = 0
     OR strpos(_src, 'RETURN;') = 0 THEN
    RAISE EXCEPTION 'public_quote still prices a mobile groom';
  END IF;
END
$post$;
