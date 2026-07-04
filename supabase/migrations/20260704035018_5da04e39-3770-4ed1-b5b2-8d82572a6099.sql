ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_weekly_digest boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS digest_recipient_email text,
  ADD COLUMN IF NOT EXISTS last_digest_sent_at timestamptz;