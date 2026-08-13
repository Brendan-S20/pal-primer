-- The rule two migrations ago said `trigger`. Postgres has two kinds.
--
-- `20260812190000_a-trigger-function-is-not-an-rpc.sql` revoked EXECUTE from
-- all thirty-four functions in `public` whose return type is `trigger`, on the
-- argument that a trigger function is not an RPC and the grant buys nothing.
-- The argument is right. The predicate was one type too narrow.
--
-- `prorettype = 'trigger'::regtype` does not match `event_trigger`. It is a
-- separate type, not a variant, so `public.rls_auto_enable()` — an event
-- trigger function that fires on `ddl_command_end` and enables row level
-- security on every new table in `public` — was left executable by
-- `authenticated`. Written the same day, by the same rule, and missed by the
-- rule itself.
--
-- Worth being plain about how it was found, because it says something about
-- the method rather than about this one function: the Supabase advisor lists
-- ninety-one SECURITY DEFINER functions reachable by `authenticated`, which is
-- a number nobody can act on. Classifying them by whether the BODY carries an
-- authorization check turned ninety-one into eighty-four that do, six that are
-- the documented anon allowlist, and one that was neither. That one was this.
--
-- ── WHAT WAS AND WAS NOT ACTUALLY WRONG ──────────────────────────────────
--
-- Not a vulnerability. Probed as `authenticated` before this migration, the
-- call SUCCEEDED and did nothing: `pg_event_trigger_ddl_commands()` returns no
-- rows outside an event-trigger context, so the loop body never runs. That is
-- worth recording precisely because the expectation was the opposite — the
-- documentation says that function may only be called from an event trigger,
-- and the reasonable guess was that a direct call would raise. It does not.
-- "It would error anyway" is therefore NOT the defence here; the defence is
-- that the door should not exist.
--
-- ── PROVEN, NOT ASSUMED, AGAIN ───────────────────────────────────────────
--
-- The previous migration proved that revoking EXECUTE does not stop a row
-- trigger firing. An event trigger is a different mechanism and inherits
-- nothing from that proof, so it was probed on its own terms — revoke inside a
-- transaction, create a table, read `relrowsecurity`, roll back:
--
--   event trigger fired with EXECUTE revoked: RLS enabled = true
--   direct call refused: permission denied for function rls_auto_enable
--
-- The first line is the one that matters. `rls_auto_enable` is what keeps new
-- tables from shipping without RLS, so a revoke that silenced it would be a
-- far worse bug than the one being fixed.

do $pre$
declare _n integer; _granted integer; _attached integer;
begin
  select count(*) into _n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.event_trigger'::regtype;
  if _n <> 1 then
    raise exception 'expected exactly 1 event trigger function in public, found % — re-read this migration', _n;
  end if;

  select count(*) into _granted
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prorettype = 'pg_catalog.event_trigger'::regtype
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if _granted <> 1 then
    raise exception 'expected it to be executable by authenticated, found % — re-read this migration', _granted;
  end if;

  -- Same guard as the row-trigger migration: one attached to nothing might be
  -- one somebody calls another way.
  select count(*) into _attached
    from pg_event_trigger et
    join pg_proc p on p.oid = et.evtfoid
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public';
  if _attached < 1 then
    raise exception 'public.rls_auto_enable is attached to no event trigger; check what calls it first';
  end if;
end $pre$;

revoke all on function public.rls_auto_enable() from public, anon, authenticated;

do $post$
declare _left text; _attached integer;
begin
  select string_agg(p.proname, ', ') into _left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prorettype in ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     and (has_function_privilege('authenticated', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE'));
  if _left is not null then
    raise exception 'trigger or event-trigger function still reachable by anon or authenticated: %', _left;
  end if;

  -- The event trigger itself is untouched. If this migration had detached or
  -- disabled it, every table created afterwards would ship without RLS — the
  -- exact failure `rls_auto_enable` exists to prevent.
  select count(*) into _attached
    from pg_event_trigger et
    join pg_proc p on p.oid = et.evtfoid
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and et.evtenabled <> 'D';
  if _attached < 1 then
    raise exception 'the RLS event trigger is gone or disabled after this migration';
  end if;
end $post$;
