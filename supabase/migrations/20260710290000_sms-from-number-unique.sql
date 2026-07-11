-- Security (Twilio H1): a Twilio sender number must belong to exactly one org,
-- so a tenant can't squat a rival's number and blackhole their inbound traffic.
-- NOTE: apply once org rows have no duplicate sms_from_number values.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_sms_from_number_unique
  ON public.organizations (sms_from_number)
  WHERE sms_from_number IS NOT NULL;
