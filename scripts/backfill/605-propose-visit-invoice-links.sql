-- #605 dry run: propose links between hand-made invoices and the visits they
-- billed, for the owner to review. WRITES NOTHING.
--
-- Before #605 a hand-made invoice never set invoice_line_items.visit_id, so the
-- billing run (run_billing_cycles, 10 6 * * *) can bill the same visit again.
-- This lists the visits at risk and the unlinked invoice line that most likely
-- billed each one, with the UPDATE that would link them as text. Nothing here
-- runs that UPDATE. The owner reads the list, decides per row, and runs the
-- ones they agree with by hand.
--
-- Run read only:
--   psql "$DB_URL" -v org_prefix=342d4d1e -f scripts/backfill/605-propose-visit-invoice-links.sql
--
-- Two lists:
--   1. Postpaid visits no live invoice line names, each with the unlinked
--      lines on the same client's live hand-made invoices issued within 14
--      days of it. These are the visits the next billing run will bill. A row
--      whose amount matches is the likely pair; a visit with no candidate is
--      genuinely unbilled and the run is right to bill it.
--   2. Prepaid visits that debited the client's balance at completion while
--      the same client also has a live hand-made invoice within 14 days. These
--      are not touched by the postpaid run; they are listed because the
--      customer may have paid twice, which only a person can judge.

BEGIN READ ONLY;

\echo '== 1. Postpaid visits the next billing run will bill, with likely hand-made lines =='
WITH manual_lines AS (
  -- A hand-made invoice: not void, and none of its lines came from a
  -- generator (generators set visit_id or subscription_id on their lines).
  SELECT li.id AS line_id, li.description, li.amount_cents,
         i.id AS invoice_id, i.number, i.client_id, i.status,
         i.issued_at::date AS issued_on
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE i.status <> 'void'
     AND li.visit_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.invoice_line_items g
        WHERE g.invoice_id = i.id
          AND (g.visit_id IS NOT NULL OR g.subscription_id IS NOT NULL))
)
SELECT v.scheduled_on,
       c.display_name AS client,
       v.id AS visit_id,
       COALESCE(v.price_cents, s.price_cents) AS visit_cents,
       COALESCE('INV-' || m.number::text, left(m.invoice_id::text, 8)) AS invoice,
       m.issued_on,
       m.description AS line,
       m.amount_cents AS line_cents,
       (m.amount_cents = COALESCE(v.price_cents, s.price_cents)) AS amount_matches,
       CASE WHEN m.line_id IS NOT NULL THEN
         format('UPDATE public.invoice_line_items SET visit_id = %L WHERE id = %L AND visit_id IS NULL;',
                v.id, m.line_id)
       END AS proposed_sql
  FROM public.visits v
  JOIN public.subscriptions s ON s.id = v.subscription_id
  JOIN public.clients c ON c.id = v.client_id
  LEFT JOIN manual_lines m
    ON m.client_id = v.client_id
   AND m.issued_on BETWEEN v.scheduled_on - 14 AND v.scheduled_on + 14
 WHERE v.organization_id::text LIKE :'org_prefix' || '%'
   AND s.billing_cadence = 'postpaid'
   AND v.client_package_id IS NULL
   AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable))
   AND NOT EXISTS (
     SELECT 1 FROM public.invoice_line_items li
      WHERE li.visit_id = v.id)
 ORDER BY v.scheduled_on, client, amount_matches DESC NULLS LAST;

\echo '== 2. Prepaid visits debited at completion, with a hand-made invoice nearby =='
WITH manual_lines AS (
  -- A hand-made invoice: not void, and none of its lines came from a
  -- generator (generators set visit_id or subscription_id on their lines).
  SELECT li.id AS line_id, li.description, li.amount_cents,
         i.id AS invoice_id, i.number, i.client_id, i.status,
         i.issued_at::date AS issued_on
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
   WHERE i.status <> 'void'
     AND li.visit_id IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.invoice_line_items g
        WHERE g.invoice_id = i.id
          AND (g.visit_id IS NOT NULL OR g.subscription_id IS NOT NULL))
)
SELECT v.scheduled_on,
       c.display_name AS client,
       v.id AS visit_id,
       COALESCE('INV-' || m.number::text, left(m.invoice_id::text, 8)) AS invoice,
       m.issued_on,
       m.status AS invoice_status,
       m.description AS line,
       m.amount_cents AS line_cents
  FROM public.visits v
  JOIN public.subscriptions s ON s.id = v.subscription_id
  JOIN public.clients c ON c.id = v.client_id
  JOIN manual_lines m
    ON m.client_id = v.client_id
   AND m.issued_on BETWEEN v.scheduled_on - 14 AND v.scheduled_on + 14
 WHERE v.organization_id::text LIKE :'org_prefix' || '%'
   AND s.billing_cadence = 'prepaid'
   AND EXISTS (
     SELECT 1 FROM public.credit_ledger cl
      WHERE cl.visit_id = v.id AND cl.kind = 'visit_debit')
 ORDER BY v.scheduled_on, client;

ROLLBACK;
