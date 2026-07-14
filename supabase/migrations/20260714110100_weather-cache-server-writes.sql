-- QA finding: the shared forecast cache was writable by ANY authenticated
-- user (any tenant, any role) with an unvalidated jsonb payload — a
-- cross-tenant cache-poisoning and crash vector via direct PostgREST calls.
-- Reads stay shared (public forecast data); writes move to the service role
-- only (which bypasses RLS), so the browser-facing role can no longer write.
DROP POLICY "authenticated insert weather cache" ON public.weather_forecast_cache;
DROP POLICY "authenticated update weather cache" ON public.weather_forecast_cache;
