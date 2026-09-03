-- A bill the office has not sent yet is not a bill.
--
-- ── THE GRACE WINDOW, WHICH THE PORTAL DID NOT KNOW ABOUT ─────────────────
--
-- This product has a first-class review window. An auto-generated invoice is
-- created `open` with `sent_at IS NULL` and `send_after` a few days out, and
-- during that window it is deliberately not emailed and deliberately not
-- charged. The nightly autopay run gates money on it in so many words:
--
--   -- Grace gates money too (wave-2 QA finding 3): an auto-generated invoice
--   -- must not be charged while it is still in its review/grace window ...
--   -- owners may still edit or void it.
--   .or(`sent_at.not.is.null,send_after.is.null,send_after.lte.${todayStr}`)
--
-- and the office UI labels such a row "Scheduled to send {date}".
--
-- `portal_list_invoices` had no such filter. Its entire predicate was
-- `WHERE c.portal_token = _token`, so the CUSTOMER saw the invoice, with its
-- due date, counted in their open total, with a Pay button on it -- days
-- before the business intended to issue it, and while staff could still edit
-- or void it.
--
-- Two live examples on the day this was written: $30.00 and $25.00, both
-- `open`, both `sent_at IS NULL`, both `send_after` tomorrow, both already
-- visible to an active client. If the office had corrected either one, the
-- customer had already seen the wrong figure -- and might already have paid it.
--
-- The predicate is the same expression the nightly run uses, deliberately
-- worded to match, because two rules about the same window that drift apart is
-- worse than one rule in the wrong place.
--
-- ── AND THE STATUSES A CUSTOMER HAS NO BUSINESS SEEING ────────────────────
--
-- With no status filter at all, a `draft` -- unfinalised staff work in progress
-- -- reached the customer too, and the billing page renders a Pay button for
-- anything that is not paid or void. Pressing it hits
-- portalCreateInvoicePaymentIntent, which throws "Nothing due on this invoice"
-- because invoiceOutstandingCents returns 0 for a non-open invoice. So the
-- money was safe and the screen was not: a customer could see a bill that does
-- not exist yet and get an error for trying to pay it.
--
-- `uncollectible` goes for the same reason -- a debt the business has written
-- off internally is not something to re-present to the customer. `void` stays:
-- an invoice somebody has already seen should be shown cancelled rather than
-- disappearing, which is the difference between a correction and a discrepancy.
CREATE OR REPLACE FUNCTION public.portal_list_invoices(_token uuid)
RETURNS TABLE(invoice_id uuid, status invoice_status, kind text, total_cents integer,
              issued_at timestamp with time zone, period_start date, period_end date)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT i.id, i.status, i.kind::text, i.total_cents, i.issued_at,
         i.period_start, i.period_end
    FROM public.clients c JOIN public.invoices i ON i.client_id = c.id
   WHERE c.portal_token = _token
     AND i.status IN ('open', 'paid', 'void')
     -- Sent, or never scheduled to send (a manual invoice), or the scheduled
     -- day has arrived. Identical in meaning to the autopay gate.
     AND (i.sent_at IS NOT NULL OR i.send_after IS NULL OR i.send_after <= current_date)
   ORDER BY i.issued_at DESC NULLS LAST, i.created_at DESC
$function$;

REVOKE ALL ON FUNCTION public.portal_list_invoices(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_list_invoices(uuid) TO service_role;

DO $est$
DECLARE _src text;
BEGIN
  SELECT p.prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_list_invoices';

  -- Provable from any starting state: the function either has the gate or it
  -- does not, and a database with no invoices in it can still be asked.
  IF regexp_replace(_src, '--[^\n]*', '', 'g') NOT LIKE '%send_after <= current_date%' THEN
    RAISE EXCEPTION 'portal_list_invoices does not respect the send/grace window';
  END IF;
  IF regexp_replace(_src, '--[^\n]*', '', 'g') NOT LIKE '%status IN (''open'', ''paid'', ''void'')%' THEN
    RAISE EXCEPTION 'portal_list_invoices does not restrict which statuses reach a customer';
  END IF;
END $est$;

-- How many customers could see a bill that had not been sent, on the day this
-- was written. A measurement of a database, so it warns rather than asserts --
-- a fresh build has no invoices and nothing to count, which is not a failure.
DO $exposure$
DECLARE _n int; _total int;
BEGIN
  SELECT count(*) INTO _total FROM public.invoices;
  IF _total = 0 THEN
    RAISE WARNING 'no invoices on this build, so the exposure below was not measured';
    RETURN;
  END IF;
  SELECT count(*) INTO _n
    FROM public.invoices i JOIN public.clients c ON c.id = i.client_id
   WHERE c.portal_token IS NOT NULL
     AND (i.status NOT IN ('open', 'paid', 'void')
          OR (i.sent_at IS NULL AND i.send_after > current_date));
  RAISE WARNING 'invoices that were reaching a customer portal and no longer will: % of %', _n, _total;
END $obs$;
