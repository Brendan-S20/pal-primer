-- Two policies, one question, every row.
--
-- ── WHAT THE ADVISOR FOUND ────────────────────────────────────────────────
--
-- 48 `multiple_permissive_policies` findings, which resolve to 43 colliding
-- pairs of policies across 38 tables. A permissive policy is an OR: when two
-- of them apply to the same role and the same command, Postgres evaluates
-- BOTH for every row it touches and takes either. Neither can be skipped,
-- because until both have been evaluated it is not known which one let the
-- row through.
--
-- Nobody wrote a duplicate on purpose. The shape came from a convention this
-- schema follows almost everywhere: a read policy and a write policy per
-- table.
--
--     create policy "Members read visits"  ... for select using (is_org_member(...));
--     create policy "Managers write visits" ... for all    using (can_write_org(...));
--
-- `FOR ALL` means all four commands, and that includes SELECT. So the second
-- policy — written to describe who may WRITE — silently joined the read path,
-- and every read of `visits` called `can_write_org()` once per row on top of
-- `is_org_member()`, to arrive at a set of rows the first policy had already
-- returned in full.
--
-- ── WHAT IT COSTS, MEASURED ───────────────────────────────────────────────
--
-- On `visits`, as an owner of the largest org, 3,013 rows visible. Four
-- passes in a rolled-back transaction, alternating which shape went first so
-- neither one always got the warm cache:
--
--     select count(*) from public.visits;
--       two SELECT policies   104.5 ms
--       one SELECT policy      89.1 ms
--
-- Fifteen percent, and fifteen percent is what it is worth — not more. The
-- redundant call is one SECURITY DEFINER lookup per row; the scan itself is
-- still most of the time. What makes it worth doing anyway is the same thing
-- that made the `auth.uid()` wrapping worth doing (20260809200000): the cost
-- is linear in rows scanned and is paid on every read, by every tenant, on 38
-- tables.
--
-- ── THE FIX, AND WHY IT IS TWO FIXES AND NOT ONE ──────────────────────────
--
-- The obvious move is to narrow `FOR ALL` to `FOR INSERT / UPDATE / DELETE`
-- and let the read policy own SELECT alone. That is right for 32 of the 38
-- tables and wrong for 6, and the difference is not cosmetic.
--
-- It is only safe when every row the write policy would have shown is a row
-- the read policy shows anyway — when the write predicate is a SUBSET of the
-- read predicate. That happens to hold across the 32 because of how the
-- helpers nest: `can_write_org` and `has_permission` both require a
-- `user_roles` row in the org, so both are subsets of `is_org_member`; and
-- `may_read_client` / `may_read_property` admit exactly the three roles
-- `can_write_org` admits, via `view_client_directory`. Not assumed — proved
-- below, and re-proved on every environment this is applied to.
--
-- On 6 tables it does not hold, and narrowing would have quietly removed
-- access:
--
--   * `org_platform_addons` and `platform_org_feature_flags` are read by org
--     members through the read policy and by PLATFORM ADMINS through the
--     write policy. A platform admin is not an org member. Narrowing would
--     have blanked those rows in the platform console.
--   * `platform_announcements` is readable while it is live; `platform_plans`
--     while it is active. An admin's `FOR ALL` policy is what lets them see
--     the expired announcement and the retired plan — which are precisely the
--     rows they open in order to edit them.
--   * `platform_announcement_reads`: the SELECT policy is admins-only and the
--     `FOR ALL` policy is own-rows-only. Neither contains the other.
--   * `visits` collides twice — on SELECT, where the read policy does cover
--     the write policy, and on UPDATE between "Managers write visits" and
--     "Techs update own visits", where a manager is not a tech and a tech is
--     not a manager.
--
-- For those six the two policies are MERGED into one whose predicate is the
-- OR of both, which is what Postgres was computing anyway — the same answer,
-- reached once instead of twice.
--
-- ── TWO TABLES DELIBERATELY GET NO `(insert)` POLICY ──────────────────────
--
-- `inventory_movements` and `waste_disposal_manifests` already carry a
-- dedicated INSERT policy checking `is_org_member`, which is strictly wider
-- than the `can_write_org` in the FOR ALL policy. Splitting the FOR ALL into
-- all three commands would have recreated the duplicate on INSERT — the exact
-- finding this migration exists to remove — while granting nobody anything.
-- So the split there produces UPDATE and DELETE only.
--
-- ── HOW EQUIVALENCE IS ESTABLISHED ────────────────────────────────────────
--
-- Not by argument. `$pre$` walks every caller the database actually has — 11
-- role holders, 1 platform admin, and anon — and records, for each of the 38
-- tables and each of the four commands, how many rows that caller can reach
-- under the OR of every policy that applies. `$post$` recomputes the same
-- numbers against the rewritten policies and requires every one of them to be
-- identical. A merge that dropped a disjunct, a split that took SELECT away
-- from someone who needed it, or a typo in a hand-written OR all show up as a
-- changed count and abort the migration.
--
-- Run against production while writing this: 416 subset checks on the 32, and
-- 312 reachability counts on the 6. Nothing moved.
--
-- ── A SMALL TRAP WORTH RECORDING ──────────────────────────────────────────
--
-- Policy names are identifiers, so Postgres truncates them at 63 bytes. The
-- first draft named two of the `org_platform_addons` policies
-- "...written by org billing or a platform admin (insert)" and "(update)";
-- both truncated to the same 63 bytes and the second CREATE failed with
-- "already exists" — pointing at a name that appears nowhere in the file.
-- Every name here is under 58 bytes.
--
-- ── OUT OF SCOPE ──────────────────────────────────────────────────────────
--
-- The advisor's other two findings are untouched: 27 `unused_index`, and the
-- 78 `unindexed_foreign_keys` left after 20260809210000 indexed the 15 that
-- carry a cascading delete. Neither is about policies and both want their own
-- before/after.

