-- A new client could not be read back by whoever created it.
--
-- Found 2026-09-27 by a first-time-owner persona test: "New client" -> Create
-- failed with `new row violates row-level security policy for table
-- "clients"`, for the OWNER. Production agrees: 100 clients created by hand
-- in the week of 2026-08-03, and none since.
--
-- The write was allowed. The READ-BACK was not. createClient and
-- onboardClient (src/lib/clients.functions.ts) insert as the signed-in user
-- and ask for the row back (`.insert(...).select("id, portal_token")`), which
-- is INSERT ... RETURNING, and RETURNING must pass the table's SELECT policy.
-- That policy is `may_read_client(id)`, a STABLE function that looks the row
-- up in public.clients -- and a STABLE function runs on the snapshot taken
-- before the statement, in which the row being inserted does not exist. So it
-- answers "no such client" for exactly the row the caller just wrote.
--
-- Why it began on 2026-08-10: 20260810120000 split the FOR ALL policy
-- "Managers write clients" into insert/update/delete. FOR ALL had also been a
-- SELECT policy, evaluated on the row's own columns, and it was what let
-- RETURNING through. The split's note said SELECT "loses nothing" because
-- may_read_client admits the same roles -- true of every row that already
-- existed, false of the one being created. properties has the same shape
-- (may_read_property(id)) and so the same failure: adding a yard also died on
-- the read-back.
--
-- The fix keeps the rule and drops the lookup. The new helpers take the row's
-- OWN organization_id instead of re-reading it from the table, so there is
-- nothing for the snapshot to miss:
--   * directory holders (view_client_directory in the row's org) see it;
--   * anyone else sees it only when it is on a visit assigned to them.
-- That is may_read_client / may_read_property clause for clause, with
-- `c.organization_id` and `c.id` supplied by the policy instead of fetched.
-- The old helpers stay: other code calls them for rows that already exist,
-- where they are correct.
--
-- dogs is unaffected: its SELECT policy calls may_read_property(property_id),
-- which reads a DIFFERENT table whose row already exists.
--
-- Replays into an empty database: functions and policies only, and the one
-- assertion below is about what this file establishes.

CREATE OR REPLACE FUNCTION public.may_read_client_row(_org_id uuid, _client_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.has_permission(auth.uid(), _org_id, 'view_client_directory')
    -- ...or this customer is on the caller's own route.
    OR EXISTS (
      SELECT 1
        FROM public.visits v
        JOIN public.staff s ON s.id = v.assigned_staff_id
       WHERE v.client_id = _client_id
         AND s.user_id = auth.uid()
    );
$$;

COMMENT ON FUNCTION public.may_read_client_row(uuid, uuid) IS
  'Row-local twin of may_read_client for the clients SELECT policy: same rule, but takes the row''s organization_id instead of re-reading public.clients, so INSERT ... RETURNING can see the row it just wrote.';

CREATE OR REPLACE FUNCTION public.may_read_property_row(_org_id uuid, _property_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.has_permission(auth.uid(), _org_id, 'view_client_directory')
    OR EXISTS (
      SELECT 1
        FROM public.visits v
        JOIN public.staff s ON s.id = v.assigned_staff_id
       WHERE v.property_id = _property_id
         AND s.user_id = auth.uid()
    );
$$;

COMMENT ON FUNCTION public.may_read_property_row(uuid, uuid) IS
  'Row-local twin of may_read_property for the properties SELECT policy; see may_read_client_row.';

REVOKE ALL ON FUNCTION public.may_read_client_row(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.may_read_property_row(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.may_read_client_row(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.may_read_property_row(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "Read clients you may see" ON public.clients;
CREATE POLICY "Read clients you may see" ON public.clients
  FOR SELECT USING (public.may_read_client_row(organization_id, id));

DROP POLICY IF EXISTS "Read properties you may see" ON public.properties;
CREATE POLICY "Read properties you may see" ON public.properties
  FOR SELECT USING (public.may_read_property_row(organization_id, id));

-- What this file establishes, provable from any starting state: no SELECT
-- policy on clients or properties re-reads its own table through the old
-- helpers any more.
DO $check$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(tablename || ': ' || policyname, ', ')
    INTO bad
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename IN ('clients', 'properties')
     AND cmd IN ('SELECT', 'ALL')
     AND (qual ~ 'may_read_client\(id\)' OR qual ~ 'may_read_property\(id\)');
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'SELECT policies still re-read their own table: %', bad;
  END IF;
END
$check$;
