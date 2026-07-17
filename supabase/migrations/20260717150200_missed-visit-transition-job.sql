-- QA round 3, finding B6 (part 1): background job that transitions genuinely
-- past, never-serviced scheduled visits to the terminal 'missed' status.
--
-- Idempotent & safe to retry (I12): only touches visits still in the
-- pre-service 'scheduled' state whose date is strictly in the past. It never
-- touches completed/skipped/canceled/missed visits, and re-running finds
-- nothing to do. Ambiguous records are LEFT for human review (I5):
--   * scheduled TODAY (scheduled_on = CURRENT_DATE) — may still be serviced.
--   * a partial start (started_at IS NOT NULL on a 'scheduled' row) — the tech
--     began but never completed; that is an in-flight anomaly, not a miss.
--   * 'in_progress' past visits — same, surfaced for review, not swept here.
-- The CURRENT_DATE (UTC) cutoff mirrors the platform Health "stuck visits"
-- detection query exactly. Stale route ETAs are cleared because a missed visit
-- had no service and its pre-computed arrival window is moot (this also clears
-- the B6 "absurd 4 AM window" left on these historical rows). Missed visits are
-- NOT billable — billing keys on 'completed' and billable 'skipped' only, so no
-- historical billing is altered (I6).
CREATE OR REPLACE FUNCTION public.admin_transition_missed_visits(_org_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _n integer;
BEGIN
  UPDATE public.visits
     SET status = 'missed',
         eta_start = NULL,
         eta_end = NULL,
         window_violated = false,
         updated_at = now()
   WHERE organization_id = _org_id
     AND status = 'scheduled'
     AND scheduled_on < CURRENT_DATE
     AND started_at IS NULL;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$function$;

-- Same posture as admin_generate_visits_through: internal to the service-role
-- nightly worker; never callable by app users.
REVOKE EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_transition_missed_visits(uuid) TO service_role;

-- ── One-time reconciliation of the known-stuck backlog (I5: repair the 42) ────
DO $$
DECLARE _org record; _total integer := 0; _n integer;
BEGIN
  FOR _org IN SELECT id FROM public.organizations LOOP
    _n := public.admin_transition_missed_visits(_org.id);
    _total := _total + _n;
  END LOOP;
  RAISE NOTICE 'B6 reconciliation: transitioned % past scheduled visits to missed', _total;
END $$;
