-- BUG-14 (remaining half): impersonation sessions that nobody explicitly exited
-- never got an end recorded.
--
-- The audit log gets a stop event from endImpersonationSession, which fires
-- when the operator clicks "Exit impersonation". Nothing fires when they simply
-- close the tab — and that is what almost always happens. Live data at the time
-- of writing: 29 start_impersonation, 22 enter_impersonation, and exactly ONE
-- stop_impersonation. Twenty-one sessions had no recorded end at all, and their
-- grants sat with ended_at IS NULL forever, so the table never converged either.
--
-- The session was over regardless — BUG-2's server gate refuses every request
-- once the window closes. Only the RECORD was missing. This closes it.
--
-- What it deliberately does NOT do is fabricate a duration. We observed when the
-- window closed; we did not observe when the operator walked away. So the event
-- carries session_ended_at (a fact) and leaves duration_seconds null
-- (unmeasured), rather than reporting a full-window duration that nobody lived
-- through. Sessions exited by the button still get their real, measured
-- duration from endImpersonationSession — this only fills the gaps.
--
-- The window definition mirrors isSessionWindowOpen() in
-- src/lib/impersonation-session.shared.ts exactly: an explicit
-- session_expires_at when present, otherwise consumed_at + 60 minutes. Every
-- grant that exists today predates the session_expires_at column, so the
-- fallback is the branch that actually runs on the backfill.
--
-- Idempotent: `ended_at IS NULL` in the UPDATE is the guard, re-evaluated under
-- row lock, so a concurrent or repeated run writes exactly one stop event per
-- grant.

create or replace function public.close_abandoned_impersonation_grants()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  _closed integer := 0;
begin
  with closable as (
    select
      id,
      actor_user_id,
      organization_id,
      target_user_id,
      coalesce(session_expires_at, consumed_at + interval '60 minutes') as window_closed_at
    from public.impersonation_grants
    where consumed_at is not null          -- never consumed = never a session
      and ended_at is null
      and coalesce(session_expires_at, consumed_at + interval '60 minutes') <= now()
  ),
  stamped as (
    update public.impersonation_grants g
       set ended_at = c.window_closed_at
      from closable c
     where g.id = c.id
       and g.ended_at is null              -- re-checked under lock; the guard
    returning g.id, c.actor_user_id, c.organization_id, c.target_user_id, c.window_closed_at
  )
  insert into public.platform_admin_audit
    (actor_user_id, organization_id, action, before_json, after_json, created_at)
  select
    s.actor_user_id,
    s.organization_id,
    'stop_impersonation',
    null,
    jsonb_build_object(
      'grant_id',         s.id,
      'target_user_id',   s.target_user_id,
      'target_email',     u.email,
      'ended_reason',     'expired',
      -- Explicitly present and explicitly null: this event knows duration is a
      -- thing it would normally carry, and knows it does not have one.
      'duration_seconds', null,
      'session_ended_at', s.window_closed_at
    ),
    -- Dated when the session actually ended, not when the sweep noticed, so the
    -- log reads in the order events happened.
    s.window_closed_at
  from stamped s
  left join auth.users u on u.id = s.target_user_id;

  get diagnostics _closed = row_count;
  return _closed;
end;
$$;

comment on function public.close_abandoned_impersonation_grants() is
  'Ends impersonation grants whose session window has passed but that were never explicitly exited (the operator closed the tab), and records one stop_impersonation audit event each with session_ended_at and a null duration. Idempotent. Called from the nightly hook.';

-- SECURITY DEFINER and it writes the audit log, so nobody but the cron path
-- gets to call it.
revoke all on function public.close_abandoned_impersonation_grants() from public;
revoke all on function public.close_abandoned_impersonation_grants() from anon;
revoke all on function public.close_abandoned_impersonation_grants() from authenticated;
grant execute on function public.close_abandoned_impersonation_grants() to service_role;
