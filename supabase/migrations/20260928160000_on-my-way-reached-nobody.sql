-- "On my way" reached nobody.
--
-- The only on-my-way message was a text a tech sends by opening "More
-- options" on a stop and tapping "Text on my way". It said "your tech is on
-- the way" with no name and no time, it was SMS only, and it failed outright
-- for any client with no texting consent on file, which on day one is every
-- imported client. Found 2026-09-27 by the Jobber-switcher and field-tech
-- reviews: Jobber, Housecall Pro and Sweep&Go all send it with the tech's
-- name and an arrival window, and send it for the tech.
--
-- 1. organizations.notify_email_on_my_way: when a text cannot go (no consent,
--    no sender, turned off, or the carrier refused it), the message goes by
--    email instead.
-- 2. organizations.on_my_way_on_navigate: send it automatically when a tech
--    taps Navigate on a stop that is scheduled for today, so the tech does
--    nothing extra in the driveway.
-- 3. visits.on_my_way_sent_at: when it went, so the automatic path sends it
--    once per visit however many times Navigate is tapped, and the office
--    can see that the customer was told.
--
-- Both toggles default ON for organizations created from now on, and are
-- switched OFF for those that already exist, the same rollout as
-- 20260928040000's day-before reminder: six businesses were live when this
-- was written, and their customers should not start receiving a message the
-- owner never chose. They see the new rows in Settings.
--
-- Replays into an empty database: three columns and an UPDATE that touches no
-- rows when there are none. The DO block asserts only what this file creates.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_on_my_way boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS on_my_way_on_navigate boolean NOT NULL DEFAULT true;

UPDATE public.organizations
   SET notify_email_on_my_way = false,
       on_my_way_on_navigate = false;

ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS on_my_way_sent_at timestamptz;

COMMENT ON COLUMN public.organizations.notify_email_on_my_way IS
  'Email the "on my way" message when it cannot be texted. Off for organizations that existed on 2026-09-28, on by default after.';
COMMENT ON COLUMN public.organizations.on_my_way_on_navigate IS
  'Send "on my way" automatically, once per visit, when a tech taps Navigate on a stop scheduled for today. Off for organizations that existed on 2026-09-28, on by default after.';
COMMENT ON COLUMN public.visits.on_my_way_sent_at IS
  'When the customer was told the tech is on the way, by text or email. Written by the server with the service role.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'notify_email_on_my_way' AND column_default = 'true' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'organizations.notify_email_on_my_way is missing or does not default to true';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'on_my_way_on_navigate' AND column_default = 'true' AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'organizations.on_my_way_on_navigate is missing or does not default to true';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits'
       AND column_name = 'on_my_way_sent_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'visits.on_my_way_sent_at is missing or not a timestamptz';
  END IF;
END
$check$;
