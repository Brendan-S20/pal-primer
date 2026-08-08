-- The "you have already used this code" guard was keyed on a display string.
--
-- Mine, from 20260807030000. When percentage codes became redeemable, the
-- ledger note grew from `Promo: SPRING15` to
-- `Promo: SPRING15 (15% of $85.00)`, so the dedupe check had to survive the
-- longer form. I did it by parsing the note back apart:
--
--   split_part(note, ' (', 1) = 'Promo: '||upper(_p.code)
--
-- That works, and it is the wrong thing to key on. The note is prose written
-- for a human reading their credit history; it is not an identifier. Two ways
-- it fails:
--
--   1. `upsertPromoCode` permits editing `code` on an existing row. Rename
--      SPRING15 to SPRING20 and every prior redeemer's note still says
--      SPRING15, so all of them can redeem again — at whatever rate the
--      renamed code now carries.
--   2. Two requests racing on the same code both pass the EXISTS and both
--      insert. A check is not a constraint.
--
-- Both are fixed by recording WHICH code was redeemed instead of inferring it
-- from a sentence: a `promo_code_id` column, and a UNIQUE index that makes a
-- second redemption impossible rather than merely checked. The note keeps its
-- prose — it is still the thing a customer reads — it just stops being load-
-- bearing.
--
-- Nothing to backfill: 0 rows in credit_ledger have kind = 'promo', and 0
-- promo codes have a nonzero redemption_count. Checked before writing.

ALTER TABLE public.credit_ledger
  ADD COLUMN IF NOT EXISTS promo_code_id uuid
    REFERENCES public.promo_codes(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.credit_ledger.promo_code_id IS
  'The promo code this entry came from. The dedupe key for redemption — never parse the note for it.';

-- ON DELETE SET NULL, not CASCADE: deleting a promo code must not delete the
-- credit somebody was given. It does mean a deleted-then-recreated code can be
-- redeemed again by the same client, which is the right reading — a code that
-- no longer exists cannot have been "already used".

-- One redemption per client per code. Partial, because every other ledger kind
-- leaves promo_code_id NULL and NULLs would otherwise collide in spirit if the
-- index is ever changed to a plain UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_promo_per_client
  ON public.credit_ledger (client_id, promo_code_id)
  WHERE promo_code_id IS NOT NULL;

DO $pre$
DECLARE _src text; _orphans integer;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_redeem_promo';
  IF _src IS NULL THEN RAISE EXCEPTION 'portal_redeem_promo does not exist'; END IF;
  IF _src NOT LIKE '%split_part(note%' THEN
    RAISE EXCEPTION 'portal_redeem_promo no longer keys on the note — read it before replacing it';
  END IF;

  -- If promo entries existed without a code id, the new unique index would be
  -- vacuously satisfied and those clients could redeem a second time. There
  -- are none, and this refuses to proceed quietly if that ever changes.
  SELECT count(*) INTO _orphans
    FROM public.credit_ledger WHERE kind = 'promo' AND promo_code_id IS NULL;
  IF _orphans <> 0 THEN
    RAISE EXCEPTION '% promo ledger entries carry no promo_code_id — backfill them before keying on it', _orphans;
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.portal_redeem_promo(_token uuid, _code text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _cid uuid; _org uuid; _p record; _amount integer; _base integer; _note text;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  SELECT * INTO _p FROM public.promo_codes
   WHERE organization_id = _org AND upper(code) = upper(trim(_code)) AND active = true;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Code not found or inactive'; END IF;
  IF _p.expires_at IS NOT NULL AND _p.expires_at < now() THEN
    RAISE EXCEPTION 'Code has expired'; END IF;
  IF _p.max_redemptions IS NOT NULL AND _p.redemption_count >= _p.max_redemptions THEN
    RAISE EXCEPTION 'Code has reached its redemption limit'; END IF;

  -- Keyed on the code's id. The unique index below is what actually enforces
  -- this; the check is here so the customer gets a sentence instead of a
  -- constraint violation.
  IF EXISTS (SELECT 1 FROM public.credit_ledger
     WHERE client_id = _cid AND promo_code_id = _p.id) THEN
    RAISE EXCEPTION 'You have already used this code';
  END IF;

  IF _p.applies_to = 'recurring' THEN
    RAISE EXCEPTION 'This code is a recurring discount, which we cannot apply automatically yet. Contact us and we will put it on your plan.';
  END IF;

  IF _p.discount_type = 'fixed' THEN
    _amount := COALESCE(_p.discount_value_cents, 0);
    _note := 'Promo: '||upper(_p.code);
  ELSIF _p.discount_type = 'percent' THEN
    SELECT s.price_cents INTO _base
      FROM public.subscriptions s
     WHERE s.client_id = _cid
       AND s.status IN ('active','paused')
       AND s.price_cents > 0
     ORDER BY s.price_cents DESC, s.id
     LIMIT 1;
    IF _base IS NULL THEN
      RAISE EXCEPTION 'This code takes a percentage off your service price, and there is no active plan on your account to take it off of.';
    END IF;
    _amount := ROUND(_base * _p.discount_percent / 100.0)::integer;
    _note := 'Promo: '||upper(_p.code)
             ||' ('||trim(trailing '.' from to_char(_p.discount_percent, 'FM999990.99'))
             ||'% of $'||to_char(_base / 100.0, 'FM999999990.00')||')';
  ELSE
    RAISE EXCEPTION 'Unknown discount type %', _p.discount_type;
  END IF;

  IF _amount <= 0 THEN RAISE EXCEPTION 'Code has no value'; END IF;
  BEGIN
    INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note, promo_code_id)
    VALUES (_org, _cid, _amount, 'promo', _note, _p.id);
  EXCEPTION WHEN unique_violation THEN
    -- Two requests for the same code arriving together. One wins the index;
    -- the other lands here and gets the same sentence it would have got from
    -- the check above.
    RAISE EXCEPTION 'You have already used this code';
  END;
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = _p.id;
  RETURN _amount;
END;
$function$;

DO $post$
DECLARE _src text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_redeem_promo';
  IF _src LIKE '%split_part(note%' THEN
    RAISE EXCEPTION 'still keying on the note';
  END IF;
  IF _src NOT LIKE '%promo_code_id = _p.id%' THEN
    RAISE EXCEPTION 'the id-keyed check is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname='public' AND indexname='credit_ledger_one_promo_per_client'
  ) THEN
    RAISE EXCEPTION 'the unique index is missing';
  END IF;
END
$post$;
