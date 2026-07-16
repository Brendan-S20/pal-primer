-- Full auto billing with grace (owner-confirmed product decision).
--
-- Clients are billed for completed visits on a per-client cadence
-- (clients.billing_frequency). A daily engine (run_billing_cycles, pg_cron)
-- generates invoices when a client's cycle has ended. Generated invoices get
-- send_after = generation date + the org's invoice_grace_days: a grace window
-- where owners can review/edit/force-send before the invoice email goes out
-- automatically. Auto-send itself happens app-side (only app code can render
-- email templates): the existing nightly worker
-- (src/routes/api/public/hooks/nightly.ts) enqueues the invoice-sent email
-- for open invoices with sent_at null and send_after <= today, then stamps
-- sent_at (idempotent; same idempotency key as the manual send action, so the
-- email pipeline dedupes manual + auto sends of the same invoice).

-- ── 1. Schema ────────────────────────────────────────────────────────────────

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS billing_frequency text NOT NULL DEFAULT 'monthly'
    CHECK (billing_frequency IN ('after_each_visit', 'weekly', 'monthly', 'quarterly', 'yearly'));

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS invoice_grace_days integer NOT NULL DEFAULT 3
    CHECK (invoice_grace_days BETWEEN 0 AND 30);

-- send_after: date the invoice email auto-sends (null for invoices created by
-- manual paths - those are sent explicitly by staff).
-- sent_at: when the invoice email was enqueued (manual send or auto-send).
-- Guards the send loop against double emails.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS send_after date;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_invoices_pending_auto_send
  ON public.invoices (organization_id, send_after)
  WHERE status = 'open' AND sent_at IS NULL AND send_after IS NOT NULL;

-- Full auto billing is now the default behavior. auto_invoice_enabled remains
-- as an org-level escape hatch, but it defaults on and existing orgs are
-- switched on (the manual "Generate from visits" workflow retires from
-- day-to-day use).
ALTER TABLE public.organizations ALTER COLUMN auto_invoice_enabled SET DEFAULT true;
UPDATE public.organizations SET auto_invoice_enabled = true WHERE auto_invoice_enabled = false;

-- ── 2. Per-client generation impl (reused by RPC + engine) ──────────────────
--
-- admin_generate_invoice_for_client is the exact selection/pricing logic of
-- the user-facing generate_invoice_for_client RPC (completed postpaid visits
-- + billable skips without line items, plus pending addon charges), minus the
-- permission check, and returning NULL instead of raising when there is
-- nothing to bill. generate_invoice_for_client is redefined below as a thin
-- permission-checked wrapper so the two paths can never drift.

