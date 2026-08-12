-- The crew says "Station 3". The portal said whatever was in the label column.
--
-- BUG-10 dropped `NOT NULL` from `waste_stations.label`, and the note in the
-- brief says exactly why: the junk placeholder labels an import had left behind
-- were structurally impossible to clear, and "every reader in the app already
-- treated the column as optional — `stationDisplayName(1, null)` → "Station 1"
-- — only the schema disagreed."
--
-- Every reader but one. `portal_list_stations` never returned
-- `station_number`, so the customer portal could not call that helper and
-- renders `{s.label}` on its own. After BUG-10 that is a heading which can be
-- empty: a station with no label is a blank line in the customer's list, with
-- its location description hanging underneath belonging to nothing.
--
-- The office and the field both name stations through `stationDisplayName`.
-- The customer is the third party to that conversation — they are the one who
-- says "the bin by the west gate hasn't been emptied" — and they were the only
-- one holding a different set of names.
--
-- ── THE ORDER, WHICH IS THE HALF THAT MISLEADS ───────────────────────────
--
-- `listStations` (staff) orders sort_order → station_number → label. This one
-- ordered sort_order → label. Where the two disagree the lists disagree about
-- which bin is which: on a live demo property today, station_number runs 3, 2,
-- 1 against sort_order 1, 2, 3, so the tech's "station 3" is the customer's
-- first row. Now ordered identically, and since the number is returned the
-- customer can read it rather than count.
--
-- ── CAPACITY, WHICH NOBODY HAS MAINTAINED SINCE QA ROUND 8 ───────────────
--
-- `capacity_liners` stopped being written then — `stations.functions.ts:79`
-- says so in as many words — and the staff editor stopped showing it. The
-- portal kept printing "Capacity: 200 liners" from whatever the seed left
-- behind. A number no one can change and no one is maintaining is worse than
-- an absent one, because it reads as current. Dropped from the return.
--
-- `liner_size` stays: `updateStation` still writes it and the staff panel still
-- shows it as a chip.

do $pre$
declare _def text;
begin
  _def := pg_get_functiondef('public.portal_list_stations(uuid)'::regprocedure);
  if _def like '%station_number%' then
    raise exception 'portal_list_stations already returns station_number; re-read this migration';
  end if;
  if _def not like '%capacity_liners%' then
    raise exception 'portal_list_stations no longer returns capacity_liners; re-read this migration';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'waste_stations'
       and column_name = 'label' and is_nullable = 'YES'
  ) then
    raise exception 'waste_stations.label is NOT NULL again; the nameless-station case this fixes cannot arise';
  end if;
end $pre$;

drop function if exists public.portal_list_stations(uuid);

create function public.portal_list_stations(_token uuid)
 returns table(station_id uuid, station_number integer, label text,
               location_description text, liner_size text, last_serviced_on date)
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  SELECT ws.id, ws.station_number, ws.label, ws.location_description, ws.liner_size,
         (SELECT MAX(v.scheduled_on) FROM public.station_service_logs sl
           JOIN public.visits v ON v.id = sl.visit_id
           WHERE sl.waste_station_id = ws.id)
    FROM public.clients c
    JOIN public.waste_stations ws ON ws.client_id = c.id
   WHERE c.portal_token = _token AND c.active = true AND ws.active = true
   ORDER BY ws.sort_order, ws.station_number, ws.label
$function$;

-- Every portal RPC is reachable only by service_role, behind
-- requirePortalSession. A DROP and CREATE mints a fresh ACL, so all three
-- grants a new function arrives with have to go — `authenticated` included,
-- which the migration before this one learned the hard way.
revoke all on function public.portal_list_stations(uuid) from public, anon;
revoke execute on function public.portal_list_stations(uuid) from authenticated;

do $post$
declare _left text; _def text;
begin
  _def := pg_get_functiondef('public.portal_list_stations(uuid)'::regprocedure);
  if _def not like '%station_number%' then
    raise exception 'portal_list_stations still does not return the station number';
  end if;
  if _def like '%capacity_liners%' then
    raise exception 'portal_list_stations still returns the unmaintained capacity';
  end if;

  select string_agg(grantee, ', ') into _left
    from information_schema.routine_privileges
   where routine_schema = 'public' and routine_name = 'portal_list_stations'
     and grantee in ('anon','authenticated','PUBLIC');
  if _left is not null then
    raise exception 'portal_list_stations is reachable without service_role by: %', _left;
  end if;

  -- The order has to match the staff list or the numbers mean different things
  -- on the two screens, which is most of what this migration is about.
  if _def not like '%ORDER BY ws.sort_order, ws.station_number, ws.label%' then
    raise exception 'portal_list_stations does not order the way listStations does';
  end if;
end $post$;
