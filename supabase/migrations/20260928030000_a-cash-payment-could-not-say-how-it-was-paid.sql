-- A cash payment could not say how it was paid.
--
-- Found 2026-09-27 by two persona tests (a first-time owner and an owner
-- switching from Jobber). The only way to record money collected outside
-- Stripe was "Mark paid", which writes a payments row with the whole open
-- balance, today's date, and raw_event {source: "manual_mark_paid"} -- no
-- method, no check number, no date the money actually arrived. So a check
-- taken on Friday and entered on Monday was Monday's income on the cash-basis
-- report, and the office could not answer "which check was this" without
-- leaving the product. Jobber and Housecall Pro both record Cash / Check /
-- Other with a reference.
--
-- Two nullable columns. NULL means "not recorded": every Stripe payment (the
-- instrument lives on the PaymentIntent) and every manual row written before
-- this file. The CHECK lists only out-of-band methods, because a card or bank
-- debit that went through Stripe is not something a person types in.
--
-- No RLS change: "payments recorded by billing managers" already governs
-- INSERT, and these columns ride on the same row.
--
-- Replays into an empty database: two columns and two constraints on a table
-- earlier migrations create. The assertion is about what this file adds.

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS method text,
  ADD COLUMN IF NOT EXISTS reference text;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_method_check;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_method_check
  CHECK (method IS NULL OR method IN ('cash', 'check', 'bank_transfer', 'venmo', 'zelle', 'other'));

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_reference_length;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_reference_length
  CHECK (reference IS NULL OR char_length(reference) <= 120);

COMMENT ON COLUMN public.payments.method IS
  'How an out-of-band payment was made (cash, check, bank_transfer, venmo, zelle, other). NULL for Stripe payments and for manual rows recorded before 2026-09-28.';
COMMENT ON COLUMN public.payments.reference IS
  'Check number, transfer or app reference for an out-of-band payment, as typed by the office.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payments'::regclass AND conname = 'payments_method_check'
  ) THEN
    RAISE EXCEPTION 'payments.method has no constraint after this migration';
  END IF;
END
$check$;
