-- Tonight's card is tonight's stay (#653, R2-11).
--
-- Round-2 audit, 2026-10-30: on night 2 of a stay the sitter's card said
-- "Pays cash/check ... $850.00 due". The stay she was standing in owed $200.
-- The other $650 was a stay in December ($500) and that stay's deposit
-- ($150), which is already inside the $500. my_day_stop_facts summed every
-- open invoice the client had, so a booking made for next month, and its
-- deposit counted a second time, landed in "due" on tonight's card, and the
-- collect form would have let her take it.
--
-- The balance on a stop card is now scoped to the stop:
--
--   A visit of a stay (subscriptions.stay_id): that stay's own invoice
--   (stays.invoice_id) and nothing else. Its deposit invoice is not added:
--   the deposit is part of the stay's price, not on top of it.
--
--   Any other visit: the client's open invoices as before, less every stay
--   invoice for a stay that has not started by the visit's day, and less
--   every stay deposit invoice (each is inside its stay's invoice, which is
--   counted or excluded on its own terms).
--
-- Only the balance column changes. How a deposit is recorded, what it counts
-- as, and what pays what are untouched (that is part 2 of #653, decision D3).
-- record_field_collection's client-wide cap is untouched too: the card's
-- smaller "due" is what the tech's form starts at and stops at.
--
-- Replays into an empty database: a function and a check of its own body.


CREATE OR REPLACE FUNCTION public.my_day_stop_facts(_visit_ids uuid[])
RETURNS TABLE (
  visit_id uuid,
  dog_count integer,
  autopay boolean,
  card_on_file boolean,
  pays_cash_check boolean,
  open_balance_cents bigint,
  awaiting_cents bigint,
  has_invoice_line boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH allowed AS (
    SELECT v.id, v.organization_id, v.client_id, v.subscription_id, v.scheduled_on
      FROM public.visits v
     WHERE v.id = ANY (_visit_ids)
       AND auth.uid() IS NOT NULL
       AND (
         EXISTS (
           SELECT 1 FROM public.staff s
            WHERE s.id = v.assigned_staff_id
              AND s.user_id = auth.uid() AND s.active
              AND s.organization_id = v.organization_id
         )
         OR public.has_permission(auth.uid(), v.organization_id, 'view_client_directory')
       )
  )
  SELECT a.id,
         sub.dog_count,
         COALESCE(c.autopay_enabled AND NOT c.autopay_paused, false),
         c.default_payment_method_id IS NOT NULL,
         COALESCE((
           SELECT p.method IN ('cash', 'check')
             FROM public.payments p
             JOIN public.invoices i ON i.id = p.invoice_id
            WHERE i.client_id = a.client_id
              AND p.organization_id = a.organization_id
              AND p.status = 'succeeded'
            ORDER BY p.paid_at DESC NULLS LAST, p.created_at DESC
            LIMIT 1
         ), false)
         OR EXISTS (
           SELECT 1 FROM public.field_collections fc
            WHERE fc.client_id = a.client_id
              AND fc.status <> 'rejected'
              AND fc.collected_at > now() - interval '120 days'
         ),
         COALESCE((
           SELECT sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0) - COALESCE(i.amount_paid_cents, 0), 0))
             FROM public.invoices i
            WHERE i.client_id = a.client_id
              AND i.organization_id = a.organization_id
              AND i.status = 'open'
              AND CASE
                    -- A night of a stay: this stay's invoice, only.
                    WHEN sub.stay_id IS NOT NULL THEN EXISTS (
                      SELECT 1 FROM public.stays st
                       WHERE st.id = sub.stay_id
                         AND st.invoice_id = i.id
                    )
                    -- Anything else: not a stay still to come, and not a
                    -- deposit, which is inside its stay's invoice.
                    ELSE NOT EXISTS (
                      SELECT 1 FROM public.stays st
                       WHERE st.organization_id = a.organization_id
                         AND st.client_id = a.client_id
                         AND (
                           st.deposit_invoice_id = i.id
                           OR (st.invoice_id = i.id AND st.starts_on > a.scheduled_on)
                         )
                    )
                  END
         ), 0)::bigint,
         COALESCE((
           SELECT sum(fc.amount_cents)
             FROM public.field_collections fc
            WHERE fc.client_id = a.client_id
              AND fc.status = 'awaiting_confirmation'
         ), 0)::bigint,
         EXISTS (
           SELECT 1 FROM public.invoice_line_items li
             JOIN public.invoices i ON i.id = li.invoice_id
            WHERE li.visit_id = a.id
              AND i.organization_id = a.organization_id
              AND i.client_id = a.client_id
              AND i.status <> 'void'
         )
    FROM allowed a
    JOIN public.clients c ON c.id = a.client_id
    LEFT JOIN public.subscriptions sub ON sub.id = a.subscription_id
$function$;

REVOKE ALL ON FUNCTION public.my_day_stop_facts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_day_stop_facts(uuid[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.my_day_stop_facts(uuid[]) IS
  'What a stop card shows. open_balance_cents is scoped to the stop: a stay''s own invoice for a night of that stay; otherwise the client''s open invoices less stays not yet started and stay deposits (#653). Migration 20261102150000.';

-- ── What this file establishes, checked from any starting state ───────────
DO $check$
DECLARE
  _src text := (SELECT prosrc FROM pg_proc WHERE oid = 'public.my_day_stop_facts(uuid[])'::regprocedure);
BEGIN
  IF _src NOT LIKE '%st.invoice_id = i.id%' OR _src NOT LIKE '%st.deposit_invoice_id = i.id%'
     OR _src NOT LIKE '%st.starts_on > a.scheduled_on%' THEN
    RAISE EXCEPTION 'my_day_stop_facts still sums every open invoice the client has';
  END IF;
  IF has_function_privilege('anon', 'public.my_day_stop_facts(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.my_day_stop_facts(uuid[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'my_day_stop_facts has the wrong grants';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.my_day_stop_facts(uuid[])'::regprocedure) THEN
    RAISE EXCEPTION 'my_day_stop_facts must stay SECURITY DEFINER: a tech cannot read invoices';
  END IF;
END
$check$;

