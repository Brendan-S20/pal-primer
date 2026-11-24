-- #1032 follow-up (HoundStack Product review 6030711620, M3): a month's
-- texting total can no longer lose a send, and the bill is computed from a
-- count taken inside the billing claim.
--
-- The fault. tg_sms_usage_rollup (20261123160000) recounts the month in an
-- AFTER trigger: INSERT ... SELECT sum() ... ON CONFLICT DO UPDATE SET
-- segments = EXCLUDED.segments. Under READ COMMITTED two sends for one
-- business at once each sum without the other's uncommitted row; the second
-- writer waits on the period row's lock, then writes its own stale sum, and
-- one send is lost. A later send corrects it, but nothing corrects the last
-- sends before a month closes, and billing billed sms_usage_periods.segments
-- as it stood: 1,500 against 1,501 is $10.
--
-- Two fixes, either sufficient on its own and both cheap:
--   1. The rollup takes a transaction-scoped advisory lock per business and
--      month BEFORE it sums. The second send waits for the first to commit,
--      and its sum (a new statement, so a new snapshot under READ COMMITTED)
--      then sees both rows.
--   2. claim_sms_overage() takes the same lock, recounts the month from
--      sms_usage_events, stores that count, and claims the month on it, all
--      in one call. billed_segments records the number the bill was computed
--      from, whatever later happens to segments.
--
-- Additive and re-runnable: one nullable column, CREATE OR REPLACE of the
-- existing trigger function (same name, so the trigger-function count does
-- not move) and one new SECURITY DEFINER function, service_role only. No row
-- is changed.

-- ── what the bill was computed from ──────────────────────────────────────
ALTER TABLE public.sms_usage_periods
  ADD COLUMN IF NOT EXISTS billed_segments integer;

COMMENT ON COLUMN public.sms_usage_periods.billed_segments IS
  '#1032 follow-up: the segment count, recounted from sms_usage_events inside claim_sms_overage, that billed_blocks and billed_cents were computed from.';

-- ── 1. the rollup takes turns per business and month ─────────────────────
CREATE OR REPLACE FUNCTION public.tg_sms_usage_rollup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _org uuid;
  _month date;
BEGIN
  -- Sorted, so two transactions touching the same pair of months (an UPDATE
  -- that moves a row) always lock them in the same order.
  FOR _org, _month IN
    SELECT DISTINCT o, m FROM unnest(
      ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.organization_id END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.organization_id END],
      ARRAY[CASE WHEN TG_OP <> 'INSERT' THEN OLD.period_month END,
            CASE WHEN TG_OP <> 'DELETE' THEN NEW.period_month END]
    ) AS t(o, m)
    WHERE o IS NOT NULL AND m IS NOT NULL
    ORDER BY o, m
  LOOP
    -- Held to the end of the transaction. A concurrent send for the same
    -- business and month waits here until this one commits, so the sum
    -- below, which is its own statement and so its own snapshot, sees it.
    PERFORM pg_advisory_xact_lock(
      hashtextextended('houndstack.sms_usage:' || _org::text || ':' || _month::text, 0));
    INSERT INTO public.sms_usage_periods AS p (organization_id, period_month, segments, updated_at)
    SELECT _org, _month, COALESCE(sum(e.num_segments), 0), now()
      FROM public.sms_usage_events e
     WHERE e.organization_id = _org AND e.period_month = _month
    ON CONFLICT (organization_id, period_month) DO UPDATE
      SET segments = EXCLUDED.segments, updated_at = now();
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.tg_sms_usage_rollup() FROM PUBLIC, anon, authenticated;

