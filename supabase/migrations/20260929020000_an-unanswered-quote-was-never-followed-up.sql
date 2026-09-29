-- An unanswered quote was never followed up.
--
-- Jobber's quote step is "a quote goes out, with automated follow-ups", and
-- the review marked HoundStack's as missing once quotes existed (#267): a
-- quote the customer opened and forgot sat as "sent" until it expired, and
-- nothing reminded anyone.
--
-- The nightly job now sends ONE reminder email for a quote that has been
-- sent for quote_followup_days days with no answer, while it can still be
-- accepted. It uses the quote's own email and link, and the same "Quote
-- sent" switch in Settings -> Emails that governs the quote itself.
--
--   organizations.quote_followup_days   days after sending; 0 turns it off.
--                                       3 by default, for every organization:
--                                       unlike the visit reminder, nobody has
--                                       sent a quote yet, so nobody's customer
--                                       starts receiving something the owner
--                                       did not ask for.
--   quotes.followup_sent_at             when the reminder went, so it goes
--                                       once. Written by the server with the
--                                       service role.
--
-- quotes_guard_answer() does not look at followup_sent_at, so it can be
-- written on a sent quote.
--
-- Replays into an empty database: two columns and a constraint. The DO block
-- asserts only what this file establishes.

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS quote_followup_days smallint NOT NULL DEFAULT 3;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_quote_followup_days_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_quote_followup_days_check
  CHECK (quote_followup_days BETWEEN 0 AND 30);

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS followup_sent_at timestamptz;

COMMENT ON COLUMN public.organizations.quote_followup_days IS
  'Days after a quote is sent that the nightly job emails one reminder if it is still unanswered. 0 turns it off.';
COMMENT ON COLUMN public.quotes.followup_sent_at IS
  'When the nightly follow-up reminder for this quote went. At most one per quote.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'quote_followup_days' AND is_nullable = 'NO' AND column_default = '3'
  ) THEN
    RAISE EXCEPTION 'organizations.quote_followup_days is missing, nullable, or not defaulted to 3';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.organizations'::regclass
         AND conname = 'organizations_quote_followup_days_check')) !~ '30' THEN
    RAISE EXCEPTION 'quote_followup_days is not bounded';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'quotes'
       AND column_name = 'followup_sent_at' AND data_type = 'timestamp with time zone'
  ) THEN
    RAISE EXCEPTION 'quotes.followup_sent_at is missing or not a timestamptz';
  END IF;
END
$check$;
