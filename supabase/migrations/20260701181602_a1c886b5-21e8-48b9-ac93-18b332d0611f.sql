
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS last_email_reminder_at timestamptz;
