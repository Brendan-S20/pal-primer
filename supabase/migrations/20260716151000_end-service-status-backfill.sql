-- Ended services previously kept status='active' (endSubscription only set
-- ends_on), so they still counted as active everywhere. The app now flips
-- status to 'canceled' when the end date is reached; this backfills rows
-- ended before the fix. Idempotent.
update public.subscriptions
set status = 'canceled'
where ends_on is not null
  and ends_on <= current_date
  and status <> 'canceled';
