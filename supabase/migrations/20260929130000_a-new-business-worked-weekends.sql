-- A new business worked weekends.
--
-- organizations.work_days defaulted to all seven days (20260719110000), so a
-- business that signed up on a Tuesday was open Saturday and Sunday until
-- the owner found Settings -> Scheduling. Visit generation shifts a visit
-- that lands on a non-working day, and the portal offers only working days
-- for a customer's extra cleanup, so the default decides real schedules.
--
-- The owner's decision, 2026-09-29: new businesses default to Monday to
-- Friday, and can change it. Only the COLUMN DEFAULT changes. Every existing
-- organization keeps the days it has: changing them here would move live
-- customers' visits without anyone choosing that.
--
-- A subscription's own preferred_weekdays still wins over the org's days, so
-- a client who agreed to Saturday stays on Saturday either way.
--
-- Replays into an empty database: one ALTER. The DO block asserts only the
-- default this file sets.

ALTER TABLE public.organizations
  ALTER COLUMN work_days SET DEFAULT '{1,2,3,4,5}';

COMMENT ON COLUMN public.organizations.work_days IS
  'Days of the week the business works (0 = Sunday). Monday to Friday for a business created from 2026-09-29; earlier ones kept what they had.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'work_days' AND column_default = '''{1,2,3,4,5}''::integer[]'
  ) THEN
    RAISE EXCEPTION 'organizations.work_days does not default to Monday to Friday';
  END IF;
END
$check$;
