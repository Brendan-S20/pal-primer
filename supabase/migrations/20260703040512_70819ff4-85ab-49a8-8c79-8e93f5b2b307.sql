ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_sms_overdue_invoice boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sms_payment_failed boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sms_visit_reminder boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sms_on_my_way boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_sms_visit_completed boolean NOT NULL DEFAULT true;