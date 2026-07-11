-- Twilio/TCPA compliance (Brendan's re-review): record the owner's express
-- consent to receive platform SMS (OTP, notifications) at signup — timestamp,
-- the phone it covers, and the exact consent language shown.
alter table public.organizations
  add column if not exists sms_consent_at timestamptz,
  add column if not exists sms_consent_phone text,
  add column if not exists sms_consent_text text;
