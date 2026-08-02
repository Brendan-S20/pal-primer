-- BUG-12: the client portal skipped today's visit.
--
-- Repro from QA: portal home read "Next: Thu, Jul 30" while a visit existed on
-- Jul 23, the same day the client was looking at it.
--
-- Root cause is the date boundary, not the query shape. portal_list_upcoming_visits
-- filtered on `v.scheduled_on >= CURRENT_DATE`, and CURRENT_DATE resolves in the
-- DATABASE's timezone (UTC), not the organization's. For any org west of UTC the
-- database rolls over to tomorrow while it is still today for the client — a
-- Central-time client looking at the portal after 6/7pm gets CURRENT_DATE =
-- tomorrow, so today's visit falls out of the window and the next weekly visit
-- shows instead. That is precisely a Jul 23 visit disappearing in favour of Jul 30.
--
-- The rest of the codebase already treats the ORG-LOCAL date as authoritative
-- for exactly this reason — admin_transition_missed_visits computes
-- (now() AT TIME ZONE _tz)::date, and src/lib/visit-lifecycle.ts documents that
-- callers must pass the org-local date rather than UTC. This brings the portal
-- onto the same rule instead of adding a second notion of "today".
--
-- Idempotent (CREATE OR REPLACE); signature and return shape unchanged, so no
-- caller changes.
CREATE OR REPLACE FUNCTION public.portal_list_upcoming_visits(_token uuid)
 RETURNS TABLE(visit_id uuid, scheduled_on date, status visit_status, street text, city text, postal_code text, eta_start timestamp with time zone, eta_end timestamp with time zone, tech_name text, weather_flagged boolean, weather_note text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT v.id, v.scheduled_on, v.status, p.street, p.city, p.postal_code,
         v.eta_start, v.eta_end,
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         COALESCE(v.weather_flagged, false), v.weather_note
    FROM public.clients c
    JOIN public.visits v ON v.client_id = c.id
    JOIN public.organizations o ON o.id = c.organization_id
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE c.portal_token = _token
     -- "Today" as the CLIENT experiences it. COALESCE keeps orgs with no
     -- timezone set behaving exactly as before rather than erroring.
     AND v.scheduled_on >= (now() AT TIME ZONE COALESCE(o.timezone, 'UTC'))::date
     AND v.status IN ('scheduled','in_progress')
   ORDER BY v.scheduled_on, v.sequence NULLS LAST
$function$;
