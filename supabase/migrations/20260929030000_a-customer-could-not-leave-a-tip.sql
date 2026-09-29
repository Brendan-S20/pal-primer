-- A customer could not leave a tip.
--
-- Jobber and Housecall Pro both let a homeowner add a tip on the pay screen,
-- and pet-waste operators ask for it: the person in the yard every week is
-- the one a customer wants to thank. HoundStack had no tip anywhere.
--
-- Three things here.
--
-- 1. organizations.tips_enabled -- the tenant's switch. Defaults ON for every
--    organization created from now on and is switched OFF for the ones that
--    already exist, the same rollout as notify_email_visit_reminder
--    (20260928040000): a business that is live today should not find a new
--    question on its customers' pay screen that the owner never chose.
--
-- 2. payments.tip_cents -- the tip, BESIDE amount_cents and never inside it.
--    amount_cents keeps meaning exactly one thing, money applied to the
--    invoice, which is the rule surcharge_cents was added under
--    (20260803163000). Every revenue figure, royalty base and AR number sums
--    amount_cents, so none of them moves. The Stripe charge is
--    amount_cents + surcharge_cents + tip_cents.
--
-- 3. payments.tip_staff_id and tip_staff_for_invoice() -- who the tip was for.
--    The technician on the most recent COMPLETED visit billed on the invoice,
--    when one is known. Invoice lines carry visit_id, so this is a lookup
--    rather than a guess; an invoice with no completed, assigned visit on it
--    (a manual invoice, a prepaid top-up) records no one, and the tip still
--    shows on the invoice and in the reports.
--
-- Replays into an empty database: two columns with defaults, one nullable
-- reference, an index, a CHECK, an UPDATE that touches no rows when there are
-- none, and a function. Nothing here reads operations state.

-- ── 1 ── the tenant's switch ───────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS tips_enabled boolean NOT NULL DEFAULT true;

UPDATE public.organizations SET tips_enabled = false;

COMMENT ON COLUMN public.organizations.tips_enabled IS
  'Offer customers a tip (none / 10 / 15 / 20 percent / custom) on the pay link and the portal pay screen. Off for organizations that existed on 2026-09-29, on by default after.';

-- ── 2 ── the tip is not invoice money ──────────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS tip_cents integer NOT NULL DEFAULT 0;

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payments'::regclass
       AND conname = 'payments_tip_cents_not_negative'
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_tip_cents_not_negative CHECK (tip_cents >= 0);
  END IF;
END
$constraint$;

COMMENT ON COLUMN public.payments.tip_cents IS
  'Tip the customer added, included in the Stripe charge but NOT in amount_cents. amount_cents remains money applied to the invoice, so revenue, AR, royalties and the platform fee are unchanged by tipping. A tip is never surcharged.';

-- ── 3 ── who it was for ────────────────────────────────────────────────────
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS tip_staff_id uuid REFERENCES public.staff(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.payments.tip_staff_id IS
  'Technician the tip is attributed to: the assigned tech on the most recent completed visit billed on the invoice (tip_staff_for_invoice). NULL when no such visit exists. Written by the service-role payment path only.';

-- Covers the foreign key, and it is the Timesheets page's read: tips per
-- person in a week.
CREATE INDEX IF NOT EXISTS payments_tip_staff_id_paid_at_idx
  ON public.payments (tip_staff_id, paid_at)
  WHERE tip_cents > 0;

CREATE OR REPLACE FUNCTION public.tip_staff_for_invoice(_invoice_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  -- The most recent completed visit billed on this invoice, and its tech.
  -- Same organization as the invoice, so a line pointing across tenants (it
  -- cannot today, but the join does not assume it) never attributes a tip to
  -- somebody else's staff. Ties on completed_at fall to the later scheduled
  -- day, then to id, so the answer is the same every time it is asked.
  SELECT v.assigned_staff_id
    FROM public.invoice_line_items li
    JOIN public.invoices i ON i.id = li.invoice_id
    JOIN public.visits v ON v.id = li.visit_id AND v.organization_id = i.organization_id
   WHERE li.invoice_id = _invoice_id
     AND v.status = 'completed'
     AND v.assigned_staff_id IS NOT NULL
   ORDER BY v.completed_at DESC NULLS LAST, v.scheduled_on DESC, v.id DESC
   LIMIT 1
$function$;

-- The payment writer runs as service_role. Nobody signed in, and nobody
-- anonymous, has any business asking who worked a given invoice.
REVOKE ALL ON FUNCTION public.tip_staff_for_invoice(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tip_staff_for_invoice(uuid) TO service_role;

-- What this file establishes.
DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'organizations'
       AND column_name = 'tips_enabled' AND is_nullable = 'NO' AND column_default = 'true'
  ) THEN
    RAISE EXCEPTION 'organizations.tips_enabled is missing, nullable, or does not default to true';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payments'
       AND column_name = 'tip_cents' AND is_nullable = 'NO' AND column_default = '0'
  ) THEN
    RAISE EXCEPTION 'payments.tip_cents is missing, nullable, or does not default to 0';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.payments'::regclass
       AND conname = 'payments_tip_cents_not_negative' AND contype = 'c'
  ) THEN
    RAISE EXCEPTION 'payments.tip_cents has no non-negative CHECK';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'payments'
       AND column_name = 'tip_staff_id'
  ) THEN
    RAISE EXCEPTION 'payments.tip_staff_id is missing';
  END IF;

  IF has_function_privilege('anon', 'public.tip_staff_for_invoice(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tip_staff_for_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'tip_staff_for_invoice is callable by anon or authenticated';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.tip_staff_for_invoice(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'tip_staff_for_invoice is not callable by service_role';
  END IF;
END
$check$;
