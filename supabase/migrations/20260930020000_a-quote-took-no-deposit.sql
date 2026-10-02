-- A quote took no deposit.
--
-- A bid for an HOA, a commercial lot or a first cleanup of a neglected yard
-- is work a business commits a truck to before it has been paid anything.
-- Jobber lets the owner require a deposit when the customer approves; here the
-- customer could accept and nothing asked them for money until the first
-- invoice.
--
-- A deposit is a PREPAYMENT, and the product already has one: a prepaid
-- top-up invoice. When it is paid, tg_invoice_paid_credit turns it into
-- account credit, and apply_credit_to_invoice takes that credit off the next
-- invoices -- in the portal, on the pay link, in the office and in the nightly
-- autopay run -- and never off a top-up, which would be circular. Refunds
-- already reverse the credit (reverse_prepaid_credit_for_payment). So a
-- deposit is a top-up invoice for the amount on the quote, and nothing about
-- how money moves is new.
--
--   quotes.deposit_cents        what the customer is asked for on accepting.
--                               NULL is no deposit, the default. Frozen once
--                               the quote is sent, like its price.
--   quotes.deposit_invoice_id   the top-up invoice, once there is somebody to
--                               bill: at acceptance for a quote to a client,
--                               at conversion for one to a prospect.
--   quote_deposit_invoice(q)    makes that invoice, exactly once. Service role
--                               only; the server calls it after the customer's
--                               token or the office's permission is checked.
--
-- A deposit is not taxed. It is money on account, and the invoice it is later
-- spent on carries the tax; taxing both would charge the customer twice. So
-- the totals are written here with tax 0 rather than through
-- set_invoice_totals, which would apply the organization's rate.
--
-- Replays into an empty database: columns, a CHECK, an index, three function
-- bodies. No rows.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_cents integer,
  ADD COLUMN IF NOT EXISTS deposit_invoice_id uuid REFERENCES public.invoices(id) ON DELETE SET NULL;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.quotes'::regclass
                    AND conname = 'quotes_deposit_cents_range') THEN
    ALTER TABLE public.quotes
      ADD CONSTRAINT quotes_deposit_cents_range
      CHECK (deposit_cents IS NULL OR deposit_cents BETWEEN 100 AND 1000000);
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS quotes_deposit_invoice_id ON public.quotes (deposit_invoice_id)
  WHERE deposit_invoice_id IS NOT NULL;

COMMENT ON COLUMN public.quotes.deposit_cents IS
  'Deposit the customer is asked to pay on accepting, in cents ($1 to $10,000). NULL: no deposit. Frozen once the quote is sent.';
COMMENT ON COLUMN public.quotes.deposit_invoice_id IS
  'The prepaid top-up invoice for the deposit. Paid, it becomes account credit that comes off the first invoices.';

-- ── Tenancy: the deposit invoice is the quote's own organization's ─────────
-- quotes_before_write as 20260929010000 left it, plus deposit_invoice_id.
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
  IF NEW.deposit_invoice_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.invoices i
     WHERE i.id = NEW.deposit_invoice_id AND i.organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'That invoice is not in this organization';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quotes_before_write() FROM PUBLIC, anon, authenticated;

