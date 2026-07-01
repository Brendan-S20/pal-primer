
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_invoice_sent boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_payment_received boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_visit_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS notify_email_weather_reschedule boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_welcome boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_overdue boolean NOT NULL DEFAULT true;
