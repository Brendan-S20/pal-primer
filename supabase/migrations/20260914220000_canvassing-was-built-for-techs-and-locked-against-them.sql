-- ---------------------------------------------------------------------------
-- Neighbor canvassing was built for technicians and denied to them by RLS.
--
-- Reported from an iPhone: "As a technician... I can't select a client to go
-- off of for neighbors/doors, and if I enter an address to be a lead I receive
-- an error."
--
-- `neighbor_leads` carried exactly one policy, FOR ALL, USING and WITH CHECK
-- both `has_permission(auth.uid(), organization_id, 'view_client_directory')`.
-- A technician holds only `record_field_addons`, so that predicate is false for
-- them on every command:
--
--   SELECT  the list comes back empty
--   INSERT  adding a door raises  <- the reported error
--   UPDATE  the walk mode's Interested / Not interested do nothing
--   DELETE  blocked
--
-- ── WHY THIS IS THE POLICY'S BUG AND NOT THE PRODUCT'S ─────────────────────
--
-- Everything else in the stack already treats canvassing as field work done by
-- the person standing on the street:
--
--   * ROUTE_ROLES grants /neighbors to "tech", and the sidebar shows it to them
--   * listNeighborLeads computes `canSeeDirectory` and NULLs seed_client_id and
--     seed_client_name when the caller lacks it -- code that only has a purpose
--     if a caller without directory access is expected to reach these rows
--   * addNeighborLead resolves the caller with resolveMemberOrgId, which checks
--     membership and no permission at all
--   * the page has a walk mode whose own comment describes "a tech pressing
--     Interested" on a phone at a door
--
-- Four places were written for a technician. The policy was never widened to
-- agree with them, so the feature has been unreachable for the role it was
-- designed around.
--
-- ── WHAT A TECHNICIAN MAY NOW DO, AND WHAT THEY STILL MAY NOT ──────────────
--
-- Read, add and update canvassing leads for their own organization. A
-- canvassing lead is the address of somebody who is NOT a customer, written
-- down by the person who walked past the house; withholding it from that person
-- protects nothing.
--
-- DELETE stays behind view_client_directory. It is the one destructive command
-- here, it is how a day's canvassing disappears, and the office has the screen
-- for it. That is a narrowing of the old policy for techs, not a widening: they
-- could not delete before either.
--
-- The client's IDENTITY is still not theirs to see. seed_client_id and
-- seed_client_name are stripped in listNeighborLeads for any caller without
-- directory access, and `clients` keeps its own RLS, so the embedded join comes
-- back null for a tech regardless of what this file says. Two independent
-- layers, which is the point.
-- ---------------------------------------------------------------------------

ALTER TABLE public.neighbor_leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "neighbor leads: whoever may see the client directory"
  ON public.neighbor_leads;

-- Read: any member of the organization. The office sees seed attribution, a
-- tech does not, and that difference is enforced in the server function rather
-- than here -- a policy cannot null one column of a row it admits.
DROP POLICY IF EXISTS "neighbor leads: any member may read" ON public.neighbor_leads;
CREATE POLICY "neighbor leads: any member may read"
  ON public.neighbor_leads FOR SELECT
  USING (public.is_org_member((SELECT auth.uid()), organization_id));

-- Write: any member, for their own organization only. The WITH CHECK is what
-- stops a member of one tenant writing a row tagged to another.
DROP POLICY IF EXISTS "neighbor leads: any member may add a door" ON public.neighbor_leads;
CREATE POLICY "neighbor leads: any member may add a door"
  ON public.neighbor_leads FOR INSERT
  WITH CHECK (public.is_org_member((SELECT auth.uid()), organization_id));

DROP POLICY IF EXISTS "neighbor leads: any member may record an answer" ON public.neighbor_leads;
CREATE POLICY "neighbor leads: any member may record an answer"
  ON public.neighbor_leads FOR UPDATE
  USING (public.is_org_member((SELECT auth.uid()), organization_id))
  WITH CHECK (public.is_org_member((SELECT auth.uid()), organization_id));

-- Delete: unchanged in substance -- still the directory holders.
DROP POLICY IF EXISTS "neighbor leads: the office may delete" ON public.neighbor_leads;
CREATE POLICY "neighbor leads: the office may delete"
  ON public.neighbor_leads FOR DELETE
  USING (public.has_permission((SELECT auth.uid()), organization_id, 'view_client_directory'));

-- ---------------------------------------------------------------------------
-- What this migration ESTABLISHES, provable from any starting state, so these
-- are exceptions rather than warnings.
-- ---------------------------------------------------------------------------

DO $est$
DECLARE
  _cmds text;
  _all  int;
BEGIN
  SELECT count(*) INTO _all
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'neighbor_leads' AND p.polcmd = '*';
  IF _all > 0 THEN
    RAISE EXCEPTION 'neighbor_leads still carries a FOR ALL policy; the four commands are meant to be separable now';
  END IF;

  SELECT string_agg(DISTINCT p.polcmd::text, ',' ORDER BY p.polcmd::text) INTO _cmds
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
   WHERE c.relname = 'neighbor_leads';
  -- r = SELECT, a = INSERT, w = UPDATE, d = DELETE
  IF _cmds IS DISTINCT FROM 'a,d,r,w' THEN
    RAISE EXCEPTION 'neighbor_leads policies cover % — expected one each of SELECT, INSERT, UPDATE, DELETE', coalesce(_cmds, 'nothing');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'neighbor_leads' AND p.polcmd = 'd'
       AND pg_get_expr(p.polqual, p.polrelid) LIKE '%view_client_directory%'
  ) THEN
    RAISE EXCEPTION 'the DELETE policy on neighbor_leads no longer requires view_client_directory';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
     WHERE c.relname = 'neighbor_leads' AND p.polcmd IN ('r', 'a', 'w')
       AND coalesce(pg_get_expr(p.polqual, p.polrelid), '')
           || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') LIKE '%view_client_directory%'
  ) THEN
    RAISE EXCEPTION 'reading, adding or updating a canvassing lead still requires view_client_directory — that is the bug this file exists to fix';
  END IF;

  RAISE NOTICE 'canvassing: read/add/update are org membership, delete stays with the client directory';
END
$est$;

-- ---------------------------------------------------------------------------
-- What the live database looked like when this was written. A fresh build has
-- none of it, so this warns and never fails.
-- ---------------------------------------------------------------------------

DO $premise$
DECLARE
  _rows  bigint;
  _orgs  bigint;
  _techs bigint;
BEGIN
  SELECT count(*), count(DISTINCT organization_id) INTO _rows, _orgs FROM public.neighbor_leads;
  SELECT count(*) INTO _techs FROM public.user_roles WHERE role = 'tech';

  IF _rows = 0 THEN
    RAISE WARNING 'canvassing: SKIPPED the before count — no leads in this database, which is what a fresh build looks like';
  ELSE
    RAISE WARNING 'canvassing: % leads across % organization(s), and % technician(s) who could not read, add or update any of them until now (2026-09-14: 23, 1, 7)',
      _rows, _orgs, _techs;
  END IF;
END
$premise$;
