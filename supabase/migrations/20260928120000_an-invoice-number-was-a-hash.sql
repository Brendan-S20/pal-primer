-- An invoice number was a hash.
--
-- Every invoice a customer or an accountant saw was labelled with the first
-- eight characters of its UUID: "#26db55a4". Found 2026-09-27 by the
-- first-time-owner persona review. It cannot be read aloud on a phone call,
-- sorted, or matched against a bank deposit, and every other invoicing tool
-- the owner has used prints INV-1001.
--
-- Each organization gets its own sequence, starting at 1001:
--   * organizations.next_invoice_number is the counter.
--   * A BEFORE INSERT trigger takes the next number by UPDATE ... RETURNING
--     on the organization's row, so two invoices created at once serialize on
--     that row lock and never share or skip a number (a sequence object would
--     be global, and max()+1 races).
--   * A BEFORE UPDATE trigger keeps the number from ever changing: a number
--     is only useful if the one on the customer's copy is the one on file.
--   * (organization_id, number) is unique.
-- Existing invoices are numbered in the order they were created, and each
-- counter is set past the highest number used.
--
-- Replays into an empty database: a column, a counter, two triggers, a
-- backfill that touches no rows when there are none, and assertions about
-- what this file establishes.

ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS number integer;
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS next_invoice_number integer NOT NULL DEFAULT 1001;

-- Backfill before the trigger exists, so it does not race the counter.
WITH ordered AS (
  SELECT id,
         1000 + row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS n
    FROM public.invoices
   WHERE number IS NULL
)
UPDATE public.invoices i SET number = o.n FROM ordered o WHERE o.id = i.id;

UPDATE public.organizations org
   SET next_invoice_number = GREATEST(org.next_invoice_number, x.max_n + 1)
  FROM (SELECT organization_id, max(number) AS max_n FROM public.invoices GROUP BY organization_id) x
 WHERE x.organization_id = org.id;

CREATE OR REPLACE FUNCTION public.invoices_assign_number()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Always the counter's, whatever the caller sent: a number a client can
    -- choose is a number two invoices can share.
    UPDATE public.organizations
       SET next_invoice_number = next_invoice_number + 1
     WHERE id = NEW.organization_id
     RETURNING next_invoice_number - 1 INTO NEW.number;
    RETURN NEW;
  END IF;
  NEW.number := OLD.number;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.invoices_assign_number() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS invoices_assign_number_ins ON public.invoices;
CREATE TRIGGER invoices_assign_number_ins
  BEFORE INSERT ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_assign_number();

DROP TRIGGER IF EXISTS invoices_keep_number ON public.invoices;
CREATE TRIGGER invoices_keep_number
  BEFORE UPDATE OF number ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_assign_number();

CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_number_key
  ON public.invoices (organization_id, number);

COMMENT ON COLUMN public.invoices.number IS
  'The invoice number a customer sees (INV-1001), per organization, assigned on insert and never changed.';
COMMENT ON COLUMN public.organizations.next_invoice_number IS
  'The number the next invoice will get. Advanced only by invoices_assign_number().';

DO $check$
BEGIN
  IF EXISTS (SELECT 1 FROM public.invoices WHERE number IS NULL) THEN
    RAISE EXCEPTION 'an invoice was left without a number';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organizations o
     WHERE o.next_invoice_number <= COALESCE(
       (SELECT max(number) FROM public.invoices i WHERE i.organization_id = o.id), 0)
  ) THEN
    RAISE EXCEPTION 'an organization''s next invoice number would repeat one already used';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'invoices_assign_number_ins'
                   AND tgrelid = 'public.invoices'::regclass) THEN
    RAISE EXCEPTION 'invoices_assign_number_ins is missing';
  END IF;
END
$check$;

ALTER TABLE public.invoices ALTER COLUMN number SET NOT NULL;
