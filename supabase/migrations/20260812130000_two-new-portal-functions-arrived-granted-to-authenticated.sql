-- The two functions the migration an hour ago created came out granted to
-- `authenticated`, and it did not notice.
--
-- 20260812120000 added `portal_change_deadline` and re-signatured
-- `portal_list_upcoming_visits` (a return-type change is a DROP and a CREATE,
-- whatever it looks like in the file). Both therefore arrived with a fresh
-- ACL: `=X/postgres | postgres=X | authenticated=X | service_role=X`. It
-- revoked PUBLIC and anon, which is what
-- `the-lockdown-that-only-held-for-the-functions-that-existed-that-day` polices
-- and what the July sweep was about — and left `authenticated` in place,
-- because nothing polices that.
--
-- Checked against the catalog afterwards, which is how this was found:
--
--   portal_change_deadline        postgres, service_role, AUTHENTICATED
--   portal_list_upcoming_visits   postgres, service_role, AUTHENTICATED
--   portal_request_skip           postgres, service_role
--   portal_reschedule_visit       postgres, service_role
--   portal_request_vacation_hold  postgres, service_role
--
-- The odd ones out are the two that were touched, which is the whole tell.
--
-- ── WHY IT MATTERS FOR ONE OF THEM AND NOT THE OTHER ─────────────────────
--
-- `portal_list_upcoming_visits` is SECURITY DEFINER and authorizes on nothing
-- but the portal token it is handed. `authenticated` is every signed-in staff
-- user of every tenant on the platform. A token is a secret and staff have no
-- ordinary way to see another tenant's, so this is not an open door — but the
-- door is the point: every other portal RPC is reachable only by
-- `service_role`, behind `requirePortalSession`, and the reason they are is
-- exactly this. One of them being reachable one hop earlier is a difference
-- nobody chose.
--
-- `portal_change_deadline` is arithmetic on three scalars it is given. Leaving
-- it granted would harm nothing. It is revoked anyway, because "this one is
-- harmless" is how the surface grew the last two times, and a rule that has to
-- be argued with per function is not a rule.

do $pre$
declare _n integer;
begin
  select count(*) into _n
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('portal_change_deadline','portal_list_upcoming_visits')
     and grantee = 'authenticated';
  if _n <> 2 then
    raise exception 'expected both new portal functions to be granted to authenticated, found %', _n;
  end if;
end $pre$;

revoke execute on function public.portal_change_deadline(date, text, integer) from authenticated;
revoke execute on function public.portal_list_upcoming_visits(uuid) from authenticated;

do $post$
declare _left text;
begin
  select string_agg(routine_name || ' → ' || grantee, ', ')
    into _left
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name like 'portal\_%'
     and grantee in ('anon','authenticated','PUBLIC');
  if _left is not null then
    raise exception 'a portal_ function is still reachable without service_role: %', _left;
  end if;
end $post$;
