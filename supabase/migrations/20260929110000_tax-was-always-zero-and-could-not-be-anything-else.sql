-- Tax was always zero and could not be anything else.
--
-- There was no sales tax anywhere in HoundStack: no rate on the organization,
-- no exemption on the client, no tax on the invoice. The accountant pack said
-- so in as many words ("Sales tax is not tracked"). For most pet-waste
-- businesses that is the right answer -- a service, and in most states an
-- untaxed one -- but a handful of states do tax it, and an owner in one of
-- them had no way to bill it short of typing it in as a line, where it then
-- counted as revenue, carried a royalty, and was reported as income.
--
-- The owner's decision: "since it's a service, it's typically 0%, but allow it
-- to be changed." So everything here defaults to zero and changes NOTHING for
-- a business until its owner sets a rate.
--
-- ── WHAT IS STORED ─────────────────────────────────────────────────────────
--
--   organizations.sales_tax_rate_bps   basis points, 0..2500 (0% to 25%), default 0
--   organizations.sales_tax_label      what the line says, default 'Sales tax'
--   clients.tax_exempt                 default false
--   invoices.tax_rate_bps              the rate SNAPSHOTTED when the invoice was made
--   invoices.tax_label                 the label snapshotted with it (NULL when no tax)
--   invoices.tax_cents                 the tax on this invoice
--   payments.tax_cents                 the tax share INSIDE amount_cents
--   franchise_royalty_invoices.sales_tax_collected_by_parent_cents
--   accounting_connections.default_sales_tax_account
--
-- invoices.total_cents = subtotal_cents + tax_cents on every invoice this file
-- touches the writer of.
--
-- ── THE RULE, IN ONE PLACE ─────────────────────────────────────────────────
--
-- `set_invoice_totals(invoice, subtotal)` is the only SQL that decides an
-- invoice's tax. Every generating routine calls it instead of writing
-- subtotal_cents and total_cents itself: the postpaid billing run (visits,
-- skip charges, deep-clean surcharges, add-on charges), the office's prepaid
-- invoice, and the customer's portal top-up. Its TypeScript twin is
-- src/lib/sales-tax.ts, which the hand-made invoice and a quote's one-time
-- charges go through.
--
--   * Rate: the organization's, or 0 for a tax-exempt client, read at the
--     moment the invoice is made and stored on it. Changing the setting later
--     never re-prices an invoice already issued.
--   * Base: the whole invoice subtotal, NOT line by line. Rounded once, half
--     away from zero, to the cent: round(subtotal x bps / 10000). Postgres
--     round(numeric) and salesTaxCents() both do exactly that. A negative
--     subtotal is taxed as zero, never as a negative tax.
--   * Credit: account credit applied to an invoice (credit_applied_cents)
--     reduces what is OWED, not the taxable base. The tax is on the sale; how
--     it was paid for does not change it.
--
-- Paths that deliberately carry NO tax, because they write their own totals
-- and are not a sale of service on the day: imported opening balances
-- (historical, already taxed or not wherever they came from), DNA-match fines
-- (a penalty, not a sale), and the demo seed.
--
-- ── TAX IS NOT REVENUE ─────────────────────────────────────────────────────
--
-- Tax collected is a liability to the state, so it must not inflate revenue,
-- the franchise royalty base, or the platform fee. A payment's tax share is
-- identified PRO RATA, the same division refund-split.ts already uses:
--
--     payments.tax_cents = round(amount_cents x invoice.tax_cents / invoice.total_cents)
--
-- capped at the invoice's tax. It sits INSIDE amount_cents, not beside it the
-- way the tip and the card surcharge do, because amount_cents means "money
-- applied to the invoice" and the invoice total includes the tax. So:
--
--     revenue               = amount_cents - tax_cents
--     receivables / AR      = unchanged (a customer owes the tax too)
--
-- A trigger fills payments.tax_cents on every insert, and whenever the amount
-- or the invoice changes, so no payment writer in src/ (the webhook, manual
-- payments, autopay) can forget to. At a rate of zero every invoice has
-- tax_cents = 0, so every payment's share is zero and every revenue figure is
-- byte-identical to before.
--
-- Prepaid credit: a paid top-up grants credit worth what the visits cost --
-- total minus tax -- because each completed prepaid visit debits its
-- pre-tax price. Granting the tax as spendable credit would hand the customer
-- the state's money back as free service.
--
-- Franchise settlements: the royalty is charged on revenue, so on
-- amount_cents - tax_cents. Tax the FRANCHISE collected on a location's
-- behalf belongs to the location (it is the location's liability), so it is
-- added back to what the franchise owes the location and shown as its own
-- figure on the statement.
--
-- Replays into an empty database: columns with defaults, CHECKs, functions, a
-- trigger, and splices into routines earlier migrations in this sequence
-- create. Nothing reads operations state.

-- ── 1 ── settings ──────────────────────────────────────────────────────────
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS sales_tax_rate_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sales_tax_label text NOT NULL DEFAULT 'Sales tax';

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS tax_exempt boolean NOT NULL DEFAULT false;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS tax_rate_bps integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_cents integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_label text;

ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS tax_cents integer NOT NULL DEFAULT 0;

ALTER TABLE public.franchise_royalty_invoices
  ADD COLUMN IF NOT EXISTS sales_tax_collected_by_parent_cents bigint NOT NULL DEFAULT 0;

ALTER TABLE public.accounting_connections
  ADD COLUMN IF NOT EXISTS default_sales_tax_account text;

DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organizations'::regclass
                    AND conname = 'organizations_sales_tax_rate_bps_range') THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_sales_tax_rate_bps_range
      CHECK (sales_tax_rate_bps BETWEEN 0 AND 2500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.organizations'::regclass
                    AND conname = 'organizations_sales_tax_label_length') THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_sales_tax_label_length
      CHECK (char_length(btrim(sales_tax_label)) BETWEEN 1 AND 40);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.invoices'::regclass
                    AND conname = 'invoices_tax_rate_bps_range') THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_tax_rate_bps_range CHECK (tax_rate_bps BETWEEN 0 AND 2500);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.invoices'::regclass
                    AND conname = 'invoices_tax_cents_not_negative') THEN
    ALTER TABLE public.invoices
      ADD CONSTRAINT invoices_tax_cents_not_negative CHECK (tax_cents >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payments'::regclass
                    AND conname = 'payments_tax_cents_not_negative') THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_tax_cents_not_negative CHECK (tax_cents >= 0);
  END IF;
