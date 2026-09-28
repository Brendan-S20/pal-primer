-- Nobody was reminded the day before.
--
-- Settings -> Automation has had a "Day-before visit reminder" switch since
-- July, and nothing ever sent one on a schedule: the only sender is a button
-- a tech taps (sendVisitStatusSms), and it is SMS, which is blocked on every
-- account until carrier registration (10DLC) clears. Found 2026-09-27 by the
-- Jobber-switcher persona review: an owner moving over on day one has no
-- reminder of any kind reaching a customer.
--
-- The nightly job now emails each client with a visit tomorrow (org
-- calendar). Email rather than text because the job runs at 09:00 UTC --
-- 2 to 5 AM across the US -- which is fine for an inbox and wrong for a
-- phone; an automated text needs a sender that respects quiet hours, and
-- registration first.
--
-- The toggle defaults ON for every organization created from now on, and is
-- switched OFF for the ones that already exist. Six businesses were live when
-- this was written; their customers should not start receiving a new email
-- that the owner never chose. They see the new row in Settings -> Emails.
--
-- Replays into an empty database: one column with a default, and an UPDATE
-- that touches no rows when there are none.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_visit_reminder boolean NOT NULL DEFAULT true;

UPDATE public.organizations SET notify_email_visit_reminder = false;

COMMENT ON COLUMN public.organizations.notify_email_visit_reminder IS
  'Email each client the day before a scheduled visit (nightly job). Off for organizations that existed on 2026-09-28, on by default after.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'notify_email_visit_reminder' AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'organizations.notify_email_visit_reminder is missing or does not default to true';
  END IF;
END
$check$;
