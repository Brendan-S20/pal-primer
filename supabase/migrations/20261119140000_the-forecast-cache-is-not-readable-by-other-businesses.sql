-- #1005: any signed-in user could SELECT every row of the shared forecast
-- cache, i.e. the ~1 km-rounded points other businesses look up. The app only
-- ever reads it from server functions, which now use the service role (it
-- bypasses RLS), so the browser-facing read policy is dropped. With RLS on
-- and no policy, authenticated/anon see nothing.
DROP POLICY IF EXISTS "authenticated read weather cache" ON public.weather_forecast_cache;