-- ── BEFORE ────────────────────────────────────────────────────────────────

do $pre$
declare
  _tables text[] := array[
    'accounting_sync_log','addon_charges','addon_services','addon_subscriptions',
    'app_notification_prefs','blackout_dates','client_holds','clients','dogs',
    'import_batches','import_rows','inventory_assignments','inventory_items',
    'inventory_movements','invoice_line_items','invoices','locations',
    'org_platform_addons','platform_addons','platform_announcement_reads',
    'platform_announcements','platform_feature_flags','platform_org_feature_flags',
    'platform_plans','platform_referral_settings','properties','property_units',
    'qc_tickets','staff','staff_time_off','station_service_logs','subscriptions',
    'unit_incidents','visits','waste_disposal_facilities','waste_disposal_manifests',
    'waste_stations','zones'];
  _kinds text[] := array['select','insert','update','delete'];
  t text; k text; _u uuid; _expr text; _n bigint;
  _pairs int; _tabs int; _pols int; _subset bigint := 0; _checked int := 0;
begin
  -- The collision rule, stated once and reused in $post$: two PERMISSIVE
  -- policies on one table collide when their command sets intersect and their
  -- role sets intersect. `public` is not a role beside the others — it is all
  -- of them — so it intersects everything. Getting that wrong undercounts by
  -- exactly the six tables whose read and write policies were granted to
  -- different role names.

  -- Temp objects outlive a rolled-back statement inside the same session, so
  -- a retry after a failed assertion would otherwise trip over its own debris.
  drop view if exists _mpp_collisions;
  drop table if exists _mpp_reach;

  create temporary view _mpp_collisions as
  with pol as (
    select tablename, policyname, roles,
           case when cmd = 'ALL' then array['SELECT','INSERT','UPDATE','DELETE']
                else array[cmd] end as cmds
      from pg_policies
     where schemaname = 'public' and permissive = 'PERMISSIVE'
  )
  select a.tablename, a.policyname as p1, b.policyname as p2
    from pol a join pol b
      on a.tablename = b.tablename and a.policyname < b.policyname
     and a.cmds && b.cmds
     and (a.roles && b.roles or 'public' = any(a.roles) or 'public' = any(b.roles));

  select count(*), count(distinct tablename) into _pairs, _tabs from _mpp_collisions;
  select count(*) into _pols from pg_policies where schemaname = 'public';

  -- ── A SNAPSHOT OF THE DATABASE THIS RAN AGAINST, NOT A CLAIM ───────────
  --
  -- 43, 38 and 150 were MEASURED on the live database on 2026-08-10, and this
  -- block is the "before" half of a before/after proof. That is the right
  -- instrument for applying a change to production and the wrong one for a
  -- replay from empty, which is the eighth fault the Sandboxes run found.
  --
  -- A fresh build's "before" state is whatever the 200-odd earlier migrations
  -- produced, and the count only equals production's if production's policy
  -- set came entirely from these files. Seven faults so far say it did not:
  -- a table, a function, three more functions and a cron job all reached the
  -- live database without a migration describing them.
  --
  -- Warnings, therefore, and warnings that still print the numbers — the
  -- measurement is the point, and an operator reading the log gets it either
  -- way. The assertions that survive as exceptions are in $post$ below, and
  -- they are the ones that state a property of THIS CHANGE rather than of the
  -- database it happened to meet: no colliding pair remains, no reachability
  -- moved, no policy calls an auth function outside a scalar subquery. Those
  -- hold on any starting state, so a replay can prove them.
  if _pairs <> 43 or _tabs <> 38 then
    raise warning 'expected 43 colliding policy pairs over 38 tables, found % over % — not the database this was written against',
      _pairs, _tabs;
  end if;
  if _pols <> 150 then
    raise warning 'expected 150 policies in public, found % — not the database this was written against', _pols;
  end if;

  -- Capture reachability for every caller the database has.
  create temporary table _mpp_reach(phase text, tbl text, kind text, who text, n bigint)
    on commit drop;

  for _u in select distinct user_id from public.user_roles
            union select user_id from public.platform_admins
            union select null::uuid
  loop
    perform set_config('request.jwt.claims',
      case when _u is null then ''
           else json_build_object('sub', _u, 'role', 'authenticated')::text end, true);
    foreach t in array _tables loop
      foreach k in array _kinds loop
        select coalesce('(' || string_agg('(' || coalesce(
                 case when k = 'insert' then with_check else qual end, 'true') || ')', ' or ') || ')',
                 'false')
          into _expr
          from pg_policies
         where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE'
           and cmd in ('ALL', upper(k));
        execute format('select count(*) from public.%I where coalesce(%s,false)', t, _expr) into _n;
        insert into _mpp_reach values ('before', t, k, coalesce(left(_u::text, 8), 'anon'), _n);
      end loop;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- The 32 rest on one claim: the write policy shows nothing the read policy
  -- does not. Counted here rather than reasoned about, per caller, per table.
  for _u in select distinct user_id from public.user_roles
            union select user_id from public.platform_admins
            union select null::uuid
  loop
    perform set_config('request.jwt.claims',
      case when _u is null then ''
           else json_build_object('sub', _u, 'role', 'authenticated')::text end, true);
    foreach t in array array[
      'accounting_sync_log','addon_charges','addon_services','addon_subscriptions',
      'app_notification_prefs','blackout_dates','client_holds','clients','dogs',
      'import_batches','import_rows','inventory_assignments','inventory_items',
      'inventory_movements','invoice_line_items','invoices','locations',
      'platform_addons','platform_feature_flags','platform_referral_settings',
      'properties','property_units','qc_tickets','staff','staff_time_off',
      'station_service_logs','subscriptions','unit_incidents',
      'waste_disposal_facilities','waste_disposal_manifests','waste_stations','zones']
    loop
      execute format(
        'select count(*) from public.%I where coalesce(%s,false) and not coalesce(%s,false)',
        t,
        (select qual from pg_policies where schemaname='public' and tablename=t and cmd='ALL'),
        (select qual from pg_policies where schemaname='public' and tablename=t and cmd='SELECT')
      ) into _n;
      _subset := _subset + _n;
      _checked := _checked + 1;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- ── THE SAMPLE SIZE IS A PROPERTY OF THE DATA, NOT OF THE SCHEMA ───────
  --
  -- This guard exists because "no rows are reachable only through a write
  -- policy" passes trivially when there are no rows, and it was right to write
  -- it. 300 comes from ~10 callers × 32 tables on the live database.
  --
  -- A database built from these files has NO callers: user_roles and
  -- platform_admins are both empty, so the loop runs once for the anonymous
  -- case and _checked is 32. The check is genuinely vacuous there — and
  -- saying so is what this guard was for. Refusing to apply is not.
  if _checked < 300 then
    raise warning 'the subset check evaluated only % pairs — too few callers in this database to mean anything', _checked;
  end if;
  if _subset <> 0 then
    raise exception '% rows are reachable only through a write policy; narrowing it would remove them',
      _subset;
  end if;

  raise notice 'before: % policies, % colliding pairs, % subset checks clean, % reachability counts',
    _pols, _pairs, _checked, (select count(*) from _mpp_reach);
