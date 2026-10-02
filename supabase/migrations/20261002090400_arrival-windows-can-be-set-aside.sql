-- Arrival windows can be set aside.
--
-- The owner, 2026-10-02: "I would like settings for route optimization to
-- avoid arrival windows." Some days the shortest drive matters more than the
-- 8-9 AM a customer once asked for, and until now the only way to get it was
-- to delete the window off the service and put it back afterwards.
--
-- So the organization chooses, once, in Settings -> Scheduling:
--
--   'honour'  the planner treats a window as a promise: it will drive further
--             before it arrives late, and waits for an earliest time. This is
--             what every organization has had since #294 and stays the
--             default, so nothing changes for anybody until they choose.
--   'ignore'  shortest driving. Windows play no part in the order and no truck
--             waits for one -- but the write still works out which windows the
--             plan misses and the panel lists them. Set aside, not silently
--             dropped.
--
-- The Auto-routing panel can override it for one run either way; that is a
-- parameter of the call, not a column.
--
-- Written through its own RPC rather than a new parameter on
-- update_org_dispatch_settings: that function's signature is called by name
-- from the app, and adding a defaulted argument would leave two overloads of
-- it behind on every database that already has the old one.
--
-- Replays into an empty database: a column with a default, and a function.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS route_windows text NOT NULL DEFAULT 'honour';

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_route_windows_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_route_windows_check
      CHECK (route_windows IN ('honour', 'ignore'));
  END IF;
END
$constraint$;

COMMENT ON COLUMN public.organizations.route_windows IS
  'How auto-routing treats customers'' arrival windows: honour (default) or ignore (shortest driving; misses are still reported).';

CREATE OR REPLACE FUNCTION public.set_route_windows(_org_id uuid, _policy text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  -- The same two roles update_org_dispatch_settings admits: this is a
  -- dispatch setting and belongs to whoever may change the others.
  IF NOT (
    public.has_role(auth.uid(), _org_id, 'owner')
    OR public.has_role(auth.uid(), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update dispatch settings';
  END IF;
  IF _policy IS NULL OR _policy NOT IN ('honour', 'ignore') THEN
    RAISE EXCEPTION 'Choose honour or ignore for arrival windows';
  END IF;
  UPDATE public.organizations SET route_windows = _policy WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_route_windows(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_route_windows(uuid, text) TO authenticated, service_role;

DO $check$
DECLARE
  _default text;
BEGIN
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO _default
    FROM pg_attrdef d
    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
   WHERE d.adrelid = 'public.organizations'::regclass AND a.attname = 'route_windows';
  IF _default IS NULL OR strpos(_default, 'honour') = 0 THEN
    RAISE EXCEPTION 'organizations.route_windows must default to honour, got %', _default;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_route_windows_check'
  ) THEN
    RAISE EXCEPTION 'organizations.route_windows accepts values other than honour / ignore';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE route_windows IS DISTINCT FROM 'honour'
             AND route_windows NOT IN ('honour', 'ignore')) THEN
    RAISE EXCEPTION 'an organization has an arrival-window policy that is neither honour nor ignore';
  END IF;
  IF has_function_privilege('anon', 'public.set_route_windows(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_route_windows is executable with the publishable key';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.set_route_windows(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_route_windows is not callable by a signed-in owner';
  END IF;
END
$check$;
