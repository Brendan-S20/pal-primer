-- UX round 4: the arrival window belongs to the service, not the property.
-- A property can host multiple services with different windows, and the
-- window is negotiated per service agreement. Move it onto subscriptions
-- and backfill from the legacy property columns so existing services keep
-- their windows. The property columns stay for now as a legacy fallback
-- (older rows, external readers) but the app writes only these.
alter table public.subscriptions
  add column if not exists earliest_time time,
  add column if not exists latest_time time;

update public.subscriptions s
set earliest_time = p.earliest_service_time,
    latest_time = p.latest_service_time
from public.properties p
where p.id = s.property_id
  and s.earliest_time is null
  and s.latest_time is null
  and (p.earliest_service_time is not null or p.latest_service_time is not null);
