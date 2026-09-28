-- An invoice line had no quantity.
--
-- Found 2026-09-27 by the Jobber-switch review. A line was a description and
-- a total. "3 extra yards at $15" had to be typed as one line reading "3 extra
-- yards" for $45, so the customer could not see the unit price, and the
-- accounting sync posted it to QuickBooks and Xero as one of something at $45.
--
-- 1. invoice_line_items.quantity: numeric, positive, two decimal places (half
--    an hour is a real quantity). Defaults to 1, so every existing row is
--    exactly what it was.
-- 2. invoice_line_items.unit_amount_cents: NULL for a line that is only a
--    total, which is every line written before this and every line the
--    billing run writes. When set, it is the price of one.
-- 3. amount_cents stays the LINE TOTAL, and stays what every sum reads. Totals,
--    AR, revenue, reports, Stripe amounts and the visit-billed test are
--    untouched by this change; it adds detail beside the number, never a
--    second number to add up. A CHECK holds the two together: a line with a
--    unit price must total round(quantity x unit price), so a line cannot say
--    "3 x $15" and charge $50.
--
-- Replays into an empty database: two columns, two constraints. The DO block
-- asserts only what this file establishes.

ALTER TABLE public.invoice_line_items
  ADD COLUMN IF NOT EXISTS quantity numeric(10,2) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS unit_amount_cents integer;

ALTER TABLE public.invoice_line_items
  DROP CONSTRAINT IF EXISTS invoice_line_items_quantity_positive;
ALTER TABLE public.invoice_line_items
  ADD CONSTRAINT invoice_line_items_quantity_positive CHECK (quantity > 0);

ALTER TABLE public.invoice_line_items
  DROP CONSTRAINT IF EXISTS invoice_line_items_total_is_quantity_times_unit;
ALTER TABLE public.invoice_line_items
  ADD CONSTRAINT invoice_line_items_total_is_quantity_times_unit CHECK (
    unit_amount_cents IS NULL
    OR (unit_amount_cents >= 0 AND amount_cents = round(quantity * unit_amount_cents))
  );

COMMENT ON COLUMN public.invoice_line_items.quantity IS
  'How many of the thing this line bills. 1 for a line that is only a total.';
COMMENT ON COLUMN public.invoice_line_items.unit_amount_cents IS
  'Price of one, when the line is itemized. NULL for a line that is only a total. amount_cents is always the line total and is what every sum reads.';

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoice_line_items'
       AND column_name = 'quantity' AND is_nullable = 'NO' AND column_default = '1'
  ) THEN
    RAISE EXCEPTION 'invoice_line_items.quantity is missing, nullable, or not defaulted to 1';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'invoice_line_items'
       AND column_name = 'unit_amount_cents' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'invoice_line_items.unit_amount_cents is missing or NOT NULL';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.invoice_line_items'::regclass
       AND conname = 'invoice_line_items_quantity_positive' AND convalidated
  ) THEN
    RAISE EXCEPTION 'quantity is not constrained positive';
  END IF;
  IF pg_get_constraintdef((SELECT oid FROM pg_constraint
       WHERE conrelid = 'public.invoice_line_items'::regclass
         AND conname = 'invoice_line_items_total_is_quantity_times_unit')) !~ 'round' THEN
    RAISE EXCEPTION 'nothing holds amount_cents to quantity x unit_amount_cents';
  END IF;
END
$check$;
