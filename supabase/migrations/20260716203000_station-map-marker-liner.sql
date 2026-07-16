-- QA round 8: waste stations get a map marker as their location, a liner
-- size dropdown, and optional grouping by commercial section.
--   * latitude/longitude: the station's marker position (the marker IS the
--     location now; location_description is kept as an optional note).
--   * liner_size already exists (text) — added defensively for older envs.
--   * section: matches a value from properties.commercial_sections so the
--     station list can group per section on commercial properties.
--   * capacity_liners is kept for old rows but the app stops writing it.

alter table public.waste_stations
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists liner_size text,
  add column if not exists section text;

-- Marker coordinates must be valid when present.
alter table public.waste_stations
  drop constraint if exists waste_stations_latitude_range,
  drop constraint if exists waste_stations_longitude_range;

alter table public.waste_stations
  add constraint waste_stations_latitude_range
    check (latitude is null or (latitude >= -90 and latitude <= 90)),
  add constraint waste_stations_longitude_range
    check (longitude is null or (longitude >= -180 and longitude <= 180));
