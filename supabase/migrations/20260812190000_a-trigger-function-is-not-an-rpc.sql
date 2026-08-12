-- A trigger function is not an RPC, and thirty-four of them were granted like one.
--
-- Every function in `public` whose return type is `trigger` — all thirty-four —
-- carried EXECUTE for `authenticated`. They arrived that way, one at a time,
-- because `CREATE FUNCTION` in this schema grants to PUBLIC and the July
-- ALTER DEFAULT PRIVILEGES that was supposed to stop that demonstrably does
-- not (see the-lockdown-that-only-held-for-the-functions-that-existed-that-day).
--
-- The grant buys nothing. Proven on this database in a rolled-back transaction
-- rather than asserted from the documentation, because the whole change rests
-- on it: a temporary table, a SECURITY DEFINER trigger function owned by
-- postgres with EXECUTE revoked from `authenticated`, and an INSERT run as
-- `authenticated`.
--
--   trigger fired with EXECUTE revoked: OK, touched=true
--   direct call refused: permission denied for function _probe_tg
--
-- Which is exactly the shape wanted. Postgres checks EXECUTE on a trigger
-- function when the trigger is CREATED, against the creating role; firing it
-- as part of an INSERT or UPDATE does not re-check it against the caller. So
-- revoking changes nothing about how the application behaves and removes
-- thirty-four entries from the surface a reviewer has to argue with.
--
-- ── WHY BY RETURN TYPE AND NOT BY NAME ────────────────────────────────────
--
-- The security advisor reports twenty-four of these, and the obvious way to
-- act on that is to sweep `tg_%` and `trg_%`. That misses
-- `apply_inventory_movement` and `recalc_visit_station_count`, which are
-- trigger functions that predate the naming convention, and it would have
-- swept up any ordinary function that happened to start with those letters.
-- `prorettype = 'trigger'::regtype` is the actual question.
--
-- The advisor's twenty-four are the SECURITY DEFINER ones, which is the subset
-- it is designed to notice. The other ten — `set_updated_at`,
-- `tg_touch_updated_at`, `tg_client_holds_validate`, `tg_client_notes_touch`,
-- `tg_dogs_name_validate`, `tg_properties_derive_yard_size`,
-- `tg_staff_field_flag`, `tg_waste_stations_number` and the two above — are
-- identical doors that no linter happened to mention. Closing twenty-four and
-- leaving ten because of where a tool's attention fell is how a list stops
-- meaning anything.
--
-- ── THE CHECK THAT MAKES THIS SAFE ────────────────────────────────────────
--
-- Every one of the thirty-four is attached to at least one live, non-internal
-- trigger, verified from `pg_trigger` before the revokes and again after. A
-- `returns trigger` function attached to nothing might be one somebody calls
-- some other way; none of these is. And nothing in `src/` names any of them —
-- checked, including in `.rpc(...)` calls.

do $pre$
declare _n integer; _granted integer; _orphans text;
begin
  select count(*) into _n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype;
  if _n <> 34 then
    raise exception 'expected 34 trigger functions in public, found % — re-read this migration', _n;
  end if;

  select count(*) into _granted
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if _granted <> 34 then
    raise exception 'expected all 34 executable by authenticated, found % — re-read this migration', _granted;
  end if;

  -- A trigger function attached to no trigger is one somebody may be calling
  -- another way. There are none, and this fails rather than guessing if that
  -- ever stops being true.
  select string_agg(p.proname, ', ') into _orphans
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
     and not exists (select 1 from pg_trigger t where t.tgfoid = p.oid and not t.tgisinternal);
  if _orphans is not null then
    raise exception 'trigger function(s) attached to no trigger: % — check what calls them first', _orphans;
  end if;
end $pre$;

revoke all on function public.apply_inventory_movement() from public, anon, authenticated;
revoke all on function public.recalc_visit_station_count() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.tg_ai_usage_rollup() from public, anon, authenticated;
revoke all on function public.tg_client_holds_remove_visits() from public, anon, authenticated;
revoke all on function public.tg_client_holds_validate() from public, anon, authenticated;
revoke all on function public.tg_client_notes_touch() from public, anon, authenticated;
revoke all on function public.tg_client_phone_change_clears_consent() from public, anon, authenticated;
revoke all on function public.tg_clients_enforce_plan_limit() from public, anon, authenticated;
revoke all on function public.tg_clients_gen_referral_code() from public, anon, authenticated;
revoke all on function public.tg_clients_maintain_count() from public, anon, authenticated;
revoke all on function public.tg_credit_ledger_maintain_balance() from public, anon, authenticated;
revoke all on function public.tg_dna_matches_guard_billing() from public, anon, authenticated;
revoke all on function public.tg_dna_matches_guard_delete() from public, anon, authenticated;
revoke all on function public.tg_dna_matches_validate() from public, anon, authenticated;
revoke all on function public.tg_dogs_name_validate() from public, anon, authenticated;
revoke all on function public.tg_dogs_unit_validate() from public, anon, authenticated;
revoke all on function public.tg_franchise_invoice_block_stale_issue() from public, anon, authenticated;
revoke all on function public.tg_franchise_invoice_release_on_void() from public, anon, authenticated;
revoke all on function public.tg_invoice_paid_credit() from public, anon, authenticated;
revoke all on function public.tg_org_referral_conversion() from public, anon, authenticated;
revoke all on function public.tg_orgs_protect_platform_columns() from public, anon, authenticated;
revoke all on function public.tg_orgs_sync_tier_on_plan() from public, anon, authenticated;
revoke all on function public.tg_properties_derive_yard_size() from public, anon, authenticated;
revoke all on function public.tg_property_units_validate() from public, anon, authenticated;
revoke all on function public.tg_set_invoice_due_on() from public, anon, authenticated;
revoke all on function public.tg_staff_field_flag() from public, anon, authenticated;
revoke all on function public.tg_staff_maintain_seat_count() from public, anon, authenticated;
revoke all on function public.tg_subscriptions_trim_after_end() from public, anon, authenticated;
revoke all on function public.tg_touch_updated_at() from public, anon, authenticated;
revoke all on function public.tg_unit_incidents_validate() from public, anon, authenticated;
revoke all on function public.tg_visit_respects_time_off() from public, anon, authenticated;
revoke all on function public.tg_waste_stations_number() from public, anon, authenticated;
revoke all on function public.trg_reassign_billing_tier() from public, anon, authenticated;

do $post$
declare _left text; _fired integer;
begin
  select string_agg(p.proname, ', ') into _left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if _left is not null then
    raise exception 'still reachable by anon or authenticated: %', _left;
  end if;

  -- The triggers themselves are untouched: same count, same functions. This is
  -- a grant change and nothing else.
  select count(*) into _fired
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.trigger'::regtype
     and not t.tgisinternal;
  if _fired < 34 then
    raise exception 'expected at least 34 live triggers after the revokes, found %', _fired;
  end if;
end $post$;
