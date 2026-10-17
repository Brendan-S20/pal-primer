-- A client hears when the office cancels a dog walk (#410 follow-up).
--
-- One email switch on the business, on by default, read by enqueueAppEmail
-- as notifyKey like every other client email:
--
--   notify_email_walk_canceled   the office canceled a walk that was
--                                scheduled for today or later
--
-- Only dog_walking visits send it (src/lib/walk-notify.server.ts,
-- notifyWalksCanceled), so a pet-waste client gets exactly the emails they
-- got before, whatever this says. Settings > Emails shows the switch only to
-- a business that runs dog walking, beside the two from 20261015220000.
--
-- Replays into an empty database: one column, no row needed. The final block
-- asserts only what this file establishes.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_walk_canceled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.notify_email_walk_canceled IS
  'Email the client when the office cancels a dog walk scheduled for today or later. Dog walking visits only. Migration 20261016100000.';

-- What this file establishes.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
       AND c.column_name = 'notify_email_walk_canceled'
  ) THEN
    RAISE EXCEPTION 'organizations.notify_email_walk_canceled is missing';
  END IF;

  -- On unless an owner turns it off: NOT NULL, default true.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c
     WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
       AND c.column_name = 'notify_email_walk_canceled'
       AND (c.is_nullable <> 'NO' OR c.column_default IS DISTINCT FROM 'true'
            OR c.data_type <> 'boolean')
  ) THEN
    RAISE EXCEPTION 'notify_email_walk_canceled must be boolean NOT NULL DEFAULT true';
  END IF;
END
$check$;
