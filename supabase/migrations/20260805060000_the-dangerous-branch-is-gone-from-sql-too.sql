-- Deleting the button was not enough.
--
-- `optimize_route_v2(_org_id, _staff_id, _day, _reassign)` selects:
--
--   WHERE ... AND (_reassign OR assigned_staff_id IS NULL
--                            OR assigned_staff_id = _staff_id)
--
-- and then writes `assigned_staff_id = _staff_id` onto every row it selected.
-- With `_reassign => true` the tech filter disappears, so the selection is
-- EVERY scheduled visit in the organization on that date and the write moves
-- all of them to one person. The routes page called exactly this, from a
-- button labelled "Optimize", under text saying it "re-sequences what they
-- already have". No confirm, no preview, no undo.
--
-- The button and its server function are gone. That was not sufficient: the
-- RPC is granted to `authenticated`, so the path stayed one crafted POST away
-- from anyone who can already write to the org. A UI fix for a data-loss path
-- reachable without the UI is not a fix.
--
-- The only surviving caller is visits.functions.ts, which passes
-- `_reassign => false`. The parameter therefore keeps its signature — dropping
-- it would break that call — and the true branch refuses. Deliberately an
-- exception rather than a silent coercion to false: a caller asking for
-- whole-day reassignment should be told it is unavailable, not quietly handed
-- something else and left believing it worked.
--
-- Replaced by preview_optimize / optimize_route_v3, where moving work between
-- techs is opt-in, previewed before it writes, and reports what it skipped.
--
-- ── WHY THIS PATCHES THE LIVE DEFINITION ──────────────────────────────────
--
-- The guard is spliced into `pg_get_functiondef()` rather than restating ~150
-- lines of routing math. Retyping that body is how a "small guard" silently
-- reverts an unrelated fix that landed in it since — and two of them have
-- (timezone anchoring, service-duration integrity). The splice asserts its own
-- success and refuses to install an unguarded copy if the anchor text moves.

DO $mig$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'optimize_route_v2';

  IF _def IS NULL THEN RAISE EXCEPTION 'optimize_route_v2 not found'; END IF;
  IF position('_reassign no longer' in _def) > 0 THEN
    RAISE NOTICE 'already guarded'; RETURN;
  END IF;

  -- After the authorization check, so "not authorized" still wins for a caller
  -- who is both unauthorized and asking for the removed behaviour.
  _def := replace(
    _def,
    'IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION ''Not authorized'';
  END IF;',
    'IF NOT public.can_write_org(auth.uid(), _org_id) THEN
    RAISE EXCEPTION ''Not authorized'';
  END IF;
  IF _reassign THEN
    RAISE EXCEPTION ''_reassign no longer supported: this moved an entire day of visits, across every tech, onto one person. Use optimize_route_v3 with the auto-routing preview.''
      USING ERRCODE = ''feature_not_supported'';
  END IF;'
  );

  IF position('_reassign no longer' in _def) = 0 THEN
    RAISE EXCEPTION 'guard was not inserted — the authorization block did not match, refusing to install an unguarded copy';
  END IF;

  EXECUTE _def;
END
$mig$;

COMMENT ON FUNCTION public.optimize_route_v2(uuid, uuid, date, boolean) IS
  'Legacy single-tech optimizer. _reassign => true is REFUSED: that branch '
  'dropped the tech filter and reassigned every scheduled visit in the org on '
  'that date to one person. Superseded by plan_route/optimize_route_v3.';

-- `assign_route_for_day` lost its only caller when the legacy card went. It is
-- superseded by plan_route/optimize_route_v3 and nothing in the app or in SQL
-- references it, so the grant is withdrawn rather than left as an open RPC.
-- The function itself stays — the eligibility migration's record of why
-- assert_runs_routes exists is written around it.
REVOKE EXECUTE ON FUNCTION public.assign_route_for_day(uuid, uuid, date, boolean) FROM authenticated;
