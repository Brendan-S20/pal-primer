
ALTER TABLE public.push_subscriptions
  ADD COLUMN IF NOT EXISTS native_token text,
  ADD COLUMN IF NOT EXISTS platform text;

ALTER TABLE public.push_subscriptions
  ALTER COLUMN endpoint DROP NOT NULL,
  ALTER COLUMN p256dh DROP NOT NULL,
  ALTER COLUMN auth DROP NOT NULL;

-- Replace the plain-unique endpoint constraint with a partial unique index (only when endpoint is set).
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subs_endpoint_unique;

CREATE UNIQUE INDEX IF NOT EXISTS push_subs_endpoint_unique_idx
  ON public.push_subscriptions (endpoint) WHERE endpoint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS push_subs_native_token_unique_idx
  ON public.push_subscriptions (native_token) WHERE native_token IS NOT NULL;

-- Platform must be one of the supported channels when set.
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subs_platform_chk;
ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_subs_platform_chk
  CHECK (platform IS NULL OR platform IN ('web','ios','android'));

-- Every row needs at least one delivery channel.
ALTER TABLE public.push_subscriptions
  DROP CONSTRAINT IF EXISTS push_subs_channel_chk;
ALTER TABLE public.push_subscriptions
  ADD CONSTRAINT push_subs_channel_chk
  CHECK (endpoint IS NOT NULL OR native_token IS NOT NULL);

CREATE INDEX IF NOT EXISTS push_subs_native_platform_idx
  ON public.push_subscriptions (platform) WHERE native_token IS NOT NULL;
