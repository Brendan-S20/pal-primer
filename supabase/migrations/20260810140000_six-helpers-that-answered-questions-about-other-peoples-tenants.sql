-- Six helpers answered questions about tenants the caller had nothing to do with.
--
-- ── WHERE THIS CAME FROM ──────────────────────────────────────────────────
--
-- The security advisor reports 122 `authenticated_security_definer_function_
-- executable` findings. That count is not itself a defect and should not be
-- read as one: a SECURITY DEFINER function callable by a signed-in user is how
-- most of this app works. The advisor is pointing out that such a function
-- bypasses RLS and therefore has to do its own authorization. The only real
-- question is which of the 122 do not.
--
-- Triaged mechanically, then by hand:
--
--     122  executable by `authenticated`, SECURITY DEFINER, in public
--      84  derive the caller's org from auth.uid()            — correct
--      24  return `trigger` — PostgREST cannot call them at all
--       1  `rls_auto_enable` returns `event_trigger`, likewise uncallable
--       6  the deliberate public allowlist (public_quote, roadmap votes,
--          org_accepts_public_leads, the two lead-form lookups)
--       1  `route_segment_km` joins `_plan`, a TEMP table the caller has to
--          build first — it can only ever see rows the caller made itself,
--          which is safe by construction rather than by check
--     ───
--       6  accept an id, and answer without asking whose it is
--
-- ── PROVEN, NOT ARGUED ────────────────────────────────────────────────────
--
-- As the owner of one org, against ids belonging to another, in a rolled-back
-- transaction:
--
--     is_staff_off(other org's staff)         -> false
--     assert_runs_routes(other org's staff)   -> returned, did not raise
--     assert_available_on(other org's staff)  -> returned, did not raise
--     client_may_be_texted(other org's client)-> false
--     org_has_commercial_data(other org)      -> TRUE
--     drive_minutes(other org's id)           -> 40.2341007
--
-- ── HOW BAD, HONESTLY ─────────────────────────────────────────────────────
--
-- Low, and worth saying so plainly rather than dressing it up. Every one is a
-- scalar read; none writes anything. Five of the six need a uuid belonging to
-- another tenant — a staff id or a client id — which is not guessable and is
-- not disclosed anywhere, so an attacker needs to have already obtained one.
--
-- `org_has_commercial_data` is the exception and the reason this is being
-- fixed now rather than filed. Its argument is an ORG id, and an org id is
-- obtainable: `public_get_org_by_slug` returns `o.id` for any org with
-- `public_signup_enabled = true`. So for those orgs the chain needs no guessing
-- at all — slug in, org id out, then a true/false answer about whether a
-- competitor runs commercial accounts, units, waste stations or DNA
-- enrolment. Small, but it is a fact about someone else's business obtained
-- with nothing but a signed-in account and their public signup link.
--
-- ── TWO REMEDIES, BECAUSE THERE ARE TWO KINDS OF FUNCTION HERE ────────────
--
-- FIVE are internal helpers. Nothing in `src/` calls them by RPC, and every
-- in-database caller — optimize_route_v3, plan_route, preview_optimize,
-- assign_route_for_day, bulk_reassign_visits, reassign_visit,
-- route_cost_current, tg_visit_respects_time_off — is itself SECURITY DEFINER
-- owned by `postgres`. A SECURITY DEFINER function calls out as its definer,
-- so EXECUTE is checked against `postgres`, not against whoever called in.
-- Revoking `authenticated` therefore removes the RPC surface and changes
-- nothing internally. `$post$` asserts that ownership property rather than
-- assuming it, because it is the entire reason the revoke is safe.
--
-- TWO are live app API, called from server functions with the USER'S bearer
-- token — `context.supabase` in src/lib/*.functions.ts is built from the
-- publishable key plus `Authorization: Bearer <token>`, so it acts as
-- `authenticated`, not as service_role. Revoking those would break the
-- /my-day texting-consent check and the commercial-accounts feature gate.
-- They get a membership guard instead.
--
-- The guard is `auth.uid() IS NULL OR is_org_member(auth.uid(), <org>)`, which
-- is the shape the helpers in this schema already use. The NULL arm is not an
-- oversight: cron and service_role callers have no `auth.uid()`, and a check
-- that fails closed on them would break the scheduled work. For a real signed
-- -in caller `auth.uid()` is present and membership decides.
--
-- Both return `false` for a non-member rather than raising. They are read as
-- booleans by a feature gate and a consent check, and "no" is the correct
-- answer to "may I text a client I cannot see".
--
-- ── NOT DONE HERE ─────────────────────────────────────────────────────────
--
-- The advisor will still report all 122, because it flags the shape and not
-- the reasoning, and 116 of them are the shape working as intended. This
-- migration does not chase that number down; it fixes the six that were
-- actually wrong. `rls_enabled_no_policy` (8, fail-closed and correct),
-- `extension_in_public` (pg_net, whose callables live in schema `net` that
-- PostgREST does not expose) and `auth_leaked_password_protection` (a
-- dashboard toggle) remain as previously triaged.

-- ── BEFORE ────────────────────────────────────────────────────────────────

do $pre$
declare
  _orgA uuid; _orgB uuid; _uidA uuid; _clientA uuid; _clientB uuid;
  _same_texted boolean; _same_commercial boolean;
  _cross text := ''; _r text; _bad text := '';
  _fn text;
  _revoke text[] := array['is_staff_off','assert_runs_routes','assert_available_on',
                          'drive_minutes','route_segment_km'];
begin
  -- Every helper this migration touches must currently be reachable by
  -- `authenticated`; if one is already revoked the file is being re-applied
  -- against a database it does not describe.
  foreach _fn in array _revoke || array['client_may_be_texted','org_has_commercial_data'] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = _fn
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      _bad := _bad || ' ' || _fn;
    end if;
  end loop;
  if _bad <> '' then
    raise exception 'expected these to be executable by authenticated before the change:%', _bad;
  end if;

  -- The property that makes revoking safe: every in-database caller reaches
  -- these as its own definer, not as the web caller.
  select coalesce(string_agg(p.proname, ', '), '') into _bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('optimize_route_v3','plan_route','preview_optimize','assign_route_for_day',
                       'bulk_reassign_visits','reassign_visit','route_cost_current',
                       'tg_visit_respects_time_off','set_org_commercial_accounts')
     and not (p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres');
  if _bad <> '' then
    raise exception 'these callers are not SECURITY DEFINER owned by postgres, so revoking would break them: %', _bad;
  end if;

  select organization_id into _orgA from public.staff where user_id is not null
   group by 1 order by count(*) desc limit 1;
  select user_id into _uidA from public.user_roles where organization_id = _orgA and role = 'owner' limit 1;
  select id into _orgB from public.organizations where id <> _orgA
   and exists (select 1 from public.clients c where c.organization_id = organizations.id) limit 1;
  select id into _clientA from public.clients where organization_id = _orgA limit 1;
  select id into _clientB from public.clients where organization_id = _orgB limit 1;

  if _uidA is null or _orgB is null or _clientA is null or _clientB is null then
    raise exception 'the probe needs two orgs with clients and an owner — A=% B=% uid=%',
      _orgA, _orgB, _uidA;
  end if;

  create temporary table _xt_before(k text primary key, v text) on commit drop;
  insert into _xt_before values ('orgA', _orgA::text), ('orgB', _orgB::text),
                                ('uidA', _uidA::text), ('clientA', _clientA::text),
                                ('clientB', _clientB::text);

  perform set_config('request.jwt.claims',
    json_build_object('sub', _uidA, 'role', 'authenticated')::text, true);

  -- Same tenant: whatever these answer now, they must answer after.
  select public.client_may_be_texted(_clientA)    into _same_texted;
  select public.org_has_commercial_data(_orgA)    into _same_commercial;
  insert into _xt_before values ('same_texted', _same_texted::text),
                                ('same_commercial', _same_commercial::text);

  -- Cross tenant: recorded so $post$ can show the answer changed.
  select public.client_may_be_texted(_clientB)::text into _r;
  _cross := 'client_may_be_texted=' || coalesce(_r, 'null');
  select public.org_has_commercial_data(_orgB)::text into _r;
  _cross := _cross || ' org_has_commercial_data=' || coalesce(_r, 'null');
  insert into _xt_before values ('cross', _cross);

  perform set_config('request.jwt.claims', '', true);
  raise notice 'before: same-tenant texted=% commercial=%; cross-tenant %',
    _same_texted, _same_commercial, _cross;
end $pre$;

-- ── THE FIVE INTERNAL HELPERS LOSE THEIR RPC SURFACE ──────────────────────
--
-- `anon` was already revoked from all five by
-- 20260809180000_the-lockdown-that-only-held-for-the-functions-that-existed-
-- that-day.sql, and PUBLIC does not appear in their ACLs, so `authenticated`
-- is the whole of what is left. The target shape is the one
-- `admin_generate_addon_charges_through` already has:
-- `postgres=X/postgres | service_role=X/postgres`.

revoke execute on function public.is_staff_off(uuid, date) from authenticated;
revoke execute on function public.assert_runs_routes(uuid) from authenticated;
revoke execute on function public.assert_available_on(uuid, date) from authenticated;
revoke execute on function public.drive_minutes(
  uuid, double precision, double precision, double precision, double precision) from authenticated;
revoke execute on function public.route_segment_km(
  uuid[], double precision, double precision) from authenticated;

-- ── THE TWO THAT ARE APP API GET A GUARD ──────────────────────────────────

-- Guard placed inside the EXISTS, against the client's OWN organization_id, so
-- it reads as one question: is this a client I can see, and may it be texted.
create or replace function public.client_may_be_texted(_client_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = _client_id
       AND (auth.uid() IS NULL OR public.is_org_member(auth.uid(), c.organization_id))
       AND c.sms_opt_out = false
       AND COALESCE(c.comms_paused, false) = false
       AND c.sms_consent_at IS NOT NULL
       AND c.primary_phone IS NOT NULL
       AND public.phone_digits(c.primary_phone)
           IS NOT DISTINCT FROM public.phone_digits(c.sms_consent_phone)
  );
$function$;

-- The chainable one: its argument is an org id, and org ids are handed out by
-- public_get_org_by_slug for any org with public signup enabled.
create or replace function public.org_has_commercial_data(_org_id uuid)
 returns boolean
 language sql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
  SELECT (auth.uid() IS NULL OR public.is_org_member(auth.uid(), _org_id))
     AND (
       EXISTS (SELECT 1 FROM public.clients c
                WHERE c.organization_id = _org_id AND c.account_type = 'commercial')
    OR EXISTS (SELECT 1 FROM public.properties p
                WHERE p.organization_id = _org_id
                  AND (p.account_type = 'commercial' OR p.has_units))
    OR EXISTS (SELECT 1 FROM public.property_units u WHERE u.organization_id = _org_id)
    OR EXISTS (SELECT 1 FROM public.waste_stations w WHERE w.organization_id = _org_id)
    OR EXISTS (SELECT 1 FROM public.clients c
                WHERE c.organization_id = _org_id AND c.dna_compliance_enabled)
     );
$function$;

-- CREATE OR REPLACE keeps the existing ACL, so these two stay executable by
-- `authenticated` — which is the point. Asserted below rather than assumed,
-- because a replace that silently reset the grant would take the /my-day
-- consent check and the commercial gate down with it.

-- The convention from 20260809180000, enforced per FILE by
-- tests/the-lockdown-that-only-held-for-the-functions-that-existed-that-day:
-- anything a migration creates carries its own REVOKE. That test failed on the
-- first draft of this file and was right to.
--
-- Both statements above are CREATE OR REPLACE of a function that already
-- existed, so each inherits an ACL with no anon in it — checked live after
-- applying: `postgres=X | authenticated=X | service_role=X`, and
-- has_function_privilege('anon', ...) is false for both. These two REVOKEs are
-- therefore no-ops today, and are written anyway, because the rule refuses on
-- purpose to tell a replace from a signature change. Adding one argument makes
-- a NEW object with a fresh ACL, and that one does arrive executable by the key
-- in the browser bundle. A no-op now is the price of the rule still holding on
-- the day someone adds a parameter.
revoke execute on function public.client_may_be_texted(uuid) from public, anon;
revoke execute on function public.org_has_commercial_data(uuid) from public, anon;

-- ── AFTER ─────────────────────────────────────────────────────────────────

do $post$
declare
  _orgA uuid; _orgB uuid; _uidA uuid; _clientA uuid; _clientB uuid;
  _fn text; _bad text := ''; _r boolean;
  _revoke text[] := array['is_staff_off','assert_runs_routes','assert_available_on',
                          'drive_minutes','route_segment_km'];
begin
  select v::uuid into _orgA    from _xt_before where k = 'orgA';
  select v::uuid into _orgB    from _xt_before where k = 'orgB';
  select v::uuid into _uidA    from _xt_before where k = 'uidA';
  select v::uuid into _clientA from _xt_before where k = 'clientA';
  select v::uuid into _clientB from _xt_before where k = 'clientB';

  -- 1. The five are off the RPC surface.
  foreach _fn in array _revoke loop
    if exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = _fn
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      _bad := _bad || ' ' || _fn;
    end if;
  end loop;
  if _bad <> '' then
    raise exception 'still executable by authenticated:%', _bad;
  end if;

  -- ...and service_role kept its grant, or the scheduled work stops.
  foreach _fn in array _revoke loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = _fn
         and has_function_privilege('service_role', p.oid, 'EXECUTE')
    ) then
      _bad := _bad || ' ' || _fn;
    end if;
  end loop;
  if _bad <> '' then
    raise exception 'service_role lost EXECUTE on:%', _bad;
  end if;

  -- 2. The two guarded ones are still app-reachable.
  foreach _fn in array array['client_may_be_texted','org_has_commercial_data'] loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = _fn
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    ) then
      _bad := _bad || ' ' || _fn;
    end if;
  end loop;
  if _bad <> '' then
    raise exception 'the replace dropped the authenticated grant on:%', _bad;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('sub', _uidA, 'role', 'authenticated')::text, true);

  -- 3. Same tenant is untouched — the whole risk of a guard is that it also
  --    denies the people it was meant to serve.
  select public.client_may_be_texted(_clientA) into _r;
  if _r::text is distinct from (select v from _xt_before where k = 'same_texted') then
    raise exception 'client_may_be_texted changed for the caller''s OWN client: % -> %',
      (select v from _xt_before where k = 'same_texted'), _r;
  end if;
  select public.org_has_commercial_data(_orgA) into _r;
  if _r::text is distinct from (select v from _xt_before where k = 'same_commercial') then
    raise exception 'org_has_commercial_data changed for the caller''s OWN org: % -> %',
      (select v from _xt_before where k = 'same_commercial'), _r;
  end if;

  -- 4. Cross tenant now answers no.
  select public.client_may_be_texted(_clientB) into _r;
  if _r then raise exception 'client_may_be_texted still answers about another tenant'; end if;
  select public.org_has_commercial_data(_orgB) into _r;
  if _r then raise exception 'org_has_commercial_data still answers about another tenant'; end if;

  -- 5. And the service-role arm still works, or cron breaks silently.
  perform set_config('request.jwt.claims', '', true);
  if public.org_has_commercial_data(_orgB) is null then
    raise exception 'org_has_commercial_data returned null with no auth.uid()';
  end if;

  raise notice 'after: five revoked from authenticated, two guarded; own tenant unchanged, other tenant denied; was %',
    (select v from _xt_before where k = 'cross');
end $post$;
