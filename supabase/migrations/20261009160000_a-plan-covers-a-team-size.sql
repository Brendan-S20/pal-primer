-- A plan covers a team size (owner, 2026-10-09; spec NP-10).
--
-- Launch covers up to 3 enabled users, Growth up to 15, Scale has no cap
-- (`platform_plans.max_team_size`, 20261009150000). Enabling or inviting a user
-- past the plan's cap is refused with a message to move up a plan:
--
--   "Launch covers up to 3 people. To add a 4th, move to Growth."
--
-- The server functions say so first (src/lib/team-size.server.ts). This is the
-- backstop, and it is not optional: the two ways a user BECOMES enabled are
-- both RPCs any signed-in owner may call straight from the browser,
-- `set_staff_active` and `accept_org_invite_for_current_user`, and an insert
-- into `staff` is a third. A trigger on `staff` is the one place all of them
-- pass through.
--
-- WHEN IT APPLIES. Only once a plan has been CHOSEN, i.e. the org is paying
-- (billing_status or plan_status active / past_due / grace) and is not comped.
-- During a trial the plan on the row is assigned by team size
-- (`assign_billing_tier_for_org`), so there is no chosen cap to be past; the
-- cap is met at checkout instead, where a plan smaller than the team cannot be
-- chosen. Enterprise has no cap (NULL).
--
-- WHAT IT DOES NOT DO. It never turns anybody off. An org that is already over
-- its cap (none in production: no org has a subscription) keeps everyone it
-- has; it simply cannot enable one more. Deactivating is never refused.
--
-- Concurrent enables in one org are serialised with a transaction-scoped
-- advisory lock, so two owners clicking at once cannot both take the last
-- place.

CREATE OR REPLACE FUNCTION public.team_size_ordinal(_n integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT _n::text || CASE
    WHEN _n % 100 BETWEEN 11 AND 13 THEN 'th'
    WHEN _n % 10 = 1 THEN 'st'
    WHEN _n % 10 = 2 THEN 'nd'
    WHEN _n % 10 = 3 THEN 'rd'
    ELSE 'th'
  END;
$$;

REVOKE ALL ON FUNCTION public.team_size_ordinal(integer) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_team_size_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _billing text;
  _plan_status text;
  _comped boolean;
  _plan_name text;
  _max integer;
  _others integer;
  _next text;
BEGIN
  IF NEW.active IS NOT TRUE THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.active IS TRUE THEN RETURN NEW; END IF;

  SELECT o.billing_status::text, o.plan_status::text, o.is_comped, p.name, p.max_team_size
    INTO _billing, _plan_status, _comped, _plan_name, _max
    FROM public.organizations o
    LEFT JOIN public.platform_plans p ON p.id = o.plan_id
   WHERE o.id = NEW.organization_id;

  IF _max IS NULL OR _comped IS TRUE THEN RETURN NEW; END IF;
  IF NOT (_billing IN ('active', 'past_due', 'grace') OR _plan_status IN ('active', 'past_due', 'grace')) THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('houndstack.team-size'), hashtext(NEW.organization_id::text));

  SELECT count(*) INTO _others
    FROM public.staff
   WHERE organization_id = NEW.organization_id
     AND active IS TRUE
     AND id IS DISTINCT FROM NEW.id;

  IF _others + 1 <= _max THEN RETURN NEW; END IF;

  SELECT p.name INTO _next
    FROM public.platform_plans p
   WHERE p.is_active AND NOT p.is_enterprise AND p.included_seats IS NOT NULL
     AND (p.max_team_size IS NULL OR p.max_team_size > _max)
   ORDER BY p.max_team_size ASC NULLS LAST, p.included_seats ASC
   LIMIT 1;

  RAISE EXCEPTION USING
    ERRCODE = 'P0001',
    MESSAGE = format('%s covers up to %s people. To add a %s, %s.',
                     _plan_name, _max, public.team_size_ordinal(_max + 1),
                     CASE WHEN _next IS NULL THEN 'contact us about a bigger plan'
                          ELSE 'move to ' || _next END),
    HINT = 'team_size_cap';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_team_size_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS staff_team_size_cap ON public.staff;
CREATE TRIGGER staff_team_size_cap
  BEFORE INSERT OR UPDATE OF active ON public.staff
  FOR EACH ROW
  WHEN (NEW.active IS TRUE)
  EXECUTE FUNCTION public.enforce_team_size_cap();

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.staff'::regclass AND tgname = 'staff_team_size_cap' AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'staff_team_size_cap is not on public.staff';
  END IF;
  IF has_function_privilege('anon', 'public.enforce_team_size_cap()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.enforce_team_size_cap()', 'EXECUTE') THEN
    RAISE EXCEPTION 'enforce_team_size_cap is callable by a client role';
  END IF;
  IF public.team_size_ordinal(4) <> '4th' OR public.team_size_ordinal(16) <> '16th'
     OR public.team_size_ordinal(21) <> '21st' OR public.team_size_ordinal(12) <> '12th' THEN
    RAISE EXCEPTION 'team_size_ordinal is wrong';
  END IF;
END
$check$;
