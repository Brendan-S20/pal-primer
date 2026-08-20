-- staff_start_point(uuid, uuid, date) answered questions about other people's
-- tenants, to anybody with an account.
--
-- The function is SECURITY DEFINER and was granted to `authenticated`
-- (20260815180000_a-technician-with-no-start-address-started-from-nowhere.sql,
-- line 163). It contains no auth.uid() anywhere. Every one of its four tiers
-- filters on the CALLER-SUPPLIED _org_id:
--
--   FROM public.staff s      WHERE s.id = _staff_id AND s.organization_id = _org_id
--   FROM public.organizations o WHERE o.id = _org_id
--   FROM public.visits v JOIN public.properties p …  WHERE v.organization_id = _org_id
--
-- so PostgREST exposes it as an RPC that any signed-in user of any tenant --
-- including a `tech`, the lowest role in the product -- can call against any
-- other tenant's id:
--
--   POST /rest/v1/rpc/staff_start_point
--   { "_org_id": "<victim org>", "_staff_id": "<any uuid>", "_day": "2026-08-21" }
--
-- What came back: tier 1 is an employee's HOME COORDINATES (start_latitude /
-- start_longitude on staff); tier 2 the business location; tier 4 the exact
-- latitude and longitude of one of the victim's CUSTOMER PROPERTIES, reachable
-- with a junk _staff_id because that tier accepts `assigned_staff_id IS NULL`.
-- Returning 'none' rather than a row is itself a scheduling oracle -- it says
-- whether another business has work booked on a given date, iterable over
-- dates. Read-only, no write path, no privilege escalation: cross-tenant
-- geolocation PII, not money and not auth.
--
-- The victim's uuid needs no guessing. public_get_org_for_lead_form(_slug) is
-- granted to anon and returns `id` for any non-deleted org by slug -- see
-- tests/the-lead-form-was-a-write-into-any-tenant.test.ts, which documents that
-- disclosure as deliberate. It is deliberate; it is also what makes this
-- reachable without so much as a guess.
--
-- This was an oversight rather than a decision, and the repo says so in its own
-- hand. Five days later the four-argument overload
-- (20260815190000_the-preview-showed-every-tech-the-whole-day.sql, line 248)
-- was written `REVOKE ALL … FROM public, anon, authenticated;` -- the opposite
-- conclusion about the same function, by the same authors, with no note that
-- the three-argument sibling had been left open.
--
-- THE FIX IS A REVOKE, AND IT COSTS NOTHING. Nothing calls this by RPC: the
-- only four occurrences of the name in src/ are prose comments. Its only
-- in-database callers are plan_route(uuid,uuid,date,boolean,text) and
-- plan_visits(uuid,uuid,date,uuid[],text), both SECURITY DEFINER and owned by
-- postgres, so they execute it as the owner and are unaffected by what the
-- caller may execute. service_role keeps EXECUTE, so the nightly cron path is
-- untouched. This is the same trade the sibling overload already made.
--
-- Idempotent, and replays into an empty database: the grant it removes is
-- created by an earlier file in this same sequence.

REVOKE EXECUTE ON FUNCTION public.staff_start_point(uuid, uuid, date) FROM authenticated;

DO $post$
DECLARE
  _open text;
BEGIN
  -- What this migration ESTABLISHES, provable from any starting state: neither
  -- overload of staff_start_point is reachable by a role the web hands out.
  -- Not a census of the other 91 definer functions -- those carry auth.uid()
  -- guards and are a different question (see docs/security-advisor-triage.md).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO _open
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'staff_start_point'
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       OR has_function_privilege('anon', p.oid, 'EXECUTE'));

  IF _open IS NOT NULL THEN
    RAISE EXCEPTION 'staff_start_point is still reachable by anon or authenticated: %', _open;
  END IF;

  RAISE NOTICE 'staff_start_point: both overloads closed to anon and authenticated.';
END $post$;
