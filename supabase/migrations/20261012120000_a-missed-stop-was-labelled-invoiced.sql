-- Issue #421: "Invoiced" must describe this visit, not the customer's
-- payment preference or balance. Expose only whether a real line exists on
-- a non-void invoice; techs still cannot read invoices or invoice lines.
-- A scheduled prepaid visit can later become missed and keep its real line.
-- No invoice rows or billing generation rules are changed here.
-- Preserve the active-staff guard added by 20261009180000.

BEGIN;

-- The return shape changes, so PostgreSQL requires dropping this function.
DROP FUNCTION public.my_day_stop_facts(uuid[]);

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
    SELECT v.id, v.organization_id, v.client_id, v.subscription_id
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
           SELECT sum(GREATEST(COALESCE(i.total_cents, 0) - COALESCE(i.credit_applied_cents, 0), 0))
             FROM public.invoices i
            WHERE i.client_id = a.client_id
              AND i.organization_id = a.organization_id
              AND i.status = 'open'
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

COMMIT;
