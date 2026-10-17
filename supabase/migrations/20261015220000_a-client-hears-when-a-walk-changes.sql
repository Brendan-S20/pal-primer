-- A client hears when a walk changes (#410, part 3).
--
-- 1. Two email switches on the business, both on by default, read by
--    enqueueAppEmail as notifyKey like every other client email:
--
--      notify_email_walk_not_done         a walk was skipped or missed
--      notify_email_walk_schedule_change  the office moved a walk, or changed
--                                         a walk plan's days or window
--
--    Only dog_walking visits and plans send either email (src/lib/
--    walk-notify.server.ts), so a pet-waste client gets exactly the emails
--    they got before, whatever these say. Settings > Emails shows the two
--    switches only to a business that runs dog walking.
--
-- 2. The time window a client asked for a walk in, on the request itself:
--    qc_tickets.requested_earliest_time / requested_latest_time. NULL is
--    "Any time", which is every request before this file and every request
--    that is not for a walk. portalRequestOneOff writes them after
--    portal_request_one_off returns (as the service role, scoped to the
--    session's organization), so that function's signature is unchanged.
--    Both or neither, and the end after the start.
--
-- Replays into an empty database: four columns and one check. No row is
-- needed. The final block asserts only what this file establishes.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS notify_email_walk_not_done boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS notify_email_walk_schedule_change boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.organizations.notify_email_walk_not_done IS
  'Email the client when a dog walk is skipped or missed. Dog walking visits only. Migration 20261015220000.';
COMMENT ON COLUMN public.organizations.notify_email_walk_schedule_change IS
  'Email the client when the office moves a dog walk or changes a walk plan''s days or window. Migration 20261015220000.';

ALTER TABLE public.qc_tickets
  ADD COLUMN IF NOT EXISTS requested_earliest_time time,
  ADD COLUMN IF NOT EXISTS requested_latest_time time;

ALTER TABLE public.qc_tickets DROP CONSTRAINT IF EXISTS qc_tickets_requested_window_shape;
ALTER TABLE public.qc_tickets ADD CONSTRAINT qc_tickets_requested_window_shape
  CHECK (
    (requested_earliest_time IS NULL AND requested_latest_time IS NULL)
    OR (requested_earliest_time IS NOT NULL AND requested_latest_time IS NOT NULL
        AND requested_latest_time > requested_earliest_time)
  );

COMMENT ON COLUMN public.qc_tickets.requested_earliest_time IS
  'For a one_off_request for a walk: the start of the window the client asked for. NULL is any time.';
COMMENT ON COLUMN public.qc_tickets.requested_latest_time IS
  'For a one_off_request for a walk: the end of the window the client asked for. NULL is any time.';

-- What this file establishes.
DO $check$
DECLARE
  _missing text;
BEGIN
  SELECT string_agg(expected.tbl || '.' || expected.col, ', ') INTO _missing
    FROM (VALUES
      ('organizations', 'notify_email_walk_not_done'),
      ('organizations', 'notify_email_walk_schedule_change'),
      ('qc_tickets', 'requested_earliest_time'),
      ('qc_tickets', 'requested_latest_time')
    ) AS expected(tbl, col)
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = expected.tbl
        AND c.column_name = expected.col);
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'Walk notification columns are missing: %', _missing;
  END IF;

  -- The switches are on unless an owner turns them off: NOT NULL, default true.
  SELECT string_agg(c.column_name, ', ') INTO _missing
    FROM information_schema.columns c
   WHERE c.table_schema = 'public' AND c.table_name = 'organizations'
     AND c.column_name IN ('notify_email_walk_not_done', 'notify_email_walk_schedule_change')
     AND (c.is_nullable <> 'NO' OR c.column_default IS DISTINCT FROM 'true'
          OR c.data_type <> 'boolean');
  IF _missing IS NOT NULL THEN
    RAISE EXCEPTION 'Walk email switches must be boolean NOT NULL DEFAULT true: %', _missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.qc_tickets'::regclass
       AND conname = 'qc_tickets_requested_window_shape'
  ) THEN
    RAISE EXCEPTION 'qc_tickets_requested_window_shape is missing';
  END IF;
END
$check$;
