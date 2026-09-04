-- The invoice priced work that was already done.
--
-- `admin_generate_invoice_for_client` joins the SUBSCRIPTION when it bills:
--
--     SELECT ... s.price_cents, p.street
--       FROM public.visits v
--       JOIN public.subscriptions s ON s.id = v.subscription_id
--      WHERE ... li.id IS NULL
--        AND (v.status = 'completed' OR (v.status = 'skipped' AND ...))
--
-- so the amount on a line item is the price the subscription carries AT
-- INVOICE TIME, not the price it carried when the technician finished the
-- yard. Raise a postpaid client's rate mid-cycle and every completed visit
-- they have not yet been invoiced for is billed at the new rate -- work that
-- was done, at a price nobody had agreed when it was done.
--
-- This repo already knows the rule. Two lines further down the same loop:
--
--     -- The seasonal surcharge the tenant actually sells, priced off the visit
--     -- row so a later settings change cannot retro-price a done deep clean.
--
-- and the skip charge is stamped on the visit as `skip_charge_cents` for the
-- same reason. The surcharge and the skip are frozen; the price they are added
-- to is not.
--
-- HOW MUCH IS EXPOSED, measured rather than assumed: zero rows, today. Every
-- uninvoiced billable visit in this database (68 of them, 6 clients, back to
-- 2026-04-29) belongs to a PREPAID subscription, and prepaid never reads this
-- path -- `finalize_visit_completion` posts the debit at completion, which
-- freezes the amount already. The invoice function filters to postpaid.
--
-- That is a fact about today's rows, not about the code. 107 of the 130 active
-- subscriptions are postpaid, and every one of them sits in the exposed state
-- for the whole gap between a visit completing and the cycle invoice running --
-- which is the normal condition of a postpaid client, not an edge case. The
-- window is currently empty; it is not currently closed.
--
-- The fix is the same one the surcharge already uses: stamp the price on the
-- visit when it completes, and bill from that. There are four live code paths
-- that complete a visit -- `complete_visit`, `office_complete_visit`,
-- `confirm_open_visit` and `seed_demo_org` -- and all four funnel through
-- `finalize_visit_completion`, so there is exactly one place to stamp it.
--
-- No backfill. The column is nullable and every reader COALESCEs to the
-- subscription, so an unstamped visit bills exactly as it does today. The
-- postpaid set that would need backfilling is empty, and writing today's
-- subscription price onto the 68 prepaid rows would record a number that
-- contradicts the debit those visits actually posted at completion.

-- ── the column ──────────────────────────────────────────────────────────────
ALTER TABLE public.visits
  ADD COLUMN IF NOT EXISTS price_cents integer;

COMMENT ON COLUMN public.visits.price_cents IS
  'What this visit is worth, frozen when it completed. NULL means it was '
  'completed before this column existed; readers COALESCE to '
  'subscriptions.price_cents, which is the pre-freeze behaviour. Never '
  'overwritten once set -- a price change applies to work not yet done.';

