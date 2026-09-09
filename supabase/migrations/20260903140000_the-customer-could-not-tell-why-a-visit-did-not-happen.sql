-- "Skipped: dog went for me twice, couldn't get near the bins"
--
-- ── WHAT THE CUSTOMER SAW ─────────────────────────────────────────────────
--
-- The portal printed `visit_photos`-style raw text: `Skipped: {skip_reason}`,
-- where `skip_reason` is the free-text field a technician types in the field.
-- `skipVisit` requires it -- 1 to 500 characters, typed by whoever was
-- standing at the gate -- alongside a structured `skip_reason_code` from a
-- fixed vocabulary. The office surfaces mostly render the CODE
-- (`skip_reason_code ?? skip_reason`); the customer got the rawest version.
--
-- Nothing marks that text internal, and nobody writing it is thinking about a
-- customer reading it.
--
-- ── AND THE CODE, WHICH IS THE ANSWER, WAS NOT RETURNED AT ALL ────────────
--
-- `skip_reason_code` is exactly what a customer wants: a reason, from a list,
-- that says why their yard was not done. The RPC never selected it, so the
-- page had only the free text and either printed it or said nothing.
--
-- Both now come back. What the page does with each is its business, and the
-- rule it applies is in portal-ui.tsx: the CODE always, phrased for the person
-- whose yard it is; the free text only when the customer wrote it themselves
-- from the portal, which is the one case where it is their own words.
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE ─────────────────────────────────────
--
-- The status filter. `completed` and `skipped` only: a customer sees the
-- visits that happened and the ones that were called off with a reason, and
-- not the ones the nightly job marked `missed`. A missed visit is an
-- operational state -- nobody has decided yet whether it was weather, a
-- forgotten close-out, or work that genuinely did not happen -- and putting
-- 2,001 of them in front of customers would be presenting an unanswered
-- question as a fact about their service.
-- DROP first: this adds a column to the returned row, and CREATE OR REPLACE
-- cannot change a return type. 20260903130000 learned that the expensive way.
DROP FUNCTION IF EXISTS public.portal_list_recent_visits(uuid);

CREATE OR REPLACE FUNCTION public.portal_list_recent_visits(_token uuid)
RETURNS TABLE(visit_id uuid, scheduled_on date, status visit_status, photo_paths text[],
              photo_kinds text[], tech_name text, completed_at timestamp with time zone,
              skip_reason text, skip_reason_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT v.id, v.scheduled_on, v.status,
         COALESCE(ARRAY(
           SELECT vp.storage_path FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at, vp.id
         ), ARRAY[]::text[]),
         COALESCE(ARRAY(
           SELECT vp.kind::text FROM public.visit_photos vp
             WHERE vp.visit_id = v.id ORDER BY vp.created_at, vp.id
         ), ARRAY[]::text[]),
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         v.completed_at, v.skip_reason, v.skip_reason_code::text
    FROM public.visits v
    JOIN public.clients c ON c.id = v.client_id
   WHERE c.portal_token = _token AND c.active = true
     AND v.status IN ('completed','skipped')
   ORDER BY v.scheduled_on DESC
   LIMIT 30
$function$;

REVOKE ALL ON FUNCTION public.portal_list_recent_visits(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_recent_visits(uuid) TO service_role;

DO $est$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_list_recent_visits';
  _src := regexp_replace(_src, '--[^\n]*', '', 'g');

  IF _src NOT LIKE '%v.skip_reason_code::text%' THEN
    RAISE EXCEPTION 'portal_list_recent_visits still does not return the reason code';
  END IF;

  -- The filter is a decision, not an accident, so it is asserted rather than
  -- left to the next person to infer from what the page happens to render.
  IF _src NOT LIKE '%v.status IN (''completed'',''skipped'')%' THEN
    RAISE EXCEPTION 'portal_list_recent_visits no longer restricts what a customer sees to completed and skipped visits';
  END IF;
END $est$;
