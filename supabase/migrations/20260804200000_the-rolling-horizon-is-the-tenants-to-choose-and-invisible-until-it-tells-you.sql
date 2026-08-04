-- The rolling horizon becomes a tenant setting, and gets a way to speak up.
--
-- ── WHY IT NEEDS TO BE CHOOSABLE ──────────────────────────────────────────
--
-- 90 days suits a weekly residential route. It does not suit everyone: a
-- commercial operator selling annual contracts wants to show a customer next
-- spring, and a two-person outfit that re-prices every month does not want 13
-- weeks of rows to rewrite each time a price moves. The column already existed
-- and was already per-org; nothing surfaced it, so every tenant silently ran
-- on whatever the default happened to be.
--
-- ── WHY IT NEEDS TO ANNOUNCE ITSELF ───────────────────────────────────────
--
-- Removing the "Create visits through <date>" button was right — a recurring
-- plan already says when its visits happen, and pressing a button to make the
-- schedule exist is doing the computer's job. But that button was also the
-- only thing that ever CONFIRMED generation had run. A rolling horizon is
-- invisible by construction: it works perfectly and it looks exactly like
-- nothing happening.
--
-- So the confirmation comes back as a notification instead of a chore. Opt-in,
-- because an org that trusts it should not be told every week, and sent when
-- the horizon rolls into a NEW WEEK rather than nightly — a daily "your
-- schedule moved forward one day" is noise, and noise is how a real warning
-- gets ignored later.
--
-- `schedule_horizon_notified_on` is what makes "once per week" true rather
-- than approximately true. Without it, a job that runs twice in a day, or a
-- retry, sends twice; comparing the stored date's ISO week to the new
-- horizon's is idempotent no matter how often the job fires.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_schedule_horizon boolean NOT NULL DEFAULT false;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS schedule_horizon_notified_on date;

COMMENT ON COLUMN public.organizations.notify_schedule_horizon IS
  'Opt-in: tell the office when the auto-generated schedule reaches into a new week. Restores the confirmation the manual "generate visits" button used to give, without the chore.';

COMMENT ON COLUMN public.organizations.schedule_horizon_notified_on IS
  'The horizon date last announced. Compared by ISO week so a job that runs twice, or retries, cannot send twice.';


-- ── The settings RPC gains both ───────────────────────────────────────────
--
-- DROP first. Postgres overloads on the argument LIST, so adding two defaulted
-- parameters leaves the old 8-argument signature in place and every existing
-- call becomes ambiguous ("function is not unique") — a failure that shows up
-- at call time, not deploy time. This repo has hit that twice.

DROP FUNCTION IF EXISTS public.update_org_dispatch_settings(
  uuid, time without time zone, time without time zone, integer, text, integer, text, integer[]
);

CREATE OR REPLACE FUNCTION public.update_org_dispatch_settings(
  _org_id uuid,
  _workday_start time without time zone DEFAULT NULL,
  _workday_end time without time zone DEFAULT NULL,
  _avg_speed_kmh integer DEFAULT NULL,
  _traffic_profile text DEFAULT NULL,
  _max_drive_minutes integer DEFAULT NULL,
  _timezone text DEFAULT NULL,
  _work_days integer[] DEFAULT NULL,
  _auto_generate_days_ahead integer DEFAULT NULL,
  _notify_schedule_horizon boolean DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _org_id, 'owner')
    OR public.has_role(auth.uid(), _org_id, 'office_manager')
  ) THEN
    RAISE EXCEPTION 'Not authorized to update dispatch settings';
  END IF;
  IF _avg_speed_kmh IS NOT NULL AND (_avg_speed_kmh < 5 OR _avg_speed_kmh > 120) THEN
    RAISE EXCEPTION 'Invalid average speed';
  END IF;
  IF _traffic_profile IS NOT NULL AND _traffic_profile NOT IN ('light', 'normal', 'heavy') THEN
    RAISE EXCEPTION 'Invalid traffic profile';
  END IF;
  IF _max_drive_minutes IS NOT NULL AND (_max_drive_minutes < 15 OR _max_drive_minutes > 1440) THEN
    RAISE EXCEPTION 'Invalid max drive minutes';
  END IF;
  IF _work_days IS NOT NULL AND (
    array_length(_work_days, 1) IS NULL
    OR array_length(_work_days, 1) > 7
    OR EXISTS (SELECT 1 FROM unnest(_work_days) d WHERE d < 0 OR d > 6)
  ) THEN
    RAISE EXCEPTION 'Invalid work days';
  END IF;
  -- Same bounds the CHECK enforces, raised here so the caller gets a sentence
  -- rather than a constraint-violation string.
  IF _auto_generate_days_ahead IS NOT NULL
     AND (_auto_generate_days_ahead < 1 OR _auto_generate_days_ahead > 365) THEN
    RAISE EXCEPTION 'Schedule horizon must be between 1 and 365 days';
  END IF;

  UPDATE public.organizations
     SET workday_start = COALESCE(_workday_start, workday_start),
         workday_end = COALESCE(_workday_end, workday_end),
         avg_speed_kmh = COALESCE(_avg_speed_kmh, avg_speed_kmh),
         traffic_profile = COALESCE(_traffic_profile, traffic_profile),
         max_drive_minutes = COALESCE(_max_drive_minutes, max_drive_minutes),
         timezone = COALESCE(_timezone, timezone),
         work_days = COALESCE(_work_days, work_days),
         auto_generate_days_ahead =
           COALESCE(_auto_generate_days_ahead, auto_generate_days_ahead),
         notify_schedule_horizon =
           COALESCE(_notify_schedule_horizon, notify_schedule_horizon)
   WHERE id = _org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found';
  END IF;
END;
$function$;