END
$constraints$;

COMMENT ON COLUMN public.organizations.sales_tax_rate_bps IS
  'Sales tax rate in basis points (825 = 8.25%), 0..2500. Default 0: most pet-waste services are not taxable. Applied to invoices made after it is set; never re-prices an issued invoice.';
COMMENT ON COLUMN public.organizations.sales_tax_label IS
  'What the tax line on an invoice says, e.g. "Sales tax" or "Service tax". Snapshotted onto each taxed invoice.';
COMMENT ON COLUMN public.clients.tax_exempt IS
  'No sales tax on this client''s invoices, whatever the organization''s rate.';
COMMENT ON COLUMN public.invoices.tax_rate_bps IS
  'The tax rate this invoice was made at (0 for an exempt client), snapshotted by set_invoice_totals or insertManualInvoice.';
COMMENT ON COLUMN public.invoices.tax_cents IS
  'Sales tax on this invoice: round half away from zero of subtotal_cents x tax_rate_bps / 10000, on the whole subtotal. total_cents = subtotal_cents + tax_cents. A liability, never revenue.';
COMMENT ON COLUMN public.invoices.tax_label IS
  'The organization''s tax label when this invoice was taxed; NULL when tax_cents is 0.';
COMMENT ON COLUMN public.payments.tax_cents IS
  'The sales-tax share INSIDE amount_cents: round(amount_cents x invoice.tax_cents / invoice.total_cents), capped at the invoice tax. Set by tg_payments_tax_share. Revenue is amount_cents - tax_cents.';
COMMENT ON COLUMN public.franchise_royalty_invoices.sales_tax_collected_by_parent_cents IS
  'Sales tax the franchise collected for this location in the period. The location''s liability, so it is owed to the location in full and carries no royalty.';
COMMENT ON COLUMN public.accounting_connections.default_sales_tax_account IS
  'Account an invoice''s sales-tax line is posted to. Required to sync an invoice that carries tax; tax is a liability and must not post to income.';