end $pre$;

-- ── THE 32 WHERE THE READ POLICY ALREADY COVERED THE WRITE POLICY ─────────
--
-- `FOR ALL` narrowed to the three commands it was written for. The SELECT
-- side of it disappears, and nothing goes with it. The USING and WITH CHECK
-- expressions are carried over unchanged — an INSERT policy takes only a WITH
-- CHECK, a DELETE policy only a USING, and UPDATE takes both, which is
-- exactly how Postgres was already applying the FOR ALL policy per command.

drop policy "Managers write sync log" on public.accounting_sync_log;
create policy "Managers write sync log (insert)" on public.accounting_sync_log
  for insert to authenticated
  with check (can_write_org((select auth.uid()), org_id));
create policy "Managers write sync log (update)" on public.accounting_sync_log
  for update to authenticated
  using (can_write_org((select auth.uid()), org_id))
  with check (can_write_org((select auth.uid()), org_id));
create policy "Managers write sync log (delete)" on public.accounting_sync_log
  for delete to authenticated
  using (can_write_org((select auth.uid()), org_id));

drop policy "addon_charges writable by billing managers" on public.addon_charges;
create policy "addon_charges writable by billing managers (insert)" on public.addon_charges
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "addon_charges writable by billing managers (update)" on public.addon_charges
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "addon_charges writable by billing managers (delete)" on public.addon_charges
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