CREATE OR REPLACE FUNCTION public.admin_generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _invoice_id uuid; _v record; _a record;
  _total integer := 0; _min_date date; _max_date date;
  _visit_count integer := 0; _addon_count integer := 0;
  _li_id uuid; _addon_min date; _addon_max date;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;

  SELECT COUNT(*), MIN(v.scheduled_on), MAX(v.scheduled_on)
    INTO _visit_count, _min_date, _max_date
    FROM public.visits v
    JOIN public.subscriptions s ON s.id = v.subscription_id
    LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
   WHERE v.client_id = _client_id
     AND v.scheduled_on <= _through
     AND li.id IS NULL
     AND s.billing_cadence = 'postpaid'
     AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true));

  SELECT COUNT(*), MIN(occurred_on), MAX(occurred_on)
    INTO _addon_count, _addon_min, _addon_max
    FROM public.addon_charges
   WHERE client_id = _client_id
     AND status = 'pending'
     AND occurred_on <= _through;

  IF _visit_count = 0 AND _addon_count = 0 THEN
    RETURN NULL;
  END IF;

  IF _addon_count > 0 THEN
    _min_date := LEAST(COALESCE(_min_date, _addon_min), _addon_min);
    _max_date := GREATEST(COALESCE(_max_date, _addon_max), _addon_max);
  END IF;

  INSERT INTO public.invoices(organization_id, client_id, period_start, period_end, status, kind, issued_at)
  VALUES (_org, _client_id, _min_date, _max_date, 'open', 'postpaid', now())
  RETURNING id INTO _invoice_id;

  FOR _v IN
    SELECT v.id AS visit_id, v.subscription_id, v.scheduled_on, v.status,
           v.skip_charge_cents, v.skip_reason_code,
           s.price_cents, p.address_line1
      FROM public.visits v
      JOIN public.subscriptions s ON s.id = v.subscription_id
      LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
     WHERE v.client_id = _client_id
       AND v.scheduled_on <= _through
       AND li.id IS NULL
       AND s.billing_cadence = 'postpaid'
       AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
     ORDER BY v.scheduled_on
  LOOP
    DECLARE _amt integer; _desc text;
    BEGIN
      IF _v.status = 'skipped' THEN
        _amt := COALESCE(_v.skip_charge_cents, 0);
        _desc := 'Skipped visit ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || ' (' || COALESCE(_v.skip_reason_code::text,'other') || ')';
      ELSE
        _amt := COALESCE(_v.price_cents, 0);
        _desc := 'Service on ' || to_char(_v.scheduled_on, 'YYYY-MM-DD') || COALESCE(' - ' || _v.address_line1, '');
      END IF;
      INSERT INTO public.invoice_line_items(invoice_id, visit_id, subscription_id, description, amount_cents)
      VALUES (_invoice_id, _v.visit_id, _v.subscription_id, _desc, _amt);
      _total := _total + _amt;
    END;
  END LOOP;

  FOR _a IN
    SELECT * FROM public.addon_charges
     WHERE client_id = _client_id AND status = 'pending' AND occurred_on <= _through
     ORDER BY occurred_on
  LOOP
    INSERT INTO public.invoice_line_items(invoice_id, subscription_id, description, amount_cents)
    VALUES (_invoice_id, NULL,
      _a.description || ' (' || to_char(_a.occurred_on,'YYYY-MM-DD') || ')' ||
      CASE WHEN _a.quantity > 1 THEN ' x ' || _a.quantity ELSE '' END,
      _a.amount_cents)
    RETURNING id INTO _li_id;

    UPDATE public.addon_charges
       SET status = 'invoiced', invoice_line_item_id = _li_id, updated_at = now()
     WHERE id = _a.id;
    _total := _total + _a.amount_cents;
  END LOOP;

  UPDATE public.invoices SET subtotal_cents = _total, total_cents = _total, updated_at = now()
   WHERE id = _invoice_id;
  RETURN _invoice_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_generate_invoice_for_client(uuid, date) TO service_role;

-- User-facing RPC: same signature and error contract as before, now a wrapper
-- around the shared impl so manual and automatic generation cannot diverge.
CREATE OR REPLACE FUNCTION public.generate_invoice_for_client(_client_id uuid, _through date)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _org uuid; _invoice_id uuid;
BEGIN
  SELECT organization_id INTO _org FROM public.clients WHERE id = _client_id;
  IF _org IS NULL THEN RAISE EXCEPTION 'Client not found'; END IF;
  IF NOT public.has_permission(auth.uid(), _org, 'manage_client_billing') THEN RAISE EXCEPTION 'Not authorized'; END IF;
  _invoice_id := public.admin_generate_invoice_for_client(_client_id, _through);
  IF _invoice_id IS NULL THEN
    RAISE EXCEPTION 'No unbilled items for this client through %', _through;
  END IF;
  RETURN _invoice_id;
END;
$function$;

