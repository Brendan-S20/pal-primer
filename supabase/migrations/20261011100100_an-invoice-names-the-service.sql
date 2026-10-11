-- An invoice names the service (the service catalog, phase 5, invoicing).
--
-- The two invoice generators wrote every visit line as "Service on
-- 2026-10-11 - 412 Elm St" and every prepaid line as "Prepaid service on
-- 2026-10-11", because the product sold one service and the word "Service"
-- was all it needed. A business that walks dogs and scoops yards for the same
-- client now gets two lines that read the same with different prices on
-- them, and the customer rings up to ask which is which.
--
-- ── THE CHANGE, AND WHAT STAYS THE SAME ──────────────────────────────────
--
-- The line reads the VISIT's service name (visits.service_id, phase 2), so a
-- walk reads "30-minute walk on 2026-10-11 - 412 Elm St" and a prepaid stay
-- "Prepaid Overnight stay on 2026-10-11". The seeded "Pet waste removal"
-- (any case, any spacing) and a visit with no service at all still read
-- "Service on ..." / "Prepaid service on ...": that is the rule
-- visitServiceLabel already keeps on the tech's card (the seeded name is
-- ours, so it is not repeated), and it is what keeps every existing
-- pet-waste business's invoices, emails, PDFs and accounting exports reading
-- exactly as they do today. The deep-clean lines, the skip lines and the
-- surcharge lines are not touched; they are pet waste's and say so already.
--
-- The word is decided in one place, public.service_line_item_name, so the
-- postpaid and prepaid generators cannot disagree about what the seeded
-- service is called.
--
-- ── SPLICED, NOT RETYPED ─────────────────────────────────────────────────
--
-- The same way 20260903150000 (the price freeze) and 20260929110000 (tax)
-- changed these two bodies: pg_get_functiondef of the NAMED function, a
-- handful of anchored substitutions each required to match exactly once, and
-- EXECUTE. Each body is long and carries two earlier splices; retyping them
-- from the 20260731210000 text would silently drop both. Each splice is a
-- no-op on a second run (the-invoice-priced-work-that-was-already-done
-- explains why that matters here), and refuses loudly if an anchor moved.
--
-- Replays into an empty database: a function, and two edits to bodies that
-- exist by this point. No row is needed.

-- ── 1. The word on the line ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.service_line_item_name(_service_name text, _fallback text DEFAULT 'Service')
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT CASE
    WHEN _service_name IS NULL
      OR lower(btrim(_service_name)) IN ('', 'pet waste removal') THEN _fallback
    ELSE btrim(_service_name)
  END;
$function$;

COMMENT ON FUNCTION public.service_line_item_name(text, text) IS
  'The service word on an invoice line: the business''s own service name, or the fallback ("Service") for the seeded "Pet waste removal" and for a visit with no service, so existing pet-waste invoices read as they always have. Migration 20261011100100.';