-- Granted TO public rather than TO authenticated, as it was. anon still fails
-- closed: has_permission(NULL, ...) finds no user_roles row.
drop policy "Managers write addon services" on public.addon_services;
create policy "Managers write addon services (insert)" on public.addon_services
  for insert to public
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "Managers write addon services (update)" on public.addon_services
  for update to public
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "Managers write addon services (delete)" on public.addon_services
  for delete to public
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

drop policy "addon_subs writable by billing managers" on public.addon_subscriptions;
create policy "addon_subs writable by billing managers (insert)" on public.addon_subscriptions
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "addon_subs writable by billing managers (update)" on public.addon_subscriptions
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "addon_subs writable by billing managers (delete)" on public.addon_subscriptions
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

drop policy app_notification_prefs_upsert_own on public.app_notification_prefs;
create policy "app_notification_prefs_upsert_own (insert)" on public.app_notification_prefs
  for insert to public
  with check ((user_id = (select auth.uid())));
create policy "app_notification_prefs_upsert_own (update)" on public.app_notification_prefs
  for update to public
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));
create policy "app_notification_prefs_upsert_own (delete)" on public.app_notification_prefs
  for delete to public
  using ((user_id = (select auth.uid())));

drop policy "blackout write" on public.blackout_dates;
create policy "blackout write (insert)" on public.blackout_dates
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "blackout write (update)" on public.blackout_dates
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "blackout write (delete)" on public.blackout_dates
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy client_holds_write on public.client_holds;
create policy "client_holds_write (insert)" on public.client_holds
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "client_holds_write (update)" on public.client_holds
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "client_holds_write (delete)" on public.client_holds
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- clients / dogs / properties: the read side is may_read_client /
-- may_read_property, which admit `view_client_directory` holders — owner,
-- office_manager and dispatcher — which is exactly the role set can_write_org
-- admits. Subset, so SELECT loses nothing.
drop policy "Managers write clients" on public.clients;
create policy "Managers write clients (insert)" on public.clients
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write clients (update)" on public.clients
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write clients (delete)" on public.clients
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "Managers write dogs" on public.dogs;
create policy "Managers write dogs (insert)" on public.dogs
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write dogs (update)" on public.dogs
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write dogs (delete)" on public.dogs
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "org write import_batches" on public.import_batches;
create policy "org write import_batches (insert)" on public.import_batches
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write import_batches (update)" on public.import_batches
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write import_batches (delete)" on public.import_batches
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "org write import_rows" on public.import_rows;
create policy "org write import_rows (insert)" on public.import_rows
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write import_rows (update)" on public.import_rows
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write import_rows (delete)" on public.import_rows
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "Managers write inventory assignments" on public.inventory_assignments;
create policy "Managers write inventory assignments (insert)" on public.inventory_assignments
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write inventory assignments (update)" on public.inventory_assignments
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write inventory assignments (delete)" on public.inventory_assignments
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "Managers write inventory items" on public.inventory_items;
create policy "Managers write inventory items (insert)" on public.inventory_items
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write inventory items (update)" on public.inventory_items
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write inventory items (delete)" on public.inventory_items
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- No `(insert)` here: "Members write inventory movements" already checks
-- is_org_member on INSERT, which is wider than can_write_org. Adding one
-- would re-create the very duplicate being removed.
drop policy "Managers manage inventory movements" on public.inventory_movements;
create policy "Managers manage inventory movements (update)" on public.inventory_movements
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers manage inventory movements (delete)" on public.inventory_movements
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "line items writable via parent invoice" on public.invoice_line_items;
create policy "line items writable via parent invoice (insert)" on public.invoice_line_items
  for insert to authenticated
  with check ((exists (select 1 from invoices i
                        where ((i.id = invoice_line_items.invoice_id)
                          and has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))));
