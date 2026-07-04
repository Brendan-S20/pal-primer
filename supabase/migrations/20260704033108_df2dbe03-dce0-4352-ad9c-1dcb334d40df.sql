
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS autopay_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS autopay_paused boolean NOT NULL DEFAULT false;