-- ── 2. the claim recounts, and bills what it counted ─────────────────────
-- Outcomes:
--   not_metered        the managed-sms row sets no allowance; nothing claimed
--   already_billed     the month was claimed before; nothing changes
--   no_overage         at or under the allowance; closed at 0
--   no_stripe_customer over the allowance but nobody to bill; NOT claimed,
--                      so it is billed once the business has a customer
--   claimed            over the allowance and claimed at the counted number;
--                      the caller now creates the Stripe item
CREATE OR REPLACE FUNCTION public.claim_sms_overage(
  _org_id uuid,
  _period_month date,
  _can_charge boolean
)
RETURNS TABLE (
  outcome text,
  segments integer,
  blocks integer,
  cents integer,
  segments_included integer,
  block_size integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
#variable_conflict use_column
DECLARE
  _inc integer;
  _size integer;
  _price integer;
  _used integer;
  _billed timestamptz;
  _blocks integer;
  _cents integer;
BEGIN
  SELECT a.texting_segments_included, a.texting_block_size, a.texting_block_cents
    INTO _inc, _size, _price
    FROM public.platform_addons a WHERE a.slug = 'managed-sms';
  IF _inc IS NULL OR _size IS NULL OR _size <= 0 OR _price IS NULL THEN
    RETURN QUERY SELECT 'not_metered'::text, NULL::integer, NULL::integer, NULL::integer, _inc, _size;
    RETURN;
  END IF;

  -- The same lock the rollup takes: no send for this business and month can
  -- be half-counted while the month is counted here.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('houndstack.sms_usage:' || _org_id::text || ':' || _period_month::text, 0));

  SELECT COALESCE(sum(e.num_segments), 0)::integer INTO _used
    FROM public.sms_usage_events e
   WHERE e.organization_id = _org_id AND e.period_month = _period_month;

  INSERT INTO public.sms_usage_periods AS p (organization_id, period_month, segments, updated_at)
  VALUES (_org_id, _period_month, _used, now())
  ON CONFLICT (organization_id, period_month) DO UPDATE
    SET segments = EXCLUDED.segments, updated_at = now();

  SELECT p.billed_at INTO _billed
    FROM public.sms_usage_periods p
   WHERE p.organization_id = _org_id AND p.period_month = _period_month
   FOR UPDATE;
  IF _billed IS NOT NULL THEN
    RETURN QUERY SELECT 'already_billed'::text, _used, NULL::integer, NULL::integer, _inc, _size;
    RETURN;
  END IF;

  _blocks := CASE WHEN _used <= _inc THEN 0 ELSE ceil((_used - _inc)::numeric / _size)::integer END;
  _cents := _blocks * _price;

  IF _cents <= 0 THEN
    UPDATE public.sms_usage_periods p
       SET billed_at = now(), billed_blocks = 0, billed_cents = 0, billed_segments = _used
     WHERE p.organization_id = _org_id AND p.period_month = _period_month AND p.billed_at IS NULL;
    RETURN QUERY SELECT 'no_overage'::text, _used, 0, 0, _inc, _size;
    RETURN;
  END IF;

  IF NOT COALESCE(_can_charge, false) THEN
    RETURN QUERY SELECT 'no_stripe_customer'::text, _used, _blocks, _cents, _inc, _size;
    RETURN;
  END IF;

  UPDATE public.sms_usage_periods p
     SET billed_at = now(), billed_blocks = _blocks, billed_cents = _cents, billed_segments = _used
   WHERE p.organization_id = _org_id AND p.period_month = _period_month AND p.billed_at IS NULL;
  RETURN QUERY SELECT 'claimed'::text, _used, _blocks, _cents, _inc, _size;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_sms_overage(uuid, date, boolean) FROM PUBLIC, anon;
-- Supabase grants EXECUTE to authenticated by default. This writes a billing
-- claim for any organization id; the only caller is the nightly job, as
-- service_role.
REVOKE EXECUTE ON FUNCTION public.claim_sms_overage(uuid, date, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sms_overage(uuid, date, boolean) TO service_role;

COMMENT ON FUNCTION public.claim_sms_overage(uuid, date, boolean) IS
  '#1032 follow-up: recount one closed month from sms_usage_events under the per-org, per-month lock, store it, and claim the month on that count. service_role only.';

-- ── prove what this file establishes, from any starting state ────────────
DO $check$
DECLARE
  _src text;
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_sms_overage(uuid, date, boolean)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_sms_overage(uuid, date, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_sms_overage must not be executable by authenticated or anon';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.claim_sms_overage(uuid, date, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_sms_overage must stay executable by service_role';
  END IF;
  IF has_function_privilege('authenticated', 'public.tg_sms_usage_rollup()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.tg_sms_usage_rollup()', 'EXECUTE') THEN
    RAISE EXCEPTION 'tg_sms_usage_rollup must not be executable by authenticated or anon';
  END IF;
  SELECT p.prosrc INTO _src FROM pg_proc p WHERE p.oid = 'public.tg_sms_usage_rollup()'::regprocedure;
  IF _src NOT LIKE '%pg_advisory_xact_lock%' THEN
    RAISE EXCEPTION 'tg_sms_usage_rollup must take the per-org, per-month lock before it recounts';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
     WHERE t.tgrelid = 'public.sms_usage_events'::regclass
       AND t.tgname = 'sms_usage_rollup' AND NOT t.tgisinternal
  ) THEN
    RAISE EXCEPTION 'sms_usage_rollup trigger is missing from sms_usage_events';
  END IF;
END
$check$;
