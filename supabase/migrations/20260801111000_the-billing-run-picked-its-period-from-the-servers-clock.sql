-- The billing run picked its period from the server's clock.
--
-- `run_billing_cycles` decided which period to invoice with `current_date`,
-- four times:
--
--     _through    := current_date;                               -- after_each_visit
--     _period_start := date_trunc('week'|'month'|..., current_date)::date;
--     send_after  := current_date + invoice_grace_days;
--
-- `current_date` resolves in the SESSION's timezone, which is UTC on this
-- database while every organization is America/Chicago. Same defect as
-- `tg_set_invoice_due_on` in the migration before this one, and the same one
-- the franchise rollup's comment already calls out as having "appeared five
-- times in this codebase".
--
-- ── HOW BADLY, HONESTLY ───────────────────────────────────────────────────
--
-- Less badly than it looks, and worth saying so rather than dressing it up.
-- The `run-billing-cycles` cron fires at 06:10 UTC, which is 01:10 in Chicago
-- — the same calendar day in both zones. So for the organizations that exist
-- today, on the schedule that exists today, this produces the right answer.
--
-- It is wrong the moment any of that changes:
--
--   * an organization east of UTC — 06:10 UTC is already past midnight for
--     them, so the run lands on the wrong side of a month boundary;
--   * anyone invoking it by hand during a working evening, which is exactly
--     when someone chasing a billing question would;
--   * the cron being rescheduled, which is a one-line change with no visible
--     connection to invoicing periods.
--
-- A month boundary decided by the server's clock means a client billed for
-- the wrong month: visits from the 1st fall into the previous period, or the
-- period closes a day early and they are billed twice.
--
-- ── THE FIX ───────────────────────────────────────────────────────────────
--
-- The organization is already joined in the loop's query, so its timezone
-- comes along for free. Every `current_date` becomes the calendar day in that
-- organization's zone. `coalesce(timezone, 'America/Chicago')` matches
-- DEFAULT_ORG_TIMEZONE in src/lib/org-day.ts and the default in
-- `organizations.timezone` — three places that must agree, and now do.

CREATE OR REPLACE FUNCTION public.run_billing_cycles(_org_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _c record;
  _period_start date;
  _through date;
  _today date;
  _invoice_id uuid;
  _generated integer := 0;
  _failed integer := 0;
BEGIN
  FOR _c IN
    SELECT c.id AS client_id,
           c.billing_frequency,
           o.invoice_grace_days,
           coalesce(o.timezone, 'America/Chicago') AS org_tz,
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
    PERFORM pg_advisory_xact_lock(hashtext('billing:' || _c.client_id::text));

    -- The billing period belongs to the ORGANIZATION's calendar, not the
    -- database session's. current_date is UTC here and every org is Chicago.
    _today := (now() AT TIME ZONE _c.org_tz)::date;

    IF _c.billing_frequency = 'after_each_visit' THEN
      _through := _today;
    ELSE
      _period_start := CASE _c.billing_frequency
        WHEN 'weekly'    THEN date_trunc('week', _today)::date
        WHEN 'monthly'   THEN date_trunc('month', _today)::date
        WHEN 'quarterly' THEN date_trunc('quarter', _today)::date
        WHEN 'yearly'    THEN date_trunc('year', _today)::date
      END;
      IF _period_start IS NULL OR _c.oldest_billable >= _period_start THEN
        CONTINUE;
      END IF;
      _through := _period_start - 1;
    END IF;

    BEGIN
      _invoice_id := public.admin_generate_invoice_for_client(_c.client_id, _through);
      IF _invoice_id IS NOT NULL THEN
        UPDATE public.invoices
           SET send_after = _today + COALESCE(_c.invoice_grace_days, 3)
         WHERE id = _invoice_id;
        _generated := _generated + 1;
      END IF;
    EXCEPTION WHEN OTHERS THEN
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

DO $$
DECLARE _src text;
BEGIN
  -- Comments stripped first. The check below looks for the word current_date,
  -- and the explanatory comment inside the function contains it — so the first
  -- run of this migration failed on its own prose. A checker that cannot tell
  -- code from commentary is the same defect as a caller-counter that counts
  -- comments, which this repo has already had once.
  SELECT regexp_replace(prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'run_billing_cycles';

  -- Not one `current_date` may remain: each was a period boundary decided by
  -- the wrong calendar, and they fail silently and only sometimes.
  IF _src ~* 'current_date' THEN
    RAISE EXCEPTION 'run_billing_cycles still takes a date from the session clock';
  END IF;
  IF _src !~ 'now\(\) AT TIME ZONE _c\.org_tz' THEN
    RAISE EXCEPTION 'run_billing_cycles is not using the organization timezone';
  END IF;

  -- The nightly job must still point at it, or none of this runs.
  IF NOT EXISTS (SELECT 1 FROM cron.job
                  WHERE active AND command ILIKE '%run_billing_cycles%') THEN
    RAISE EXCEPTION 'no active cron job calls run_billing_cycles';
  END IF;
END $$;
