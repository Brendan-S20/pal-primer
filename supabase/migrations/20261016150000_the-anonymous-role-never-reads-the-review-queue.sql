-- On 2026-10-15, between 18:25 and 19:13 CT, production Postgres logged 169
-- "permission denied for function has_permission" and 96 "new row violates
-- row-level security policy for table weather_forecast_cache". The callers
-- were the review-queue badge (getReviewQueueCount, a HEAD count on
-- review_items) and the weather cache write (the upsert in cachedForecast).
-- Both run on supabaseAdmin. The trigger was a local dev server whose
-- SERVICE_ROLE_KEY held the anon key, so its "admin" client reached
-- production as anon.
--
-- The lockdowns that refused it are correct and stay: anon may not execute
-- has_permission (20260708200000, restated in 20261009180000), and the weather
-- cache is written by the service role only (20260714110100).
--
-- What was wrong is the shape of the refusal. The review_items read policy was
-- granted TO public, which includes anon, so an anon request got as far as
-- evaluating the policy and failed inside it on a function it may not call.
-- Anon has no business on either table. With no table privilege it is refused
-- at the door with "permission denied for table", which names the real problem
-- and never reaches has_permission.
--
-- Only the role list of the policy changes. Its USING clause stays as
-- 20260809200000 left it. Grants to authenticated and service_role are
-- untouched.

ALTER POLICY "Read review items with the directory" ON public.review_items
  TO authenticated;

REVOKE ALL ON public.review_items FROM anon;
REVOKE ALL ON public.weather_forecast_cache FROM anon;

DO $check$
BEGIN
  IF has_table_privilege('anon', 'public.review_items', 'SELECT') THEN
    RAISE EXCEPTION 'anon can still SELECT public.review_items';
  END IF;

  IF has_table_privilege('anon', 'public.weather_forecast_cache', 'INSERT') THEN
    RAISE EXCEPTION 'anon can still INSERT into public.weather_forecast_cache';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'review_items'
       AND policyname = 'Read review items with the directory'
       AND roles = ARRAY['authenticated']::name[]
  ) THEN
    RAISE EXCEPTION 'the review_items read policy is not limited to authenticated';
  END IF;

  IF has_function_privilege('anon', 'public.has_permission(uuid, uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute public.has_permission, which must stay revoked';
  END IF;

  -- The two-step sign-in policy is RESTRICTIVE and can only take access away,
  -- so only permissive policies count here.
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'weather_forecast_cache'
       AND permissive = 'PERMISSIVE'
       AND cmd IN ('INSERT', 'UPDATE', 'ALL')
       AND roles && ARRAY['anon', 'authenticated', 'public']::name[]
  ) THEN
    RAISE EXCEPTION 'weather_forecast_cache has a write policy for anon or authenticated; writes are service role only';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.review_items'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on public.review_items';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.weather_forecast_cache'::regclass) THEN
    RAISE EXCEPTION 'row level security is off on public.weather_forecast_cache';
  END IF;
END
$check$;