-- ── A sent quote's deposit is part of what was sent ─────────────────────────
-- quotes_guard_answer as 20260928170000 left it, with deposit_cents in the
-- frozen set, and deposit_invoice_id written only by quote_deposit_invoice.
CREATE OR REPLACE FUNCTION public.quotes_guard_answer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.status <> 'draft'
     AND (NEW.client_id, NEW.lead_id, NEW.prospect_name, NEW.prospect_email, NEW.prospect_phone,
          NEW.title, NEW.message, NEW.valid_until, NEW.deposit_cents)
         IS DISTINCT FROM
         (OLD.client_id, OLD.lead_id, OLD.prospect_name, OLD.prospect_email, OLD.prospect_phone,
          OLD.title, OLD.message, OLD.valid_until, OLD.deposit_cents) THEN
    RAISE EXCEPTION 'A quote cannot be edited once it has been sent. Duplicate it into a new draft instead.';
  END IF;

  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A sent quote cannot go back to draft. Duplicate it into a new draft instead.';
  END IF;

  IF current_user IN ('authenticated', 'anon') AND (
       (NEW.status IN ('accepted', 'declined') AND NEW.status IS DISTINCT FROM OLD.status)
    OR (OLD.status IN ('accepted', 'declined') AND NEW.status IS DISTINCT FROM OLD.status)
    OR (NEW.accepted_at, NEW.accepted_name, NEW.declined_at, NEW.decline_reason)
       IS DISTINCT FROM (OLD.accepted_at, OLD.accepted_name, OLD.declined_at, OLD.decline_reason)
  ) THEN
    RAISE EXCEPTION 'Only the customer can accept or decline a quote, from its link.';
  END IF;

  -- The deposit invoice is made and linked by quote_deposit_invoice, once. The
  -- office's role pointing it at some other invoice would let a paid invoice
  -- stand in for a deposit that was never asked for.
  IF current_user IN ('authenticated', 'anon')
     AND NEW.deposit_invoice_id IS DISTINCT FROM OLD.deposit_invoice_id
     AND NEW.deposit_invoice_id IS NOT NULL THEN
    RAISE EXCEPTION 'A quote''s deposit invoice is made by HoundStack, not set by hand.';
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.quotes_guard_answer() FROM PUBLIC, anon, authenticated;

