-- The portal cutoff was only a hidden button.
--
-- Settings → Customer portal has two controls that read like policy: "Allow
-- customers to reschedule themselves", and a change cutoff in hours before the
-- visit. The portal honours both — `VisitRow` in src/lib/portal-ui.tsx hides
-- the Reschedule button when the toggle is off, disables Skip past the cutoff,
-- and prints "Changes allowed until Thursday at 6:00 PM" underneath.
--
-- Neither `portal_reschedule_visit` nor `portal_request_skip` read either
-- setting. Not "read them and applied them loosely" — the words
-- `portal_reschedule_cutoff_hours` and `portal_allow_self_reschedule` did not
-- appear in the body of either function. Everything the owner configured was
-- enforced by which buttons React chose to render, and the RPCs sit behind a
-- session-gated server function that a customer can call directly with the
-- token that is already in their URL bar.
--
-- Probed on the live database in a rolled-back transaction, against real demo
-- rows, on 2026-08-12:
--
--   skip of an IN_PROGRESS visit:                              ACCEPTED, charge=0
--   skip 1 day PAST the 18h cutoff:                            ACCEPTED
--   reschedule with self-reschedule OFF and 1 day past cutoff: ACCEPTED
--
-- The middle one is the money. A skip past the cutoff is a route the office
-- already built, a tech already dispatched, and a slot nobody else can be
-- given at that notice — which is the entire reason the cutoff exists — and it
-- lands as `skip_reason_code = 'customer_requested'`, billed at whatever
-- percentage the org set for that reason, which on every org today is zero.
--
-- The first one is worse in kind if not in money: `status IN ('scheduled',
-- 'in_progress')` let a customer cancel a visit the technician had already
-- started. The tech is in the yard, the visit goes to `skipped`, and the work
-- they are standing in the middle of is now unbilled and unrecorded.
--
-- ── WHY THE DEADLINE IS COMPUTED IN THE ORG'S TIMEZONE ────────────────────
--
-- `visits.scheduled_on` is a `date`. "18 hours before the visit" therefore
-- needs a midnight to count back from, and midnight is a question about a
-- timezone. The browser answered it with the CUSTOMER's — `new Date(s +
-- "T00:00:00")` is local — which is the wrong one twice: it is not the
-- timezone the route is driven in, and it changes when the customer travels.
-- The org's `timezone` column is the answer to "when does this day start for
-- the crew", and `portal_list_upcoming_visits` already uses it that way.
--
-- So the rule moves into `portal_change_deadline(scheduled_on, timezone,
-- cutoff_hours)`, one definition, and the four places that need it call it:
-- the two writers, the vacation hold, and the list — which now returns the
-- deadline as a timestamptz so the browser compares an instant to an instant
-- instead of recomputing the rule in the wrong zone. That is the half of this
-- change that makes the sentence on screen true; the RAISEs are the half that
-- makes it enforced.
--
-- ── THE VACATION HOLD, WHICH WOULD OTHERWISE BE THE WAY ROUND ─────────────
--
-- `portal_request_vacation_hold` skips a date range outright when the org has
-- `portal_auto_apply_changes` on, with no cutoff and the same `in_progress` in
-- its status filter — and it sets `skip_billable = false`, so it is a strictly
-- better deal than the skip button for a customer who has missed the cutoff.
-- Enforcing the cutoff on Skip while leaving that open would be theatre.
--
-- It cannot simply raise, because a two-week hold booked the night before is a
-- reasonable thing to ask for and only its first day is past the cutoff. So it
-- applies to what it may and files a qc_ticket naming the rest: the office
-- sees "3 held, 1 past the change cutoff and left on the schedule" and decides.
-- The returned count is the number ACTUALLY held, which is what the portal's
-- toast already reports, so a partial hold now tells the customer 3 rather
-- than 4. No org has `portal_auto_apply_changes` on today; this closes the
-- bypass before the first one turns it on.
--
-- ── ONE THING FIXED IN PASSING, BECAUSE IT IS THE SAME MISTAKE ────────────
--
-- `portal_reschedule_visit` bounded the new date with `CURRENT_DATE + 1`.
-- CURRENT_DATE is UTC here. At 21:59 in New York it is already tomorrow in
-- UTC, so between 8pm and midnight the date picker offered tomorrow — its
-- minimum is the browser's — and the server answered "Choose a date at least
-- one day in the future" about the date it had just been offered. Now that the
-- org timezone is in scope, both bounds are counted from the org's today.
--
-- ── WHAT THE PROOF AT THE BOTTOM CAN AND CANNOT DO ───────────────────────
--
-- The arithmetic is proved outright: `portal_change_deadline` is a pure
-- function, so $post$ checks it against hand-computed instants including one
-- across a DST boundary, and those checks run identically on an empty
-- database. The BEHAVIOUR is proved by re-running the three probes above
-- inside a subtransaction that is then rolled back by raising and catching —
-- but only if the database happens to contain a client with a portal token and
-- an eligible visit. On a freshly bootstrapped database it has nothing to
-- probe and says so rather than passing quietly.

-- ── what is true before this runs ─────────────────────────────────────────
do $pre$
declare _def text;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'organizations'
       and column_name in ('timezone','portal_reschedule_cutoff_hours','portal_allow_self_reschedule')
     group by table_name having count(*) = 3
  ) then
    raise exception 'organizations is missing the portal cutoff settings this migration enforces';
  end if;

  _def := pg_get_functiondef('public.portal_reschedule_visit(uuid,uuid,date)'::regprocedure);
  if _def like '%portal_reschedule_cutoff_hours%' or _def like '%portal_allow_self_reschedule%' then
    raise exception 'portal_reschedule_visit already reads the portal settings; re-read this migration before applying it';
  end if;

  _def := pg_get_functiondef('public.portal_request_skip(uuid,uuid,text)'::regprocedure);
  if _def not like '%in_progress%' then
    raise exception 'portal_request_skip no longer accepts in_progress; re-read this migration before applying it';
  end if;
  if _def like '%portal_reschedule_cutoff_hours%' then
    raise exception 'portal_request_skip already reads the cutoff; re-read this migration before applying it';
  end if;
end $pre$;

-- ── the rule, in one place ────────────────────────────────────────────────
--
-- Negative hours are clamped rather than trusted: a negative cutoff would mean
-- "changes allowed until after the visit has happened", and the settings form
-- has no business asserting that through this function.
create or replace function public.portal_change_deadline(
  _scheduled_on date,
  _timezone text,
  _cutoff_hours integer
) returns timestamptz
  language sql
  stable
  set search_path to 'public', 'pg_temp'
as $function$
  select (_scheduled_on::timestamp at time zone coalesce(nullif(_timezone, ''), 'UTC'))
       - (greatest(coalesce(_cutoff_hours, 0), 0) * interval '1 hour')
$function$;

comment on function public.portal_change_deadline(date, text, integer) is
  'The instant after which a customer may no longer reschedule or skip a visit: '
  'local midnight of the visit date in the ORG''s timezone, less the org''s '
  'portal_reschedule_cutoff_hours. The single definition of the portal change '
  'cutoff — portal_reschedule_visit, portal_request_skip, '
  'portal_request_vacation_hold and portal_list_upcoming_visits all call it.';

revoke all on function public.portal_change_deadline(date, text, integer) from public, anon;

-- ── reschedule: the toggle and the cutoff both mean something now ─────────
create or replace function public.portal_reschedule_visit(_token uuid, _visit_id uuid, _new_date date)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  _cid uuid; _org uuid; _sub uuid; _old date;
  _tz text; _cut integer; _allow boolean; _today date;
BEGIN
  SELECT c.id, c.organization_id, o.timezone, o.portal_reschedule_cutoff_hours,
         o.portal_allow_self_reschedule
    INTO _cid, _org, _tz, _cut, _allow
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  IF NOT COALESCE(_allow, false) THEN
    RAISE EXCEPTION 'Rescheduling from the portal is turned off for this account. Contact the office';
  END IF;

  SELECT v.subscription_id, v.scheduled_on INTO _sub, _old
    FROM public.visits v
   WHERE v.id = _visit_id AND v.client_id = _cid AND v.status = 'scheduled';
  IF _sub IS NULL THEN RAISE EXCEPTION 'Visit not eligible to reschedule'; END IF;

  IF now() > public.portal_change_deadline(_old, _tz, _cut) THEN
    RAISE EXCEPTION 'This visit is past the change cutoff. Contact the office';
  END IF;

  -- The org's today, not UTC's: see the header. A New York evening is already
  -- tomorrow in UTC, and the date picker's minimum is the customer's tomorrow.
  _today := (now() AT TIME ZONE COALESCE(NULLIF(_tz, ''), 'UTC'))::date;
  IF _new_date < (_today + 1) THEN
    RAISE EXCEPTION 'Choose a date at least one day in the future';
  END IF;
  IF _new_date > (_today + 60) THEN
    RAISE EXCEPTION 'Reschedule window is 60 days';
  END IF;

  IF EXISTS (SELECT 1 FROM public.visits
              WHERE subscription_id = _sub AND scheduled_on = _new_date AND id <> _visit_id) THEN
    RAISE EXCEPTION 'A visit is already scheduled on that date';
  END IF;
  IF EXISTS (SELECT 1 FROM public.invoice_line_items WHERE visit_id = _visit_id) THEN
    RAISE EXCEPTION 'Visit is already invoiced';
  END IF;

  UPDATE public.visits
     SET scheduled_on = _new_date,
         sequence = NULL,
         assigned_staff_id = NULL,
         eta_start = NULL,
         eta_end = NULL,
         travel_km = NULL,
         travel_min = NULL,
         window_violated = false,
         updated_at = now()
   WHERE id = _visit_id;
END; $function$;

revoke all on function public.portal_reschedule_visit(uuid, uuid, date) from public, anon;

-- ── skip: past the cutoff, and mid-visit, are both refusals now ───────────
create or replace function public.portal_request_skip(_token uuid, _visit_id uuid, _reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  _cid uuid; _org uuid; _price integer; _pct integer; _charge integer;
  _tz text; _cut integer; _on date;
BEGIN
  SELECT c.id, c.organization_id, o.timezone, o.portal_reschedule_cutoff_hours
    INTO _cid, _org, _tz, _cut
    FROM public.clients c
    JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;

  -- 'in_progress' is deliberately gone: the tech is standing in the yard.
  SELECT v.scheduled_on INTO _on
    FROM public.visits v
   WHERE v.id = _visit_id AND v.client_id = _cid AND v.status = 'scheduled';
  IF _on IS NULL THEN RAISE EXCEPTION 'Visit not eligible to skip'; END IF;

  IF now() > public.portal_change_deadline(_on, _tz, _cut) THEN
    RAISE EXCEPTION 'This visit is past the change cutoff. Contact the office';
  END IF;

  SELECT s.price_cents INTO _price FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id WHERE v.id = _visit_id;
  SELECT billable_pct INTO _pct FROM public.skip_billing_rules
   WHERE organization_id = _org AND reason_code = 'customer_requested';
  IF _pct IS NULL THEN _pct := 0; END IF;
  _charge := ROUND(COALESCE(_price,0) * _pct / 100.0)::int;
  UPDATE public.visits SET status='skipped',
    skip_reason = COALESCE(NULLIF(trim(_reason),''), 'Customer requested via portal'),
    skip_reason_code='customer_requested', skip_billable=(_charge>0),
    skip_charge_cents=_charge, updated_at=now() WHERE id=_visit_id;
END; $function$;

revoke all on function public.portal_request_skip(uuid, uuid, text) from public, anon;

-- ── vacation hold: applies what it may, reports what it may not ───────────
create or replace function public.portal_request_vacation_hold(_token uuid, _start date, _end date, _reason text)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
DECLARE
  _cid uuid; _org uuid; _n integer := 0; _auto boolean; _allow boolean;
  _tz text; _cut integer; _late integer := 0;
BEGIN
  SELECT c.id, c.organization_id, o.portal_auto_apply_changes, o.portal_allow_vacation_hold,
         o.timezone, o.portal_reschedule_cutoff_hours
    INTO _cid, _org, _auto, _allow, _tz, _cut
    FROM public.clients c JOIN public.organizations o ON o.id = c.organization_id
   WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  IF NOT _allow THEN RAISE EXCEPTION 'Vacation holds are not enabled for this account'; END IF;
  IF _start IS NULL OR _end IS NULL OR _end < _start THEN
    RAISE EXCEPTION 'Invalid date range';
  END IF;
  IF _auto THEN
    -- Same two limits as the Skip button, for the same reasons: a visit the
    -- tech has started is not the customer's to cancel, and a visit past its
    -- cutoff is a route already built.
    UPDATE public.visits SET
      status='skipped',
      skip_reason = COALESCE(NULLIF(trim(_reason),''), 'Vacation hold'),
      skip_reason_code='customer_requested',
      skip_billable = false, skip_charge_cents = 0,
      updated_at = now()
     WHERE client_id = _cid
       AND scheduled_on BETWEEN _start AND _end
       AND status = 'scheduled'
       AND now() <= public.portal_change_deadline(scheduled_on, _tz, _cut);
    GET DIAGNOSTICS _n = ROW_COUNT;

    SELECT count(*) INTO _late
      FROM public.visits v
     WHERE v.client_id = _cid
       AND v.scheduled_on BETWEEN _start AND _end
       AND v.status IN ('scheduled','in_progress');

    IF _late > 0 THEN
      INSERT INTO public.qc_tickets(organization_id, client_id, category, message, status)
      VALUES (_org, _cid, 'other',
        format('Vacation hold %s → %s: %s visit(s) held automatically, %s past the change cutoff and left on the schedule. %s',
               _start, _end, _n, _late, COALESCE(_reason,'')),
        'open');
    END IF;
  ELSE
    INSERT INTO public.qc_tickets(organization_id, client_id, category, message, status)
    VALUES (_org, _cid, 'other',
      format('Vacation hold requested %s → %s. %s', _start, _end, COALESCE(_reason,'')),
      'open');
    _n := 0;
  END IF;
  RETURN _n;
END $function$;

revoke all on function public.portal_request_vacation_hold(uuid, date, date, text) from public, anon;

-- ── the list carries the deadline, so the browser stops deriving it ───────
drop function if exists public.portal_list_upcoming_visits(uuid);

create function public.portal_list_upcoming_visits(_token uuid)
 returns table(visit_id uuid, scheduled_on date, status visit_status, street text, city text,
               postal_code text, eta_start timestamp with time zone, eta_end timestamp with time zone,
               tech_name text, weather_flagged boolean, weather_note text,
               changes_allowed_until timestamp with time zone)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT v.id, v.scheduled_on, v.status, p.street, p.city, p.postal_code,
         v.eta_start, v.eta_end,
         (SELECT split_part(display_name,' ',1) FROM public.staff WHERE id = v.assigned_staff_id),
         COALESCE(v.weather_flagged, false), v.weather_note,
         public.portal_change_deadline(v.scheduled_on, o.timezone, o.portal_reschedule_cutoff_hours)
    FROM public.clients c
    JOIN public.visits v ON v.client_id = c.id
    JOIN public.organizations o ON o.id = c.organization_id
    LEFT JOIN public.properties p ON p.id = v.property_id
   WHERE c.portal_token = _token
     AND v.scheduled_on >= (now() AT TIME ZONE COALESCE(o.timezone, 'UTC'))::date
     AND v.status IN ('scheduled','in_progress')
   ORDER BY v.scheduled_on, v.sequence NULLS LAST
$function$;

revoke all on function public.portal_list_upcoming_visits(uuid) from public, anon;

-- ── proof ────────────────────────────────────────────────────────────────
do $post$
declare
  _d timestamptz;
  _tok uuid; _vid uuid; _org uuid; _verdict text := '';
begin
  -- 1. The arithmetic, against hand-computed instants. Data-free, so this half
  --    runs the same on an empty database.
  _d := public.portal_change_deadline(date '2026-08-14', 'America/New_York', 18);
  if _d <> timestamptz '2026-08-13 06:00:00-04' then
    raise exception 'deadline math: expected 2026-08-13 06:00 EDT, got %', _d;
  end if;
  -- Across the spring-forward boundary: midnight on 8 March 2026 in New York
  -- is EST, and 18 hours before it is 06:00 on the 7th, also EST.
  _d := public.portal_change_deadline(date '2026-03-08', 'America/New_York', 18);
  if _d <> timestamptz '2026-03-07 06:00:00-05' then
    raise exception 'deadline math across DST: expected 2026-03-07 06:00 EST, got %', _d;
  end if;
  -- Chicago is an hour behind New York, and the deadline must move with it.
  if public.portal_change_deadline(date '2026-08-14', 'America/Chicago', 18)
     <> public.portal_change_deadline(date '2026-08-14', 'America/New_York', 18) + interval '1 hour' then
    raise exception 'deadline math does not follow the org timezone';
  end if;
  -- A blank or absent timezone falls back to UTC rather than to the server's.
  if public.portal_change_deadline(date '2026-08-14', null, 0) <> timestamptz '2026-08-14 00:00:00+00' then
    raise exception 'deadline math does not fall back to UTC';
  end if;
  -- Nonsense hours clamp instead of extending the window past the visit.
  if public.portal_change_deadline(date '2026-08-14', 'UTC', -5)
     <> public.portal_change_deadline(date '2026-08-14', 'UTC', 0) then
    raise exception 'a negative cutoff extended the window past midnight';
  end if;

  -- 2. The behaviour, re-running the three probes from the header inside a
  --    subtransaction that is rolled back by raising and catching. Only if
  --    there is something to probe.
  select c.portal_token, v.id, c.organization_id
    into _tok, _vid, _org
    from public.visits v
    join public.clients c on c.id = v.client_id
    join public.organizations o on o.id = c.organization_id
   where c.portal_token is not null and c.active
     and v.status in ('scheduled','in_progress')
     and now() > public.portal_change_deadline(v.scheduled_on, o.timezone, o.portal_reschedule_cutoff_hours)
   order by (v.status = 'scheduled') desc
   limit 1;

  if _tok is null then
    raise notice 'no client with a portal token and a past-cutoff visit: the behavioural half of this proof did not run';
  else
    begin
      begin
        perform public.portal_request_skip(_tok, _vid, 'post-check');
        _verdict := _verdict || 'skip past the cutoff was still accepted; ';
      exception when others then
        if sqlerrm not like 'This visit is past the change cutoff%'
           and sqlerrm not like 'Visit not eligible to skip%' then
          _verdict := _verdict || 'skip refused for the wrong reason: ' || sqlerrm || '; ';
        end if;
      end;

      update public.organizations set portal_allow_self_reschedule = false where id = _org;
      begin
        perform public.portal_reschedule_visit(_tok, _vid, current_date + 7);
        _verdict := _verdict || 'reschedule was accepted with self-reschedule off; ';
      exception when others then
        if sqlerrm not like 'Rescheduling from the portal is turned off%' then
          _verdict := _verdict || 'reschedule refused for the wrong reason: ' || sqlerrm || '; ';
        end if;
      end;

      update public.organizations set portal_allow_self_reschedule = true where id = _org;
      begin
        perform public.portal_reschedule_visit(_tok, _vid, current_date + 7);
        _verdict := _verdict || 'reschedule past the cutoff was still accepted; ';
      exception when others then
        if sqlerrm not like 'This visit is past the change cutoff%'
           and sqlerrm not like 'Visit not eligible to reschedule%' then
          _verdict := _verdict || 'reschedule refused for the wrong reason: ' || sqlerrm || '; ';
        end if;
      end;

      raise exception 'ROLLBACK-PROBE %', _verdict;
    exception when others then
      if sqlerrm like 'ROLLBACK-PROBE%' then
        _verdict := btrim(substr(sqlerrm, 16));
      else
        raise;
      end if;
    end;

    if _verdict <> '' then
      raise exception 'the cutoff is still not enforced: %', _verdict;
    end if;
  end if;
end $post$;
