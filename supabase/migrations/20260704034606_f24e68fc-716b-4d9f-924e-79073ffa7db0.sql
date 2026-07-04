ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS notify_email_win_back BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS last_winback_sent_at TIMESTAMPTZ;