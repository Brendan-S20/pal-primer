-- A stay invoice's period follows the stay's dates (gaps-r2-07).
--
-- invoice_stay (20261024080300) writes period_start / period_end from the
-- stay's starts_on / ends_on when the stay is confirmed. change_stay
-- (20261024080400) moves the dates and restate_stay_billing rewrites the
-- unpaid invoice's LINES, but nothing moved its period. After an early return
-- from Nov 4 to Nov 1 the invoice billed 2 nights and still said
-- "Oct 30 to Nov 4" on the Billing tab, the invoice header and the PDF.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────
--
-- One AFTER UPDATE OF starts_on, ends_on trigger on stays. When either date
-- changes, the stay's own invoice (stays.invoice_id) takes the new period, if
-- it is still draft or open: those are the invoices whose lines
-- restate_stay_billing rewrites to match the new dates.
--
-- A PAID stay invoice is left alone, as restate_stay_billing leaves it: its
-- lines still list the nights the client paid for, and the change goes on a
-- new invoice (added nights, which already carries the new dates) or account
-- credit (removed nights). A void invoice is left alone too.
--
-- ── WHAT THIS DOES NOT TOUCH ─────────────────────────────────────────────
--
-- No amount, line, total, tax, credit or deposit. restate_stay_billing,
-- change_stay, invoice_stay and the deposit rules are not redefined here.
-- The trigger fires inside change_stay's UPDATE of the stay, before
-- restate_stay_billing runs, so the invoice it rewrites is still draft or
-- open at that moment.
--
-- ── EXISTING ROWS ────────────────────────────────────────────────────────
--
-- Draft and open stay invoices whose period disagrees with their stay are
-- brought in line once, by the same rule. On an empty database that is no
-- rows, and nothing below asserts a count.

CREATE OR REPLACE FUNCTION public.tg_stays_invoice_period()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.invoice_id IS NULL THEN RETURN NULL; END IF;
  UPDATE public.invoices i
     SET period_start = NEW.starts_on,
         period_end = NEW.ends_on,
         updated_at = now()
   WHERE i.id = NEW.invoice_id
     AND i.status IN ('draft', 'open')
     AND (i.period_start, i.period_end) IS DISTINCT FROM (NEW.starts_on, NEW.ends_on);
  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_stays_invoice_period() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.tg_stays_invoice_period() IS
  'A draft or open stay invoice covers the stay''s current dates: period_start = starts_on, period_end = ends_on. Paid and void invoices are left alone. Dates only; no amount. Migration 20261102190000 (gaps-r2-07).';

DROP TRIGGER IF EXISTS stays_invoice_period ON public.stays;
CREATE TRIGGER stays_invoice_period
  AFTER UPDATE OF starts_on, ends_on ON public.stays
  FOR EACH ROW
  WHEN (OLD.starts_on IS DISTINCT FROM NEW.starts_on OR OLD.ends_on IS DISTINCT FROM NEW.ends_on)
  EXECUTE FUNCTION public.tg_stays_invoice_period();

-- Stay invoices already out of line (stays changed before this file).
UPDATE public.invoices i
   SET period_start = st.starts_on,
       period_end = st.ends_on,
       updated_at = now()
  FROM public.stays st
 WHERE st.invoice_id = i.id
   AND i.status IN ('draft', 'open')
   AND (i.period_start, i.period_end) IS DISTINCT FROM (st.starts_on, st.ends_on);

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.stays'::regclass
       AND tgname = 'stays_invoice_period'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'stays_invoice_period trigger is missing';
  END IF;
  IF has_function_privilege('anon', 'public.tg_stays_invoice_period()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_stays_invoice_period()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_stays_invoice_period() must not be executable by anon or authenticated';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stays st JOIN public.invoices i ON i.id = st.invoice_id
     WHERE i.status IN ('draft', 'open')
       AND (i.period_start, i.period_end) IS DISTINCT FROM (st.starts_on, st.ends_on)
  ) THEN
    RAISE EXCEPTION 'An open or draft stay invoice still covers other dates than its stay';
  END IF;
END
$check$;