create policy "line items writable via parent invoice (update)" on public.invoice_line_items
  for update to authenticated
  using ((exists (select 1 from invoices i
                   where ((i.id = invoice_line_items.invoice_id)
                     and has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))))
  with check ((exists (select 1 from invoices i
                        where ((i.id = invoice_line_items.invoice_id)
                          and has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))));
create policy "line items writable via parent invoice (delete)" on public.invoice_line_items
  for delete to authenticated
  using ((exists (select 1 from invoices i
                   where ((i.id = invoice_line_items.invoice_id)
                     and has_permission((select auth.uid()), i.organization_id, 'manage_client_billing'::text)))));

drop policy "invoices writable by billing managers" on public.invoices;
create policy "invoices writable by billing managers (insert)" on public.invoices
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "invoices writable by billing managers (update)" on public.invoices
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));
create policy "invoices writable by billing managers (delete)" on public.invoices
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_client_billing'::text));

drop policy "Managers write locations" on public.locations;
create policy "Managers write locations (insert)" on public.locations
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write locations (update)" on public.locations
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write locations (delete)" on public.locations
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- The catalog tables: read is `true` for any authenticated user, so the
-- admin's FOR ALL policy was contributing nothing at all to SELECT.
drop policy "platform admins manage platform addons" on public.platform_addons;
create policy "platform admins manage platform addons (insert)" on public.platform_addons
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "platform admins manage platform addons (update)" on public.platform_addons
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "platform admins manage platform addons (delete)" on public.platform_addons
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

drop policy "Platform admins manage flag catalog" on public.platform_feature_flags;
create policy "Platform admins manage flag catalog (insert)" on public.platform_feature_flags
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage flag catalog (update)" on public.platform_feature_flags
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage flag catalog (delete)" on public.platform_feature_flags
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

drop policy "platform admins manage referral settings" on public.platform_referral_settings;
create policy "platform admins manage referral settings (insert)" on public.platform_referral_settings
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "platform admins manage referral settings (update)" on public.platform_referral_settings
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "platform admins manage referral settings (delete)" on public.platform_referral_settings
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

drop policy "Managers write properties" on public.properties;
create policy "Managers write properties (insert)" on public.properties
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write properties (update)" on public.properties
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "Managers write properties (delete)" on public.properties
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy property_units_write on public.property_units;
create policy "property_units_write (insert)" on public.property_units
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "property_units_write (update)" on public.property_units
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "property_units_write (delete)" on public.property_units
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "qc write" on public.qc_tickets;
create policy "qc write (insert)" on public.qc_tickets
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "qc write (update)" on public.qc_tickets
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "qc write (delete)" on public.qc_tickets
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "Managers write staff" on public.staff;
create policy "Managers write staff (insert)" on public.staff
  for insert to public
  with check (has_permission((select auth.uid()), organization_id, 'manage_users'::text));
create policy "Managers write staff (update)" on public.staff
  for update to public
  using (has_permission((select auth.uid()), organization_id, 'manage_users'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_users'::text));
create policy "Managers write staff (delete)" on public.staff
  for delete to public
  using (has_permission((select auth.uid()), organization_id, 'manage_users'::text));

drop policy staff_time_off_write on public.staff_time_off;
create policy "staff_time_off_write (insert)" on public.staff_time_off
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_users'::text));
create policy "staff_time_off_write (update)" on public.staff_time_off
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_users'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_users'::text));
create policy "staff_time_off_write (delete)" on public.staff_time_off
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_users'::text));

