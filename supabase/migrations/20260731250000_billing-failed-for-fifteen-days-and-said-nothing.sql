-- Postpaid invoicing produced NOTHING for fifteen days and reported success.
--
-- ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
--
-- 20260716220000 reintroduced a reference to `p.address_line1` in
-- admin_generate_invoice_for_client. That column does not exist — properties
-- has `street`, and 20260701213007 had already fixed this same reference once.
-- So every call raised `column p.address_line1 does not exist`.
--
-- Nobody found out, and the reason is this, in run_billing_cycles:
--
--   EXCEPTION WHEN OTHERS THEN
--     RAISE WARNING 'run_billing_cycles: client % failed: %', _c.client_id, SQLERRM;
--
-- The intent was right — one client's bad data must not stop the whole nightly
-- run. The consequence was not. RAISE WARNING goes to the Postgres log, which
-- pg_cron captures and nobody reads. And the function returns only
-- `_generated`, the SUCCESS count, so a run in which every single client failed
-- returns 0 — the exact same answer as a night when nothing was due.
--
-- Verified in the live database: the newest invoice_line_items row is dated
-- 2026-07-16, the day that migration landed, and 14 completed visits going back
-- to 2026-05-27 have never been billed. Fifteen days of a nightly job reporting
-- a clean run while invoicing every customer for nothing.
--
-- The column is already fixed (20260731210000, which had to replace that
-- function for the deep-clean surcharge and corrected it in passing). This
-- migration fixes the part that let it last fifteen days.
--
-- ── WHY THE REVIEW QUEUE AND NOT A LOG LINE ────────────────────────────────
--
-- BUILD-10 exists precisely because a fact nobody is shown is a fact nobody
-- knows. A billing failure is the highest-consequence thing this system can
-- swallow — it is revenue that silently never gets asked for — so it belongs
-- where the owner already looks, not in a log they would have to think to go
-- and read.
--
-- One row per client per day (the unique key includes the day), so a broken
-- night files one item per affected client rather than one per run per client
-- for ever, and a failure that persists re-files tomorrow instead of being
-- silenced by yesterday's row.
--
-- The signature is unchanged. run_billing_cycles is called by the pg_cron job
-- 'run-billing-cycles' and by hooks/nightly.ts, and both read an integer;
-- changing the return type to carry a failure count would break them both for
-- a number that belongs in the queue anyway.
--
-- Idempotent.

-- The queue's kind list is a CHECK constraint, so a new kind has to be added to
-- it before anything can file one.
ALTER TABLE public.review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
ALTER TABLE public.review_items ADD CONSTRAINT review_items_kind_check CHECK (
  kind = ANY (ARRAY[
    'visit_timestamps_unreliable',
    'visit_started_never_finished',
    'visit_stuck_in_progress',
    'payment_refunded',
    'payment_chargeback',
    'payment_chargeback_won',
    'payment_chargeback_lost',
    'payment_dispute_inquiry',
    'payment_dispute_inquiry_closed',
    'billing_run_failed'
  ])
);

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
  _failed integer := 0;
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
    -- Serialize per client across concurrent engine runs (pg_cron and the
    -- app-side nightly worker overlap by design). Held to end of transaction.
    PERFORM pg_advisory_xact_lock(hashtext('billing:' || _c.client_id::text));

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
      -- One client's failure must not block the rest of the run. That part was
      -- always right. What was missing is that it must not be SILENT either:
      -- this was a RAISE WARNING into a log nobody reads, and it hid fifteen
      -- days in which every invoice failed. See the header.
      _failed := _failed + 1;
      RAISE WARNING 'run_billing_cycles: client % failed: %', _c.client_id, SQLERRM;

      BEGIN
        INSERT INTO public.review_items (
          organization_id, kind, subject_table, subject_id, detected_at, reason, detail
        )
        SELECT c.organization_id,
               'billing_run_failed',
               'clients',
               _c.client_id,
               now(),
               left('Invoicing failed for this client: ' || SQLERRM, 500),
               jsonb_build_object('through', _through, 'sqlstate', SQLSTATE,
                                  'source', 'run_billing_cycles')
          FROM public.clients c WHERE c.id = _c.client_id
        ON CONFLICT DO NOTHING;
      EXCEPTION WHEN OTHERS THEN
        -- Filing the alert must never be the thing that breaks the run.
        RAISE WARNING 'run_billing_cycles: could not file review item for %: %',
          _c.client_id, SQLERRM;
      END;
    END;
  END LOOP;

  IF _failed > 0 THEN
    RAISE WARNING 'run_billing_cycles: % client(s) failed, % invoice(s) generated', _failed, _generated;
  END IF;

  RETURN _generated;
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.run_billing_cycles(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_billing_cycles(uuid) TO service_role;

COMMENT ON FUNCTION public.run_billing_cycles(uuid) IS
  'Nightly postpaid invoicing. A per-client failure is caught so one bad client cannot stop the run, and is filed to the review queue as billing_run_failed — the previous RAISE WARNING went to a log nobody reads and concealed fifteen days in which every invoice failed while the job still reported a clean run.';
