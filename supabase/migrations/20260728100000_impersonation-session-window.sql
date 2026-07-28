-- BUG-2: impersonation sessions expired silently.
--
-- `expires_at` on this table has only ever bounded the one-time GRANT TOKEN
-- (2 minutes to click through from the admin console). Once the token was
-- redeemed, consumeImpersonation minted a real Supabase session for the target
-- user with autoRefreshToken enabled — and nothing bounded THAT. The tab kept
-- refreshing its own token indefinitely; when it finally did degrade, it
-- degraded silently, which is the finding.
--
-- This adds an explicit end to the impersonation SESSION, distinct from the
-- link's expiry. It is stored rather than derived so that changing the TTL
-- later never retroactively rewrites the window a past session actually ran
-- under (guardrail 10.6 — historical integrity).
--
-- Idempotent.
ALTER TABLE public.impersonation_grants
  ADD COLUMN IF NOT EXISTS session_expires_at timestamptz;

COMMENT ON COLUMN public.impersonation_grants.session_expires_at IS
  'When the impersonated SESSION stops being honored (set at consume time = consumed_at + session TTL). Distinct from expires_at, which bounds only the single-use grant token. NULL on grants consumed before this migration; readers fall back to consumed_at + the default TTL so pre-existing sessions are bounded too.';

-- No new index needed: the session guard looks grants up by auth_session_id,
-- which 20260718100000_impersonation-activity-marker.sql already covers with a
-- partial index on (auth_session_id) WHERE auth_session_id IS NOT NULL AND
-- ended_at IS NULL.