drop policy "org write station logs" on public.station_service_logs;
create policy "org write station logs (insert)" on public.station_service_logs
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write station logs (update)" on public.station_service_logs
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write station logs (delete)" on public.station_service_logs
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- manage_pricing is held by owner and office_manager; view_client_directory,
-- which the read policy asks for, is held by those two and dispatcher.
drop policy "subscriptions: priced by whoever sets pricing" on public.subscriptions;
create policy "subscriptions: priced by whoever sets pricing (insert)" on public.subscriptions
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));
create policy "subscriptions: priced by whoever sets pricing (update)" on public.subscriptions
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));
create policy "subscriptions: priced by whoever sets pricing (delete)" on public.subscriptions
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));

drop policy unit_incidents_write on public.unit_incidents;
create policy "unit_incidents_write (insert)" on public.unit_incidents
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "unit_incidents_write (update)" on public.unit_incidents
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "unit_incidents_write (delete)" on public.unit_incidents
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "org write facilities" on public.waste_disposal_facilities;
create policy "org write facilities (insert)" on public.waste_disposal_facilities
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write facilities (update)" on public.waste_disposal_facilities
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write facilities (delete)" on public.waste_disposal_facilities
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- No `(insert)` — "org members log manifests" already covers INSERT more
-- widely, for the same reason as inventory_movements above.
drop policy "org write manifests" on public.waste_disposal_manifests;
create policy "org write manifests (update)" on public.waste_disposal_manifests
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write manifests (delete)" on public.waste_disposal_manifests
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "org write stations" on public.waste_stations;
create policy "org write stations (insert)" on public.waste_stations
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write stations (update)" on public.waste_stations
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id))
  with check (can_write_org((select auth.uid()), organization_id));
create policy "org write stations (delete)" on public.waste_stations
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

drop policy "Pricing managers write zones" on public.zones;
create policy "Pricing managers write zones (insert)" on public.zones
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));
create policy "Pricing managers write zones (update)" on public.zones
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text))
  with check (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));
create policy "Pricing managers write zones (delete)" on public.zones
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_pricing'::text));

-- ── THE 6 WHERE IT DID NOT, AND THE POLICIES ARE MERGED INSTEAD ───────────
--
-- Every merged predicate below is the OR of the two that collided. That is
-- not a widening: it is the disjunction Postgres was already computing across
-- two policies, written down once so it is computed once.

-- Read by the org OR by a platform admin — the admin came in through the
-- FOR ALL policy and is not an org member, so a plain split would have blanked
-- the platform console's view of every tenant's add-ons. The two write
-- policies merge for the same reason: they collided with each other on all
-- four commands, not just with the read policy.
drop policy "org members read own platform addons" on public.org_platform_addons;
drop policy "billing managers manage own platform addons" on public.org_platform_addons;
drop policy "platform admins manage org platform addons" on public.org_platform_addons;
create policy "org platform addons read by the org or a platform admin" on public.org_platform_addons
  for select to authenticated
  using (is_org_member((select auth.uid()), organization_id)
         or is_platform_admin((select auth.uid())));
create policy "org platform addons written by billing or admin (insert)" on public.org_platform_addons
  for insert to authenticated
  with check (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text)
              or is_platform_admin((select auth.uid())));
create policy "org platform addons written by billing or admin (update)" on public.org_platform_addons
  for update to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text)
         or is_platform_admin((select auth.uid())))
  with check (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text)
              or is_platform_admin((select auth.uid())));
create policy "org platform addons written by billing or admin (delete)" on public.org_platform_addons
  for delete to authenticated
  using (has_permission((select auth.uid()), organization_id, 'manage_org_billing'::text)
         or is_platform_admin((select auth.uid())));

-- Admins-only SELECT beside own-rows-only FOR ALL. Neither contains the
-- other, so both halves survive into the read predicate; the writes stay
-- own-rows-only, which is what the FOR ALL policy said.
drop policy "Platform admins read all reads" on public.platform_announcement_reads;
drop policy "Users manage own reads" on public.platform_announcement_reads;
create policy "Announcement reads are read by their owner or an admin" on public.platform_announcement_reads
  for select to authenticated
  using ((user_id = (select auth.uid())) or is_platform_admin((select auth.uid())));
create policy "Users manage own reads (insert)" on public.platform_announcement_reads
  for insert to authenticated
  with check ((user_id = (select auth.uid())));