-- ── The deposit invoice, exactly once ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.quote_deposit_invoice(_quote_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _q public.quotes%ROWTYPE;
  _bill_to uuid;
  _today date;
  _inv uuid;
BEGIN
  -- The row lock is what makes two taps (or an accept racing a conversion)
  -- produce one invoice: the second waits, then sees the first one's id.
  SELECT * INTO _q FROM public.quotes WHERE id = _quote_id FOR UPDATE;
  IF _q.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF _q.deposit_invoice_id IS NOT NULL THEN
    RETURN _q.deposit_invoice_id;
  END IF;
  IF _q.status <> 'accepted' OR _q.deposit_cents IS NULL THEN
    RETURN NULL;
  END IF;
  _bill_to := COALESCE(_q.converted_client_id, _q.client_id);
  IF _bill_to IS NULL THEN
    -- A prospect: there is nobody to bill until the office converts the quote.
    RETURN NULL;
  END IF;

  SELECT (now() AT TIME ZONE COALESCE(NULLIF(o.timezone, ''), 'America/Chicago'))::date
    INTO _today FROM public.organizations o WHERE o.id = _q.organization_id;

  INSERT INTO public.invoices (organization_id, client_id, status, kind, issued_at,
                               period_start, period_end, notes)
  VALUES (_q.organization_id, _bill_to, 'open', 'prepaid_topup', now(), _today, _today,
          'Deposit for quote Q-' || _q.number || '. Paid, it is credited to your account '
          || 'and comes off your first invoices.')
  RETURNING id INTO _inv;

  INSERT INTO public.invoice_line_items (invoice_id, description, amount_cents)
  VALUES (_inv, 'Deposit for quote Q-' || _q.number, _q.deposit_cents);

  -- Not set_invoice_totals: a deposit is money on account, and the invoice it
  -- is spent on carries the tax. See the file header.
  UPDATE public.invoices
     SET subtotal_cents = _q.deposit_cents,
         tax_rate_bps   = 0,
         tax_cents      = 0,
         tax_label      = NULL,
         total_cents    = _q.deposit_cents,
         updated_at     = now()
   WHERE id = _inv;

  UPDATE public.quotes SET deposit_invoice_id = _inv WHERE id = _q.id;
  RETURN _inv;
END;
$function$;

REVOKE ALL ON FUNCTION public.quote_deposit_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.quote_deposit_invoice(uuid) TO service_role;

-- ── The customer's copy says a deposit is due, and whether it is paid ───────
-- public_quote_document as 20260928170000 left it, plus three keys.
CREATE OR REPLACE FUNCTION public.public_quote_document(_token uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _q public.quotes%ROWTYPE;
  _org record;
  _recipient text;
  _today date;
  _status text;
  _dep record;
BEGIN
  IF _token IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO _q FROM public.quotes WHERE public_token = _token;
  -- A draft is not published. NULL either way, so a draft's link cannot be
  -- told apart from a mistyped one.
  IF _q.id IS NULL OR _q.status = 'draft' THEN
    RETURN NULL;
  END IF;

  SELECT name, contact_email, contact_phone, timezone, currency INTO _org
    FROM public.organizations WHERE id = _q.organization_id;

  SELECT display_name INTO _recipient FROM public.clients WHERE id = _q.client_id;
  _recipient := COALESCE(_recipient, _q.prospect_name);

  -- Expiry is a day on the business's calendar, not the server's.
  _today := (now() AT TIME ZONE COALESCE(NULLIF(_org.timezone, ''), 'America/Chicago'))::date;
  _status := CASE
    WHEN _q.status = 'sent' AND _q.valid_until IS NOT NULL AND _q.valid_until < _today THEN 'expired'
    ELSE _q.status
  END;

  -- The deposit invoice's pay token is the one thing the customer's copy
  -- needs from it: the pay link is where they pay. Its status says whether to
  -- offer that link or say thank you.
  SELECT i.public_token, i.status INTO _dep
    FROM public.invoices i WHERE i.id = _q.deposit_invoice_id;

  RETURN jsonb_build_object(
    'number', _q.number,
    'status', _status,
    'title', _q.title,
    'message', _q.message,
    'valid_until', _q.valid_until,
    'sent_at', _q.sent_at,
    'accepted_at', _q.accepted_at,
    'accepted_name', _q.accepted_name,
    'declined_at', _q.declined_at,
    'decline_reason', _q.decline_reason,
    'recipient_name', _recipient,
    'org_name', _org.name,
    'org_email', _org.contact_email,
    'org_phone', _org.contact_phone,
    'org_timezone', _org.timezone,
    'currency', COALESCE(_org.currency, 'usd'),
    'deposit_cents', _q.deposit_cents,
    'deposit_pay_token', CASE WHEN _dep.status = 'open' THEN _dep.public_token END,
    'deposit_paid', COALESCE(_dep.status = 'paid', false),
    'lines', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'description', li.description,
               'quantity', li.quantity,
               'unit_amount_cents', li.unit_amount_cents,
               'amount_cents', li.amount_cents,
               'recurring', li.recurring
             ) ORDER BY li.sort, li.created_at, li.id)
        FROM public.quote_line_items li
       WHERE li.quote_id = _q.id
    ), '[]'::jsonb)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.public_quote_document(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.public_quote_document(uuid) TO service_role;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'quotes'
       AND column_name = 'deposit_cents' AND is_nullable = 'YES' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'quotes.deposit_cents is missing, or defaults to something other than no deposit';
  END IF;
  IF to_regclass('public.quotes_deposit_invoice_id') IS NULL THEN
    RAISE EXCEPTION 'quotes.deposit_invoice_id is not indexed';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.quotes_before_write()'::regprocedure)
       !~ 'NEW\.deposit_invoice_id' THEN
    RAISE EXCEPTION 'quotes_before_write does not keep the deposit invoice inside the tenant';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.quotes_guard_answer()'::regprocedure)
       !~ 'NEW\.deposit_cents' THEN
    RAISE EXCEPTION 'quotes_guard_answer lets a sent quote''s deposit change';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = 'public.quote_deposit_invoice(uuid)'::regprocedure)
       !~ 'FOR UPDATE' THEN
    RAISE EXCEPTION 'quote_deposit_invoice does not lock the quote, so two taps could make two invoices';
  END IF;
  IF has_function_privilege('anon', 'public.quote_deposit_invoice(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.quote_deposit_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'quote_deposit_invoice is callable by an API role';
  END IF;
  IF has_function_privilege('anon', 'public.public_quote_document(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.public_quote_document(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'public_quote_document is callable by an API role';
  END IF;
END
$check$;
