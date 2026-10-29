-- Twice weekly is priced per week (#572, F-07). NOT APPLIED: for Helm, after
-- Product APPROVE and Brendan Ready.
--
-- organizations.frequency_multipliers defaults to
--   {"weekly":1.0,"biweekly":1.7,"twice_weekly":1.8,"monthly":3.2}
-- and public_quote multiplied the per-visit price by the number for the
-- cadence. For weekly, biweekly and monthly a cycle is one visit, so that is
-- right. Twice weekly is two visits a week, and 1.8 per visit billed 3.6x the
-- weekly plan. Measured on /signup/demo-pet-waste-co, ZIP 48009, one dog:
-- weekly $25.00/visit, twice weekly $45.00/visit, $90 a week.
--
-- The owner's decision (D1, 2026-10-28): twice weekly's 1.8 is the WEEKLY
-- TOTAL. So its per-visit factor is the stored number divided by the two
-- visits in its week. Every other cadence is one visit per cycle and is
-- unchanged. The stored numbers do not change, so no row is touched and
-- biweekly and monthly price exactly as before. src/lib/frequency-multipliers.ts
-- is the same rule for the office side (quotes, the new-client wizard, the
-- Services tab, pricing drift, a frequency change).
--
-- A frequency the org has no number for is still 1.0 per visit, as before:
-- the division applies only to a number the org actually has.
--
-- Subscriptions already sold at the old twice-weekly price keep their stored
-- price_cents. Nothing here reprices a customer; the pricing-drift page shows
-- them above the card, and the owner decides.
--
-- public_quote is spliced, as 20261025200000, 20261027200000 and
-- 20261028120000 spliced it: its newest body read with pg_get_functiondef on
-- the NAMED function, one anchor that must occur exactly once, replaced, and
-- executed. Signature, SECURITY DEFINER, search_path and grants are kept by
-- CREATE OR REPLACE. A body that already halves twice weekly is left alone,
-- so a replay is a no-op.
--
-- Replays into an empty database: one splice of a function 20261024100900
-- creates. No rows read. Idempotent.

DO $splice$
DECLARE
  _def text;
  _from CONSTANT text := '_mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);';
  _to   CONSTANT text := '_mult := COALESCE((_org.frequency_multipliers ->> _frequency)::numeric, 1.0);
  -- Twice weekly''s number is the week''s total for two visits (#572).
  IF _frequency = ''twice_weekly'' AND (_org.frequency_multipliers ? _frequency) THEN
    _mult := _mult / 2;
  END IF;';
  _n integer;
BEGIN
  _def := pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure);
  IF strpos(_def, '_mult := _mult / 2') > 0 THEN
    RAISE NOTICE 'public_quote already prices twice weekly per week; leaving it alone.';
    RETURN;
  END IF;
  _n := (length(_def) - length(replace(_def, _from, ''))) / length(_from);
  IF _n IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION
      'public_quote reads frequency_multipliers % time(s), not once; the splice anchor moved.',
      _n;
  END IF;
  EXECUTE replace(_def, _from, _to);
END
$splice$;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
     WHERE p.oid = 'public.public_quote(text, text, integer, text, text, uuid)'::regprocedure
       AND p.prosrc LIKE '%_mult := _mult / 2%'
  ) THEN
    RAISE EXCEPTION 'public_quote still applies twice weekly''s weekly total to each visit';
  END IF;
  IF (SELECT count(*) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'public_quote') IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'public.public_quote has more than one overload; the splice reached only one';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_quote(text, text, integer, text, text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the public signup lost public_quote';
  END IF;
END
$post$;