REVOKE ALL ON FUNCTION public.service_line_item_name(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.service_line_item_name(text, text) TO authenticated, service_role;

-- ── 2. The postpaid run: admin_generate_invoice_for_client ────────────────
DO $splice$
DECLARE
  _def text;
  _anchor text;
  _count integer;
  -- Three anchors, each in the visit loop and nowhere else in the body.
  _sel_from CONSTANT text := 'COALESCE(v.price_cents, s.price_cents) AS price_cents, p.street';
  _sel_to   CONSTANT text := 'COALESCE(v.price_cents, s.price_cents) AS price_cents, p.street, sv.name AS service_name';
  _join_from CONSTANT text := 'LEFT JOIN public.properties p ON p.id = v.property_id';
  _join_to   CONSTANT text := 'LEFT JOIN public.properties p ON p.id = v.property_id
      LEFT JOIN public.services sv ON sv.id = v.service_id';
  _desc_from CONSTANT text := '_desc := ''Service on '' || to_char(_v.scheduled_on, ''YYYY-MM-DD'')';
  _desc_to   CONSTANT text := '_desc := public.service_line_item_name(_v.service_name) || '' on '' || to_char(_v.scheduled_on, ''YYYY-MM-DD'')';
BEGIN
  _def := pg_get_functiondef('public.admin_generate_invoice_for_client(uuid, date)'::regprocedure);

  IF strpos(_def, 'service_line_item_name') > 0 THEN
    RAISE NOTICE 'admin_generate_invoice_for_client already names the service; leaving it alone.';
    RETURN;
  END IF;

  FOREACH _anchor IN ARRAY ARRAY[_sel_from, _join_from, _desc_from] LOOP
    _count := (length(_def) - length(replace(_def, _anchor, ''))) / length(_anchor);
    IF _count <> 1 THEN
      RAISE EXCEPTION
        'admin_generate_invoice_for_client contains "%" % time(s), not once; the splice anchor moved. Re-cut this migration against the current body.',
        _anchor, _count;
    END IF;
  END LOOP;

  _def := replace(_def, _sel_from, _sel_to);
  _def := replace(_def, _join_from, _join_to);
  _def := replace(_def, _desc_from, _desc_to);
  EXECUTE _def;
END
$splice$;

-- ── 3. The office's prepaid invoice: generate_prepaid_invoice ─────────────
DO $splice$
DECLARE
  _def text;
  _new text;
  _count integer;
  _desc_from CONSTANT text := 'ELSE ''Prepaid service on '' END';
  _desc_to   CONSTANT text := 'ELSE ''Prepaid '' || public.service_line_item_name(_v.service_name, ''service'') || '' on '' END';
BEGIN
  _def := pg_get_functiondef('public.generate_prepaid_invoice(uuid, integer)'::regprocedure);

  IF strpos(_def, 'service_line_item_name') > 0 THEN
    RAISE NOTICE 'generate_prepaid_invoice already names the service; leaving it alone.';
    RETURN;
  END IF;

  -- The loop's SELECT gains the service name and its join. Anchored on the
  -- FOR so the count query above it, which reads the same columns, is left
  -- alone.
  _new := regexp_replace(_def,
    'FOR _v IN\s+SELECT v\.id, v\.scheduled_on, v\.is_deepclean, v\.deepclean_charge_cents\s+FROM public\.visits v\s+LEFT JOIN public\.invoice_line_items li',
    'FOR _v IN
    SELECT v.id, v.scheduled_on, v.is_deepclean, v.deepclean_charge_cents, sv.name AS service_name
      FROM public.visits v
      LEFT JOIN public.services sv ON sv.id = v.service_id
      LEFT JOIN public.invoice_line_items li');
  IF _new = _def THEN
    RAISE EXCEPTION 'generate_prepaid_invoice no longer reads its visits the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  _count := (length(_def) - length(replace(_def, _desc_from, ''))) / length(_desc_from);
  IF _count <> 1 THEN
    RAISE EXCEPTION
      'generate_prepaid_invoice contains "%" % time(s), not once; the splice anchor moved. Re-cut this migration against the current body.',
      _desc_from, _count;
  END IF;
  _def := replace(_def, _desc_from, _desc_to);
  EXECUTE _def;
END
$splice$;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
DECLARE
  _src text;
BEGIN
  -- The word.
  IF public.service_line_item_name('Pet waste removal') <> 'Service'
     OR public.service_line_item_name('  pet WASTE removal ') <> 'Service'
     OR public.service_line_item_name(NULL) <> 'Service'
     OR public.service_line_item_name('') <> 'Service'
     OR public.service_line_item_name('30-minute walk') <> '30-minute walk'
     OR public.service_line_item_name(' Overnight stay ') <> 'Overnight stay'
     OR public.service_line_item_name(NULL, 'service') <> 'service'
     OR public.service_line_item_name('Pet waste removal', 'service') <> 'service'
     OR public.service_line_item_name('Full groom', 'service') <> 'Full groom' THEN
    RAISE EXCEPTION 'service_line_item_name does not keep the seeded name reading "Service" and every other name as itself';
  END IF;
  IF has_function_privilege('anon', 'public.service_line_item_name(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can call service_line_item_name';
  END IF;

  -- Both generators read the visit's service and name it through the one
  -- function. prosrc, never pg_get_functiondef over a set.
  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'admin_generate_invoice_for_client';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'admin_generate_invoice_for_client is missing';
  END IF;
  IF _src NOT LIKE '%LEFT JOIN public.services sv ON sv.id = v.service_id%'
     OR _src NOT LIKE '%public.service_line_item_name(_v.service_name) || '' on ''%' THEN
    RAISE EXCEPTION 'the postpaid invoice line still reads "Service on" for every service';
  END IF;
  IF _src LIKE '%''Service on ''%' THEN
    RAISE EXCEPTION 'the postpaid generator still carries the hardcoded "Service on"';
  END IF;
  -- The earlier splices survived the edit.
  IF _src NOT LIKE '%COALESCE(v.price_cents, s.price_cents)%'
     OR _src NOT LIKE '%set_invoice_totals%' THEN
    RAISE EXCEPTION 'the postpaid generator lost the price freeze or the tax splice';
  END IF;

  SELECT p.prosrc INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'generate_prepaid_invoice';
  IF _src IS NULL THEN
    RAISE EXCEPTION 'generate_prepaid_invoice is missing';
  END IF;
  IF _src NOT LIKE '%LEFT JOIN public.services sv ON sv.id = v.service_id%'
     OR _src NOT LIKE '%public.service_line_item_name(_v.service_name, ''service'')%' THEN
    RAISE EXCEPTION 'the prepaid invoice line still reads "Prepaid service on" for every service';
  END IF;
  IF _src LIKE '%''Prepaid service on ''%' THEN
    RAISE EXCEPTION 'the prepaid generator still carries the hardcoded "Prepaid service on"';
  END IF;
  IF _src NOT LIKE '%set_invoice_totals%' THEN
    RAISE EXCEPTION 'the prepaid generator lost the tax splice';
  END IF;

  RAISE NOTICE 'an invoice line names the visit''s service; the seeded pet-waste service still reads "Service".';
END
$post$;