create policy "Users manage own reads (update)" on public.platform_announcement_reads
  for update to authenticated
  using ((user_id = (select auth.uid())))
  with check ((user_id = (select auth.uid())));
create policy "Users manage own reads (delete)" on public.platform_announcement_reads
  for delete to authenticated
  using ((user_id = (select auth.uid())));

-- Live to everyone, and always visible to an admin — who otherwise could not
-- see the expired announcement they are about to edit.
drop policy "Any auth user reads active announcements" on public.platform_announcements;
drop policy "Platform admins manage announcements" on public.platform_announcements;
create policy "Announcements are read while live, and always by an admin" on public.platform_announcements
  for select to authenticated
  using (((starts_at <= now()) and ((ends_at is null) or (ends_at > now())))
         or is_platform_admin((select auth.uid())));
create policy "Platform admins manage announcements (insert)" on public.platform_announcements
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage announcements (update)" on public.platform_announcements
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage announcements (delete)" on public.platform_announcements
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

drop policy "Members read own org flags" on public.platform_org_feature_flags;
drop policy "Platform admins manage org flags" on public.platform_org_feature_flags;
create policy "Org flags are read by that org or by a platform admin" on public.platform_org_feature_flags
  for select to authenticated
  using ((exists (select 1 from user_roles ur
                   where ur.user_id = (select auth.uid())
                     and ur.organization_id = platform_org_feature_flags.organization_id))
         or is_platform_admin((select auth.uid())));
create policy "Platform admins manage org flags (insert)" on public.platform_org_feature_flags
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage org flags (update)" on public.platform_org_feature_flags
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage org flags (delete)" on public.platform_org_feature_flags
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

-- Same shape as announcements: `is_active` for everyone, everything for an
-- admin, who needs to reach the retired plan in order to un-retire it.
drop policy "Any auth user reads active plans" on public.platform_plans;
drop policy "Platform admins manage plans" on public.platform_plans;
create policy "Plans are read while active, and always by an admin" on public.platform_plans
  for select to authenticated
  using (is_active or is_platform_admin((select auth.uid())));
create policy "Platform admins manage plans (insert)" on public.platform_plans
  for insert to authenticated
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage plans (update)" on public.platform_plans
  for update to authenticated
  using (is_platform_admin((select auth.uid())))
  with check (is_platform_admin((select auth.uid())));
create policy "Platform admins manage plans (delete)" on public.platform_plans
  for delete to authenticated
  using (is_platform_admin((select auth.uid())));

-- visits collided twice. On SELECT the read policy covers the write policy,
-- so INSERT and DELETE simply narrow. On UPDATE they do not overlap at all —
-- a manager is not a tech, a tech is not can_write_org — so those two merge.
-- "Members read visits" is untouched and still covers both, which is what
-- lets an UPDATE ... RETURNING keep working for either of them.
drop policy "Managers write visits" on public.visits;
drop policy "Techs update own visits" on public.visits;
create policy "Managers write visits (insert)" on public.visits
  for insert to authenticated
  with check (can_write_org((select auth.uid()), organization_id));
create policy "A visit is updated by a manager or by the tech assigned" on public.visits
  for update to authenticated
  using (can_write_org((select auth.uid()), organization_id)
         or (has_role((select auth.uid()), organization_id, 'tech'::app_role)
             and (assigned_staff_id in (select staff.id from staff
                                         where staff.user_id = (select auth.uid())))))
  with check (can_write_org((select auth.uid()), organization_id)
              or (has_role((select auth.uid()), organization_id, 'tech'::app_role)
                  and (assigned_staff_id in (select staff.id from staff
                                              where staff.user_id = (select auth.uid())))));
create policy "Managers write visits (delete)" on public.visits
  for delete to authenticated
  using (can_write_org((select auth.uid()), organization_id));

-- ── AFTER ─────────────────────────────────────────────────────────────────

do $post$
declare
  _tables text[] := array[
    'accounting_sync_log','addon_charges','addon_services','addon_subscriptions',
    'app_notification_prefs','blackout_dates','client_holds','clients','dogs',
    'import_batches','import_rows','inventory_assignments','inventory_items',
    'inventory_movements','invoice_line_items','invoices','locations',
    'org_platform_addons','platform_addons','platform_announcement_reads',
    'platform_announcements','platform_feature_flags','platform_org_feature_flags',
    'platform_plans','platform_referral_settings','properties','property_units',
    'qc_tickets','staff','staff_time_off','station_service_logs','subscriptions',
    'unit_incidents','visits','waste_disposal_facilities','waste_disposal_manifests',
    'waste_stations','zones'];
  _kinds text[] := array['select','insert','update','delete'];
  t text; k text; _u uuid; _expr text; _n bigint;
  _pairs int; _pols int; _all int; _moved text; _compared int;