-- ── stamp it at the one chokepoint ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.finalize_visit_completion(_visit_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE _org uuid; _client uuid; _cadence public.billing_cadence; _price integer;
BEGIN
  PERFORM public.record_visit_station_service(_visit_id);

  SELECT v.organization_id, v.client_id, s.billing_cadence, s.price_cents
    INTO _org, _client, _cadence, _price
    FROM public.visits v JOIN public.subscriptions s ON s.id = v.subscription_id
   WHERE v.id = _visit_id;

  -- Freeze the price onto the work. `price_cents IS NULL` rather than an
  -- unconditional SET, because this function is reachable more than once for
  -- one visit -- `complete_visit` and `confirm_open_visit` are both idempotent
  -- by design and a replayed offline close-out can arrive after an office one.
  -- The first completion is the one that priced the job.
  UPDATE public.visits
     SET price_cents = _price
   WHERE id = _visit_id AND price_cents IS NULL;

  IF _cadence = 'prepaid' AND COALESCE(_price, 0) > 0 THEN
    PERFORM public.post_credit_entry(_org, _client, -_price, 'visit_debit', NULL, _visit_id, 'Visit completed');
  END IF;
END;
$function$;

-- Re-stated, not inherited. CREATE OR REPLACE keeps the existing privileges,
-- so on this database the lockdown from 20260729100000 and 20260731240000 is
-- still in force and these two lines change nothing. They are here because the
-- FILE has to be safe on its own: a fresh replay executes migrations in order,
-- and a SECURITY DEFINER function that takes one tenant's visit id and never
-- asks who is calling must not be reachable from a signed-in session of any
-- other tenant. Nothing in src/ calls it by RPC -- it is reached only from
-- complete_visit, office_complete_visit, confirm_open_visit and seed_demo_org,
-- which do their own authorization.
REVOKE ALL ON FUNCTION public.finalize_visit_completion(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.finalize_visit_completion(uuid) FROM anon, authenticated;

-- ── bill from the visit, not from the subscription ──────────────────────────
-- Spliced rather than retyped. The function is ~120 lines and the change is
-- one expression; recreating it by hand here would mean transcribing the
-- addon loop, the credit application and the empty-invoice rollback, any of
-- which is a chance to silently drop a line. `pg_get_functiondef` is given a
-- named function, never a set (working agreement: it raises on any pg_proc row
-- that is not a plain function).
DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := 's.price_cents, p.street';
  _to   CONSTANT text := 'COALESCE(v.price_cents, s.price_cents) AS price_cents, p.street';
BEGIN
  _def := pg_get_functiondef('public.admin_generate_invoice_for_client(uuid, date)'::regprocedure);

  -- Ordered so that a SECOND run is a no-op rather than a failure. The splice
  -- consumes its own anchor, so "the anchor is missing" means one of two
  -- opposite things -- already done, or the body moved underneath us -- and
  -- only the second is a fault. Migrations normally run once, but this repo
  -- applies them to production by hand, and a re-run after a partial failure
  -- must not be the thing that stops the fix landing.
  IF strpos(_def, _to) > 0 THEN
    RAISE NOTICE 'admin_generate_invoice_for_client is already spliced; leaving it alone.';
    RETURN;
  END IF;

  IF strpos(_def, _from) = 0 THEN
    RAISE EXCEPTION
      'admin_generate_invoice_for_client neither selects % nor already reads the visit price; the splice anchor moved and the invoice would still be priced from the live subscription. Re-cut this migration against the current body.',
      _from;
  END IF;

  _def := replace(_def, _from, _to);

  -- Both consuming branches read `_v.price_cents` (the deep-clean branch and
  -- the ordinary-service branch), so aliasing the COALESCE back to the same
  -- name is the whole change -- there is no third call site to miss.
  IF strpos(_def, _to) = 0 THEN
    RAISE EXCEPTION 'the substitution did not take';
  END IF;

  EXECUTE _def;
END
$splice$;

-- ── what this migration establishes ─────────────────────────────────────────
-- Every assertion below is about what these files just did, so a replay into
-- an empty database can prove all of them from any starting state.
DO $verify$
DECLARE _src text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'price_cents'
  ) THEN
    RAISE EXCEPTION 'visits.price_cents was not created';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'finalize_visit_completion';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'finalize_visit_completion is missing';
  END IF;
  -- Comments stripped first: this file explains the guard in a comment
  -- directly above it, and prosrc keeps comments.
  IF _src NOT LIKE '%price_cents = _price%' OR _src NOT LIKE '%price_cents IS NULL%' THEN
    RAISE EXCEPTION 'finalize_visit_completion does not freeze the price onto the visit';
  END IF;

  SELECT regexp_replace(p.prosrc, '--[^\n]*', '', 'g') INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_generate_invoice_for_client';
  IF _src NOT LIKE '%COALESCE(v.price_cents, s.price_cents)%' THEN
    RAISE EXCEPTION 'the invoice is still priced from the subscription alone';
  END IF;

  RAISE NOTICE 'completed work now carries its own price; the invoice reads it.';
END
$verify$;
