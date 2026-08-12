-- Not every platform event has a platform admin behind it.
--
-- `platform_admin_audit.actor_user_id` is NOT NULL, and until now that held:
-- every row in it was written by a signed-in platform admin doing something
-- deliberate — impersonating, suspending a tenant, changing a plan, sending an
-- announcement. The live table's five distinct actions are all of that kind.
--
-- The change this accompanies files a row when a tenant's `billing_status`
-- moves, and the writer that matters most is the platform Stripe webhook. A
-- webhook has no actor. Nobody in this system did it; a customer's card did.
--
-- The alternatives were worse. Inventing an actor — the org's owner, a service
-- account, the first platform admin — puts a name on an act that person did not
-- perform, in the one table whose entire job is saying who did what. A separate
-- events table splits "what happened to this tenant" across two places that
-- have to be read together, which is how the tenant audit tab stops being
-- worth opening.
--
-- So the column is nullable, and null means exactly one thing: this happened to
-- the tenant rather than being done to them. Both readers — the tenant audit
-- tab and /platform/audit — say "by the billing system" for those rows rather
-- than truncating a uuid that is not there.
--
-- Nothing is backfilled and nothing changes for the rows that exist: they all
-- have an actor and all still do.

do $pre$
declare _null_rows integer;
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'platform_admin_audit'
       and column_name = 'actor_user_id' and is_nullable = 'NO'
  ) then
    raise exception 'platform_admin_audit.actor_user_id is already nullable; re-read this migration';
  end if;

  select count(*) into _null_rows
    from public.platform_admin_audit where actor_user_id is null;
  if _null_rows <> 0 then
    raise exception 'expected no actorless rows before this runs, found %', _null_rows;
  end if;
end $pre$;

alter table public.platform_admin_audit
  alter column actor_user_id drop not null;

comment on column public.platform_admin_audit.actor_user_id is
  'The platform admin who performed this action. NULL when nobody did — a '
  'row written by the platform Stripe webhook, where the actor is a customer''s '
  'payment rather than a person. Readers render those as "by the billing '
  'system"; they must not assume a uuid is present.';

do $post$
declare _rows integer;
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'platform_admin_audit'
       and column_name = 'actor_user_id' and is_nullable = 'NO'
  ) then
    raise exception 'actor_user_id is still NOT NULL';
  end if;

  -- Every existing row keeps its actor. This migration widens what is
  -- permitted; it does not change a single row.
  select count(*) into _rows
    from public.platform_admin_audit where actor_user_id is null;
  if _rows <> 0 then
    raise exception 'this migration wrote or cleared % actor(s) and should have written none', _rows;
  end if;
end $post$;
