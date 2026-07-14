-- P1.14: the weather page hit Open-Meteo's daily request limit in production,
-- surfacing raw "Weather API 429" errors on every zone and silently breaking
-- auto-rebalance. Forecasts are shared, non-sensitive public data, so cache
-- them server-side: fresh rows short-circuit the API entirely, and stale rows
-- are still served as a graceful fallback when the API errors or rate-limits.
CREATE TABLE public.weather_forecast_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lat_key numeric(8,2) NOT NULL,
  lon_key numeric(8,2) NOT NULL,
  from_date date NOT NULL,
  to_date date NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lat_key, lon_key, from_date, to_date)
);

ALTER TABLE public.weather_forecast_cache ENABLE ROW LEVEL SECURITY;

-- The cache holds public forecast data keyed only by rounded coordinates —
-- nothing tenant-identifying — so any signed-in user may share it.
CREATE POLICY "authenticated read weather cache"
  ON public.weather_forecast_cache FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated insert weather cache"
  ON public.weather_forecast_cache FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "authenticated update weather cache"
  ON public.weather_forecast_cache FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