begin
  select count(*) into _pairs from _mpp_collisions;
  if _pairs <> 0 then
    select string_agg(format('%s: %s + %s', tablename, p1, p2), '; ') into _moved
      from _mpp_collisions;
    raise exception 'still % colliding policy pairs — %', _pairs, _moved;
  end if;

  select count(*) into _pols from pg_policies where schemaname = 'public';
  select count(*) into _all  from pg_policies where schemaname = 'public' and cmd = 'ALL';
  -- Snapshots, for the reason set out in $pre$: 222 and 15 are totals over
  -- every policy in `public`, most of which this migration never touches, so
  -- they describe the database of 2026-08-10 rather than this change. The
  -- assertion immediately above — no colliding pair remains — is the one that
  -- states what this file DOES, and it stays an exception.
  if _pols <> 222 then
    raise warning 'expected 222 policies in public after the rewrite, found % — not the database this was written against', _pols;
  end if;
  if _all <> 15 then
    raise warning 'expected 15 FOR ALL policies to survive (on tables that never collided), found %', _all;
  end if;

  for _u in select distinct user_id from public.user_roles
            union select user_id from public.platform_admins
            union select null::uuid
  loop
    perform set_config('request.jwt.claims',
      case when _u is null then ''
           else json_build_object('sub', _u, 'role', 'authenticated')::text end, true);
    foreach t in array _tables loop
      foreach k in array _kinds loop
        select coalesce('(' || string_agg('(' || coalesce(
                 case when k = 'insert' then with_check else qual end, 'true') || ')', ' or ') || ')',
                 'false')
          into _expr
          from pg_policies
         where schemaname = 'public' and tablename = t and permissive = 'PERMISSIVE'
           and cmd in ('ALL', upper(k));
        execute format('select count(*) from public.%I where coalesce(%s,false)', t, _expr) into _n;
        insert into _mpp_reach values ('after', t, k, coalesce(left(_u::text, 8), 'anon'), _n);
      end loop;
    end loop;
  end loop;
  perform set_config('request.jwt.claims', '', true);

  -- 1000 is ~10 callers × 38 tables × 4 kinds on the live database. A fresh
  -- build has one caller — the anonymous one — and 152 counts, which is not a
  -- weaker version of the same evidence, it is no evidence. Saying so is what
  -- this guard is for.
  --
  -- The comparison BELOW stays an exception, and is the reason this whole
  -- apparatus exists: if any reachability count moved, the rewrite changed
  -- who can see what. It is not weakened by an empty database — with no rows
  -- there is simply nothing that can differ — so it can never report a false
  -- pass as a real one, and on production it is exactly as strict as before.
  select count(*) into _compared from _mpp_reach where phase = 'before';
  if _compared < 1000 then
    raise warning 'only % reachability counts captured — too few callers in this database for the comparison to mean anything', _compared;
  end if;

  select string_agg(format('%s/%s for %s: %s -> %s', b.tbl, b.kind, b.who, b.n, a.n), '; ')
    into _moved
    from _mpp_reach b join _mpp_reach a
      on a.phase = 'after' and a.tbl = b.tbl and a.kind = b.kind and a.who = b.who
   where b.phase = 'before' and b.n is distinct from a.n;

  if _moved is not null then
    raise exception 'reachability changed for someone — %', _moved;
  end if;

  -- The rule from 20260809200000 still holds for everything written above.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~* 'auth\.(uid|jwt|role|email)\s*\(\s*\)'
       and regexp_replace(coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                          '\(\s*SELECT\s+auth\.(uid|jwt|role|email)\s*\(\s*\)[^)]*\)', '', 'gi')
           ~* 'auth\.(uid|jwt|role|email)\s*\(\s*\)'
  ) then
    raise exception 'a policy now calls an auth function outside a scalar subquery';
  end if;

  drop view _mpp_collisions;
  raise notice 'after: % policies, 0 colliding pairs, % reachability counts identical',
    _pols, _compared;
end $post$;