-- ── 2 ── the arithmetic ────────────────────────────────────────────────────
-- Pure functions, mirrored line for line by src/lib/sales-tax.ts.

CREATE OR REPLACE FUNCTION public.sales_tax_cents(_taxable_cents bigint, _rate_bps integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  -- round(numeric) is half away from zero. Rounded once, on the whole base.
  SELECT CASE
           WHEN COALESCE(_rate_bps, 0) <= 0 OR COALESCE(_taxable_cents, 0) <= 0 THEN 0
           ELSE round(_taxable_cents::numeric * _rate_bps / 10000)::integer
         END
$function$;

CREATE OR REPLACE FUNCTION public.sales_tax_share_cents(
  _amount_cents bigint, _invoice_tax_cents bigint, _invoice_total_cents bigint)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $function$
  -- How much of a payment of _amount_cents is the invoice's tax: pro rata by
  -- the invoice's tax / total, never more than the invoice's tax.
  SELECT CASE
           WHEN COALESCE(_invoice_tax_cents, 0) <= 0
             OR COALESCE(_invoice_total_cents, 0) <= 0
             OR COALESCE(_amount_cents, 0) <= 0 THEN 0
           ELSE LEAST(
                  round(_amount_cents::numeric * _invoice_tax_cents / _invoice_total_cents),
                  _invoice_tax_cents)::integer
         END
$function$;

REVOKE ALL ON FUNCTION public.sales_tax_cents(bigint, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.sales_tax_share_cents(bigint, bigint, bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sales_tax_cents(bigint, integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.sales_tax_share_cents(bigint, bigint, bigint) TO authenticated, service_role;

-- ── 3 ── the one writer of an invoice's totals ─────────────────────────────
CREATE OR REPLACE FUNCTION public.set_invoice_totals(_invoice_id uuid, _subtotal_cents integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  _rate integer;
  _label text;
  _tax integer;
BEGIN
  SELECT CASE WHEN c.tax_exempt THEN 0 ELSE COALESCE(o.sales_tax_rate_bps, 0) END,
         o.sales_tax_label
    INTO _rate, _label
    FROM public.invoices i
    JOIN public.organizations o ON o.id = i.organization_id
    LEFT JOIN public.clients c ON c.id = i.client_id
   WHERE i.id = _invoice_id;

  _rate := COALESCE(_rate, 0);
  _tax := public.sales_tax_cents(GREATEST(COALESCE(_subtotal_cents, 0), 0), _rate);

  UPDATE public.invoices
     SET subtotal_cents = COALESCE(_subtotal_cents, 0),
         tax_rate_bps   = _rate,
         tax_cents      = _tax,
         tax_label      = CASE WHEN _tax > 0 THEN _label ELSE NULL END,
         total_cents    = COALESCE(_subtotal_cents, 0) + _tax,
         updated_at     = now()
   WHERE id = _invoice_id;
END;
$function$;

COMMENT ON FUNCTION public.set_invoice_totals(uuid, integer) IS
  'The one SQL writer of an invoice''s subtotal, tax and total. Snapshots the organization''s rate (0 for a tax-exempt client) onto the invoice. Called by every invoice-generating routine.';

-- Only ever reached from inside the SECURITY DEFINER generators, which run as
-- their owner. Nobody signed in has any business re-pricing an invoice.
REVOKE ALL ON FUNCTION public.set_invoice_totals(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_invoice_totals(uuid, integer) TO service_role;

-- ── 4 ── a payment's tax share, filled for every writer ────────────────────
CREATE OR REPLACE FUNCTION public.tg_payments_tax_share()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE _share integer;
BEGIN
  IF NEW.invoice_id IS NULL THEN
    NEW.tax_cents := 0;
    RETURN NEW;
  END IF;
  SELECT public.sales_tax_share_cents(NEW.amount_cents, i.tax_cents, i.total_cents)
    INTO _share
    FROM public.invoices i
   WHERE i.id = NEW.invoice_id;
  NEW.tax_cents := COALESCE(_share, 0);
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.tg_payments_tax_share() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS payments_tax_share ON public.payments;
CREATE TRIGGER payments_tax_share
  BEFORE INSERT OR UPDATE OF amount_cents, invoice_id ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.tg_payments_tax_share();

-- ── 5 ── prepaid credit is worth the visits, not the tax ───────────────────
CREATE OR REPLACE FUNCTION public.tg_invoice_paid_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'paid' AND OLD.status IS DISTINCT FROM 'paid' AND NEW.kind = 'prepaid_topup' THEN
    -- total - tax: each prepaid visit debits its pre-tax price, so the tax
    -- is not spendable credit. Identical to total_cents when there is no tax.
    PERFORM public.post_credit_entry(
      NEW.organization_id, NEW.client_id, NEW.total_cents - COALESCE(NEW.tax_cents, 0),
      'prepayment', NEW.id, NULL, 'Prepaid invoice payment'
    );
  END IF;
  RETURN NEW;
END; $function$;

REVOKE ALL ON FUNCTION public.tg_invoice_paid_credit() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.reverse_prepaid_credit_for_payment(
  _payment_id uuid,
  _refunded_cents bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  _org uuid; _client uuid; _inv uuid; _kind text; _granted bigint;
  _total bigint; _tax bigint;
  _target bigint; _already bigint; _delta bigint;
BEGIN
  SELECT p.organization_id, i.client_id, p.invoice_id, i.kind::text,
         i.total_cents, COALESCE(i.tax_cents, 0)
    INTO _org, _client, _inv, _kind, _total, _tax
    FROM public.payments p
    JOIN public.invoices i ON i.id = p.invoice_id
   WHERE p.id = _payment_id;

  IF _inv IS NULL OR _kind IS DISTINCT FROM 'prepaid_topup' THEN
    RETURN 0;
  END IF;

  -- What tg_invoice_paid_credit granted: the pre-tax total.
  _granted := COALESCE(_total, 0) - _tax;

  -- The refunded dollars that were credit rather than tax, pro rata -- the
  -- same division that gave the payment its tax share. With no tax this is
  -- the refunded amount itself, which is what this function always used.
  _target := LEAST(
    GREATEST(_refunded_cents - public.sales_tax_share_cents(_refunded_cents, _tax, _total), 0),
    GREATEST(_granted, 0));

  SELECT COALESCE(-SUM(delta_cents), 0) INTO _already
    FROM public.credit_ledger
   WHERE invoice_id = _inv AND kind = 'refund';

  _delta := _target - _already;
  IF _delta = 0 THEN RETURN 0; END IF;

  INSERT INTO public.credit_ledger (organization_id, client_id, delta_cents, kind, invoice_id, note)
  VALUES (_org, _client, -_delta, 'refund', _inv,
          'Prepaid top-up refunded (payment ' || _payment_id::text || ')');

  RETURN _delta;
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_prepaid_credit_for_payment(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reverse_prepaid_credit_for_payment(uuid, bigint) TO service_role;

-- ── 6 ── every generator writes its totals through set_invoice_totals ──────
-- Spliced rather than retyped, the way 20260903150000 changed the postpaid
-- run: each body is long and the change is one statement, and retyping them
-- is a chance to silently drop a line. pg_get_functiondef is only ever handed
-- a named function. Each splice is a no-op on a second run.
DO $splice$
DECLARE
  _def text;
  _new text;
BEGIN
  -- The postpaid billing run: visits, skip charges, deep-clean surcharges and
  -- pending add-on charges, all on one invoice, taxed once on its subtotal.
  _def := pg_get_functiondef('public.admin_generate_invoice_for_client(uuid, date)'::regprocedure);
  IF strpos(_def, 'set_invoice_totals') = 0 THEN
    _new := regexp_replace(_def,
      'UPDATE public\.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now\(\)\s+WHERE id = _invoice_id;',
      'PERFORM public.set_invoice_totals(_invoice_id, _total);');
    IF _new = _def THEN
      RAISE EXCEPTION 'admin_generate_invoice_for_client no longer writes its totals the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;

  -- The office's prepaid invoice.
  _def := pg_get_functiondef('public.generate_prepaid_invoice(uuid, integer)'::regprocedure);
  IF strpos(_def, 'set_invoice_totals') = 0 THEN
    _new := regexp_replace(_def,
      'UPDATE public\.invoices\s+SET subtotal_cents = _total, total_cents = _total, updated_at = now\(\)\s+WHERE id = _invoice_id;',
      'PERFORM public.set_invoice_totals(_invoice_id, _total);');
    IF _new = _def THEN
      RAISE EXCEPTION 'generate_prepaid_invoice no longer writes its totals the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;

  -- The customer's portal top-up. Its period is written in the same UPDATE,
  -- so the totals move to set_invoice_totals and the period stays.
  --
  -- And a second, older fault in the same function, found by the proof for
  -- this one: its INSERT names no period_end, which is NOT NULL and has been
  -- since invoices were created (20260701162450). So every portal top-up has
  -- raised a not-null violation before reaching a line -- the crash
  -- 20260716180000 fixed in generate_prepaid_invoice and did not carry here.
  -- The INSERT now writes today as a placeholder period; the UPDATE after the
  -- loop overwrites both ends with the visits actually bought, as it always
  -- meant to.
  _def := pg_get_functiondef('public.portal_start_prepaid_topup(uuid, uuid, integer)'::regprocedure);
  IF strpos(_def, 'set_invoice_totals') = 0 THEN
    _new := replace(_def,
      'UPDATE public.invoices SET subtotal_cents=_total, total_cents=_total,',
      'PERFORM public.set_invoice_totals(_invoice_id, _total);
  UPDATE public.invoices SET');
    IF _new = _def THEN
      RAISE EXCEPTION 'portal_start_prepaid_topup no longer writes its totals the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;

  _def := pg_get_functiondef('public.portal_start_prepaid_topup(uuid, uuid, integer)'::regprocedure);
  IF strpos(_def, '''prepaid_topup'', now(), current_date, current_date)') = 0 THEN
    _new := regexp_replace(_def,
      'INSERT INTO public\.invoices\(organization_id, client_id, status, kind, issued_at\)\s+VALUES \(_org, _cid, ''open'', ''prepaid_topup'', now\(\)\)',
      'INSERT INTO public.invoices(organization_id, client_id, status, kind, issued_at, period_start, period_end)
    VALUES (_org, _cid, ''open'', ''prepaid_topup'', now(), current_date, current_date)');
    IF _new = _def THEN
      RAISE EXCEPTION 'portal_start_prepaid_topup no longer inserts its invoice the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;
END
$splice$;

-- ── 7 ── revenue figures in SQL exclude the tax ────────────────────────────
DO $revenue$
DECLARE
  _def text;
  _new text;
BEGIN
  -- The franchise dashboard's month-to-date revenue per location.
  _def := pg_get_functiondef('public.franchise_rollup(uuid)'::regprocedure);
  IF strpos(_def, 'p.amount_cents - p.tax_cents') = 0 THEN
    _new := replace(_def,
      'SELECT SUM(p.amount_cents)::bigint FROM public.payments p',
      'SELECT SUM(p.amount_cents - p.tax_cents)::bigint FROM public.payments p');
    IF _new = _def THEN
      RAISE EXCEPTION 'franchise_rollup no longer sums payments the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;

  -- Client lifetime value, and the revenue a churn reason puts at risk. Both
  -- sum paid invoices, so both take the tax back out.
  _def := pg_get_functiondef('public.client_ltv(uuid, integer)'::regprocedure);
  IF strpos(_def, 'i.total_cents - i.tax_cents') = 0 THEN
    _new := replace(_def, 'SUM(i.total_cents)', 'SUM(i.total_cents - i.tax_cents)');
    IF _new = _def THEN
      RAISE EXCEPTION 'client_ltv no longer sums invoices the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;

  _def := pg_get_functiondef('public.churn_drivers(uuid)'::regprocedure);
  IF strpos(_def, 'i.total_cents - i.tax_cents') = 0 THEN
    _new := replace(_def, 'SUM(i.total_cents)', 'SUM(i.total_cents - i.tax_cents)');
    IF _new = _def THEN
      RAISE EXCEPTION 'churn_drivers no longer sums invoices the way this splice expects; re-cut it against the current body.';
    END IF;
    EXECUTE _new;
  END IF;
END
$revenue$;

-- ── 8 ── the royalty is on revenue; the location's tax goes to the location ──
-- Retyped in full from 20260819140000 (the whole CTE chain changes shape), with
-- four changes, each marked SALES TAX below.
CREATE OR REPLACE FUNCTION public.generate_franchise_settlements(_parent uuid, _start date, _end date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _n integer := 0;
  _tz text;
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
    OR public.is_platform_admin(auth.uid())
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can generate settlements.';
  END IF;

  -- The role check settled WHO may act; this settles whether the organization
  -- bought the capability. Second, never first.
  --
  -- Two callers are exempt and both are deliberate. `service_role` is the
  -- nightly job: the owner decided that billing a lapsed customer's statements
  -- is a separate question from letting them reconfigure the franchise, so the
  -- cron keeps generating for everyone. A platform admin is not a tenant and
  -- has no plan of their own, so gating them here would gate the operator on
  -- the customer's purchase — the same reasoning 20260731230000 gives for
  -- leaving franchise_signals alone.
  IF auth.role() IS DISTINCT FROM 'service_role'
     AND NOT public.is_platform_admin(auth.uid())
     AND NOT public.has_plan_entitlement(_parent, 'franchise_structure') THEN
    RAISE EXCEPTION 'PLAN_UPGRADE_REQUIRED: Franchise management is included on Enterprise and above. This organization is on %.',
      initcap(public.plan_tier_for_org(_parent));
  END IF;

  IF _end <= _start THEN
    RAISE EXCEPTION 'The period end must be after its start.';
  END IF;

  -- The PARENT's clock, deliberately, and unchanged by the 2026-08-19 rollup
  -- decision: a settlement period is one document covering every location, so
  -- it needs one pair of boundaries. `franchise_rollup` is the opposite case —
  -- a per-location row, which now cuts its month on the location's own clock.
  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;
  _from := _start::timestamp AT TIME ZONE _tz;
  _to   := _end::timestamp   AT TIME ZONE _tz;

  WITH kids AS (
    SELECT o.id,
           -- A SETTLED period keeps the rate it was settled at. There is no
           -- rate-history table, so the statement IS the history — but only
           -- once it has left draft, because only then has anyone been told a
           -- number. While it is still a draft the current rate wins, which is
           -- the whole point of regenerating: an owner who fixes a percentage
           -- and presses Generate is asking for exactly that.
           --
           -- Without `<> 'draft'` this coalesce and the `WHERE status =
           -- 'draft'` on the upsert below cover opposite halves of the set,
           -- and the freeze lands on the only half the generator can write.
           coalesce(
             (SELECT fri.royalty_percent
                FROM public.franchise_royalty_invoices fri
               WHERE fri.child_organization_id = o.id
                 AND fri.period_start = _start
                 AND fri.period_end   = _end
                 AND fri.status <> 'draft'),
             o.franchise_royalty_percent,
             0
           ) AS pct
    FROM public.organizations o WHERE o.parent_organization_id = _parent
  ),
  rev AS (
    -- SALES TAX (1 of 4): revenue is amount_cents - tax_cents. The tax share
    -- of a payment is a liability to the state, not the location's income,
    -- so it carries no royalty. Zero on every payment until a rate is set.
    SELECT k.id AS child, k.pct,
           coalesce(sum(p.amount_cents - p.tax_cents) FILTER (WHERE p.collected_by_organization_id = _parent), 0)::bigint AS by_parent,
           coalesce(sum(p.amount_cents - p.tax_cents) FILTER (WHERE p.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS by_location,
           coalesce(sum(p.amount_cents - p.tax_cents), 0)::bigint AS total,
           -- SALES TAX (2 of 4): the tax the FRANCHISE's account took in on
           -- this location's behalf. The location owes it to the state, so the
           -- franchise owes it to the location, in full.
           coalesce(sum(p.tax_cents) FILTER (WHERE p.collected_by_organization_id = _parent), 0)::bigint AS tax_by_parent
    FROM kids k
    LEFT JOIN public.payments p
      ON p.organization_id = k.id
     AND p.status IN ('succeeded', 'refunded')
     AND p.created_at >= _from
     AND p.created_at <  _to
    GROUP BY k.id, k.pct
  ),
  adj AS (
    SELECT fa.child_organization_id AS child,
           coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = _parent), 0)::bigint AS loc_owes,
           coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS fran_owes
    FROM public.franchise_adjustments fa
    LEFT JOIN public.franchise_royalty_invoices fri ON fri.id = fa.applied_settlement_id
    WHERE fa.parent_organization_id = _parent
      -- Only what was already known when the period closed. Without this an
      -- adjustment landed on whichever statement happened to be cut first.
      AND fa.created_at < _to
      AND (
        fa.status = 'pending'
        OR (fa.status = 'applied'
            AND fri.period_start = _start
            AND fri.period_end = _end
            AND fri.status = 'draft')
      )
    GROUP BY fa.child_organization_id
  ),
  calc AS (
    SELECT r.child, r.pct, r.by_parent, r.by_location, r.total, r.tax_by_parent,
           round(r.total * r.pct / 100.0)::bigint AS royalty,
           coalesce(a.loc_owes, 0) AS loc_owes,
           coalesce(a.fran_owes, 0) AS fran_owes,
           -- SALES TAX (3 of 4): the location's tax, held by the franchise,
           -- moves to the location with its revenue.
           (r.by_parent + r.tax_by_parent
            - round(r.total * r.pct / 100.0)
            - coalesce(a.loc_owes, 0)
            + coalesce(a.fran_owes, 0))::bigint AS balance
    FROM rev r LEFT JOIN adj a ON a.child = r.child
  ),
  ins AS (
    -- SALES TAX (4 of 4): recorded on the statement, so its arithmetic can
    -- still be checked from the numbers printed on it.
    INSERT INTO public.franchise_royalty_invoices (
      parent_organization_id, child_organization_id, period_start, period_end,
      revenue_cents, royalty_percent, amount_cents,
      direction, royalty_cents, net_due_cents,
      revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
      adjustments_applied_cents, status, created_by,
      sales_tax_collected_by_parent_cents
    )
    SELECT _parent, child, _start, _end,
           total, pct, royalty,
           CASE WHEN balance > 0 THEN 'franchise_owes_location'
                WHEN balance < 0 THEN 'location_owes_franchise'
                ELSE 'settled' END,
           royalty, abs(balance),
           by_parent, by_location,
           loc_owes - fran_owes, 'draft', auth.uid(),
           tax_by_parent
    FROM calc
    ON CONFLICT (child_organization_id, period_start, period_end) DO UPDATE
      SET revenue_cents = EXCLUDED.revenue_cents,
          royalty_percent = EXCLUDED.royalty_percent,
          amount_cents = EXCLUDED.amount_cents,
          direction = EXCLUDED.direction,
          royalty_cents = EXCLUDED.royalty_cents,
          net_due_cents = EXCLUDED.net_due_cents,
          revenue_collected_by_parent_cents = EXCLUDED.revenue_collected_by_parent_cents,
          revenue_collected_by_location_cents = EXCLUDED.revenue_collected_by_location_cents,
          adjustments_applied_cents = EXCLUDED.adjustments_applied_cents,
          sales_tax_collected_by_parent_cents = EXCLUDED.sales_tax_collected_by_parent_cents
      WHERE public.franchise_royalty_invoices.status = 'draft'
    RETURNING id, child_organization_id
  ),
  consume AS (
    UPDATE public.franchise_adjustments fa
       SET status = 'applied', applied_settlement_id = i.id
      FROM ins i
     WHERE fa.child_organization_id = i.child_organization_id
       AND fa.parent_organization_id = _parent
       AND fa.status = 'pending'
       -- Must match `adj` exactly. Consuming something the statement did not
       -- count would strand it, which is defect 1 by another route.
       AND fa.created_at < _to
    RETURNING fa.id
  )
  SELECT count(*)::integer INTO _n FROM ins;

  RETURN _n;
END;
$function$;

-- Re-stated so this file is safe on its own: owners call it by RPC, the
-- nightly job as service_role, and nobody anonymous at all.
REVOKE ALL ON FUNCTION public.generate_franchise_settlements(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.generate_franchise_settlements(uuid, date, date) TO authenticated, service_role;

-- ── what this file establishes ─────────────────────────────────────────────
-- Every assertion is about what this file just did, so a replay into an empty
-- database proves all of it from any starting state.
DO $check$
DECLARE
  _src text;
  _fn text;
BEGIN
  -- Defaults that change nothing.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'organizations'
                    AND column_name = 'sales_tax_rate_bps' AND is_nullable = 'NO'
                    AND column_default = '0') THEN
    RAISE EXCEPTION 'organizations.sales_tax_rate_bps is missing, nullable, or does not default to 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'clients'
                    AND column_name = 'tax_exempt' AND is_nullable = 'NO'
                    AND column_default = 'false') THEN
    RAISE EXCEPTION 'clients.tax_exempt is missing, nullable, or does not default to false';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'invoices'
                    AND column_name = 'tax_cents' AND is_nullable = 'NO'
                    AND column_default = '0') THEN
    RAISE EXCEPTION 'invoices.tax_cents is missing, nullable, or does not default to 0';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'payments'
                    AND column_name = 'tax_cents' AND is_nullable = 'NO'
                    AND column_default = '0') THEN
    RAISE EXCEPTION 'payments.tax_cents is missing, nullable, or does not default to 0';
  END IF;

  -- The arithmetic, asked directly. Half away from zero on the whole base.
  IF public.sales_tax_cents(10000, 825) <> 825
     OR public.sales_tax_cents(1, 5000) <> 1          -- 0.5 rounds up
     OR public.sales_tax_cents(3, 1666) <> 0          -- 0.4998 rounds down
     OR public.sales_tax_cents(10000, 0) <> 0
     OR public.sales_tax_cents(-500, 825) <> 0 THEN
    RAISE EXCEPTION 'sales_tax_cents does not round half away from zero on the whole base';
  END IF;
  IF public.sales_tax_share_cents(10825, 825, 10825) <> 825
     OR public.sales_tax_share_cents(5000, 825, 10825) <> 381
     OR public.sales_tax_share_cents(99999, 825, 10825) <> 825
     OR public.sales_tax_share_cents(5000, 0, 5000) <> 0 THEN
    RAISE EXCEPTION 'sales_tax_share_cents is not a capped pro-rata share';
  END IF;

  -- Every generator goes through the one writer.
  FOREACH _fn IN ARRAY ARRAY['admin_generate_invoice_for_client', 'generate_prepaid_invoice',
                             'portal_start_prepaid_topup'] LOOP
    SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = _fn;
    IF _src NOT LIKE '%set_invoice_totals(_invoice_id, _total)%' THEN
      RAISE EXCEPTION '% does not write its totals through set_invoice_totals', _fn;
    END IF;
    IF _src ~* 'total_cents\s*=\s*_total' THEN
      RAISE EXCEPTION '% still writes total_cents itself', _fn;
    END IF;
  END LOOP;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_start_prepaid_topup';
  IF _src NOT LIKE '%issued_at, period_start, period_end)%' THEN
    RAISE EXCEPTION 'portal_start_prepaid_topup still inserts an invoice with no period_end, which is NOT NULL';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_franchise_settlements';
  IF _src NOT LIKE '%sum(p.amount_cents - p.tax_cents), 0)::bigint AS total%' THEN
    RAISE EXCEPTION 'the royalty base still includes sales tax';
  END IF;
  IF _src NOT LIKE '%r.by_parent + r.tax_by_parent%' THEN
    RAISE EXCEPTION 'tax the franchise collected is not passed to the location';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'franchise_rollup';
  IF _src NOT LIKE '%SUM(p.amount_cents - p.tax_cents)%' THEN
    RAISE EXCEPTION 'franchise_rollup still counts sales tax as revenue';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_invoice_paid_credit';
  IF _src NOT LIKE '%NEW.total_cents - COALESCE(NEW.tax_cents, 0)%' THEN
    RAISE EXCEPTION 'a paid top-up still grants its tax as spendable credit';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                  WHERE tgrelid = 'public.payments'::regclass
                    AND tgname = 'payments_tax_share' AND NOT tgisinternal) THEN
    RAISE EXCEPTION 'payments has no tax-share trigger';
  END IF;

  -- Nothing here that writes money is reachable by a stranger.
  IF has_function_privilege('anon', 'public.set_invoice_totals(uuid, integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.set_invoice_totals(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'set_invoice_totals is callable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.tg_payments_tax_share()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.tg_payments_tax_share()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_payments_tax_share is callable by anon or authenticated';
  END IF;
  IF has_function_privilege('anon', 'public.generate_franchise_settlements(uuid, date, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'generate_franchise_settlements is callable by anon';
  END IF;

  RAISE NOTICE 'sales tax is configurable, defaults to zero, and stays out of revenue.';
END
$check$;
