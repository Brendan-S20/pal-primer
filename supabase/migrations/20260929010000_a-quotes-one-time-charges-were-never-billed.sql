-- A quote's one-time charges were never billed.
--
-- Converting an accepted quote set up the recurring service at the quoted
-- per-visit price and stopped there. The one-time lines, which on a
-- pet-waste quote are almost always the initial cleanup, were billed by
-- nothing: the wizard's banner told the office to go and invoice them by
-- hand from the Billing tab, retyping what the customer had already
-- accepted.
--
-- The app now offers "Invoice the one-time charges" on an accepted quote.
-- It is a button rather than something conversion does by itself, because
-- the cleanup is billed when it is DONE, and an open invoice is one autopay
-- will charge. This column is what makes the button safe to press twice:
--
--   quotes.one_time_invoice_id   the invoice the one-time lines went on.
--                                Set once; a second press returns it rather
--                                than billing the customer again. ON DELETE
--                                SET NULL, so an invoice deleted because its
--                                lines failed to insert frees the quote to be
--                                invoiced again.
--
-- quotes_guard_answer() does not look at this column, so it can be written
-- after the quote is accepted; quotes_before_write() keeps it inside the
-- tenant only indirectly (the invoice FK), so this file adds its own check.
--
-- Replays into an empty database: one column, one index, one trigger
-- function replaced in place. The DO block asserts only what this file
-- establishes.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS one_time_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS quotes_one_time_invoice_id ON public.quotes (one_time_invoice_id)
  WHERE one_time_invoice_id IS NOT NULL;

COMMENT ON COLUMN public.quotes.one_time_invoice_id IS
  'The invoice this quote''s one-time lines were billed on. Set once, by "Invoice the one-time charges".';

-- The same tenant rule quotes_before_write() applies to client, lead and
-- converted client, extended to the invoice: a quote may only point at an
-- invoice of its own organization.
CREATE OR REPLACE FUNCTION public.quotes_before_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.organizations
       SET next_quote_number = next_quote_number + 1
     WHERE id = NEW.organization_id
     RETURNING next_quote_number - 1 INTO NEW.number;
  ELSE
    -- Identity never changes: the number on the customer's copy, the link in
    -- their inbox, and whose quote it is.
    NEW.number := OLD.number;
    NEW.public_token := OLD.public_token;
    NEW.organization_id := OLD.organization_id;
    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_at := now();
  END IF;

  IF NEW.client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients c WHERE c.id = NEW.client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That client is not in this organization';
  END IF;
  IF NEW.converted_client_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = NEW.converted_client_id AND c.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That client is not in this organization';
  END IF;
  IF NEW.lead_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leads l WHERE l.id = NEW.lead_id AND l.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That lead is not in this organization';
  END IF;
  IF NEW.one_time_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = NEW.one_time_invoice_id AND i.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That invoice is not in this organization';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quotes_before_write() FROM PUBLIC, anon, authenticated;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.quotes'::regclass AND contype = 'f'
       AND confrelid = 'public.invoices'::regclass AND confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'quotes.one_time_invoice_id does not reference invoices ON DELETE SET NULL';
  END IF;
  IF to_regclass('public.quotes_one_time_invoice_id') IS NULL THEN
    RAISE EXCEPTION 'quotes.one_time_invoice_id is not indexed';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.quotes_before_write()'::regprocedure)
       !~ 'one_time_invoice_id' THEN
    RAISE EXCEPTION 'quotes_before_write does not keep the one-time invoice inside the tenant';
  END IF;
  IF has_function_privilege('anon', 'public.quotes_before_write()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.quotes_before_write()', 'EXECUTE') THEN
    RAISE EXCEPTION 'quotes_before_write is executable by an API role';
  END IF;
END
$check$;