-- ── 3. The billing cycle engine ──────────────────────────────────────────────
--
-- EXACT CYCLE RULE (per active client with unbilled billables, where a
-- "billable" is a completed postpaid visit, a billable skipped visit, or a
-- pending addon charge):
--
--   after_each_visit: generate whenever any billable exists, through today.
--     With the daily cron this yields one invoice per day-batch of completed
--     visits (a visit completed today is invoiced on tonight's run).
--
--   weekly / monthly / quarterly / yearly: generate when the OLDEST unbilled
--     billable falls before the start of the CURRENT cadence period, i.e. the
--     period containing that billable has fully ended:
--       weekly    -> date_trunc('week', today)     (ISO week, Monday start)
--       monthly   -> date_trunc('month', today)    (1st of month)
--       quarterly -> date_trunc('quarter', today)  (Jan/Apr/Jul/Oct 1st)
--       yearly    -> date_trunc('year', today)     (Jan 1)
--     The invoice covers billables through (current period start - 1 day), so
--     the still-running period's visits stay unbilled until their own cycle
--     ends. This "oldest billable is older than the current period" rule is
--     robust to missed cron days: a run on the 3rd still bills last month.
--
-- Generated invoices get send_after = current_date + org.invoice_grace_days
-- (the review/edit/force-send grace window). Idempotency: billables get
-- invoice line items (or addon status 'invoiced') on generation, so a client
-- disappears from the candidate set once billed; re-running any given day is
-- a no-op.
--
-- _org_id: null = every org (pg_cron path); non-null = one org (nightly
-- worker path). Orgs can opt out via auto_invoice_enabled = false.

CREATE OR REPLACE FUNCTION public.run_billing_cycles(_org_id uuid DEFAULT NULL)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _c record;
  _period_start date;
  _through date;
  _invoice_id uuid;
  _generated integer := 0;
BEGIN
  FOR _c IN
    SELECT c.id AS client_id,
           c.billing_frequency,
           o.invoice_grace_days,
           x.oldest_billable
      FROM (
        SELECT b.client_id, MIN(b.item_on) AS oldest_billable
          FROM (
            SELECT v.client_id, v.organization_id, v.scheduled_on AS item_on
              FROM public.visits v
              JOIN public.subscriptions s ON s.id = v.subscription_id
              LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
             WHERE li.id IS NULL
               AND s.billing_cadence = 'postpaid'
               AND (v.status = 'completed' OR (v.status = 'skipped' AND v.skip_billable = true))
            UNION ALL
            SELECT ac.client_id, ac.organization_id, ac.occurred_on
              FROM public.addon_charges ac
             WHERE ac.status = 'pending'
               AND public.client_default_billing_cadence(ac.client_id) = 'postpaid'
          ) b
         WHERE (_org_id IS NULL OR b.organization_id = _org_id)
         GROUP BY b.client_id
      ) x
      JOIN public.clients c ON c.id = x.client_id AND c.active = true
      JOIN public.organizations o ON o.id = c.organization_id
     WHERE o.auto_invoice_enabled = true
  LOOP
    IF _c.billing_frequency = 'after_each_visit' THEN
      _through := current_date;
    ELSE
      _period_start := CASE _c.billing_frequency
        WHEN 'weekly'    THEN date_trunc('week', current_date)::date
        WHEN 'monthly'   THEN date_trunc('month', current_date)::date
        WHEN 'quarterly' THEN date_trunc('quarter', current_date)::date
        WHEN 'yearly'    THEN date_trunc('year', current_date)::date
      END;
      IF _period_start IS NULL OR _c.oldest_billable >= _period_start THEN
        CONTINUE; -- the oldest billable's cadence period has not ended yet
      END IF;
      _through := _period_start - 1;
    END IF;

    BEGIN
      _invoice_id := public.admin_generate_invoice_for_client(_c.client_id, _through);
      IF _invoice_id IS NOT NULL THEN
        UPDATE public.invoices
           SET send_after = current_date + COALESCE(_c.invoice_grace_days, 3)
         WHERE id = _invoice_id;
        _generated := _generated + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One client's failure must not block the rest of the run.
      RAISE WARNING 'run_billing_cycles: client % failed: %', _c.client_id, SQLERRM;
    END;
  END LOOP;

  RETURN _generated;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.run_billing_cycles(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_billing_cycles(uuid) TO service_role;

-- ── 4. pg_cron schedule ──────────────────────────────────────────────────────
--
-- Daily at 06:10 UTC (before typical US business hours; the app-side nightly
-- worker also invokes run_billing_cycles per org, and the whole engine is
-- idempotent, so overlap is harmless). Guarded against double-scheduling by
-- job name, and skipped gracefully where pg_cron is unavailable (local dev).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'run-billing-cycles') THEN
      PERFORM cron.schedule('run-billing-cycles', '10 6 * * *', 'SELECT public.run_billing_cycles();');
    END IF;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron scheduling skipped: %', SQLERRM;
END $$;
