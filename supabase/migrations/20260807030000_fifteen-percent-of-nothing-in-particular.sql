-- "15% off" — off what?
--
-- `promo_codes` has carried `discount_percent` since the table was created.
-- Nothing has ever read it. `portal_redeem_promo` resolved `fixed` codes and
-- raised on everything else, so the three percent codes on file were codes a
-- customer could type and be turned away from. The previous migration
-- (20260805100000) made that refusal honest instead of silently wrong; this
-- one makes it unnecessary.
--
-- ── PERCENT OF WHAT ────────────────────────────────────────────────────────
--
-- The question the column never answered. A redemption posts a credit to
-- `credit_ledger` — a number of cents, right now — so a percentage has to be
-- resolved against a base price at redemption time, and the base has to be one
-- that actually exists on the account.
--
-- `subscriptions.price_cents` is the price of ONE VISIT: read
-- `admin_generate_invoice_for_client` and every completed visit becomes a line
-- item at exactly that number. So a percentage of it is the discount on one
-- visit — which is what both of the `applies_to` values the product offers,
-- `first_visit` and `one_time`, mean.
--
-- A client with several properties has several subscriptions. Taking the
-- highest-priced active one is a choice, not a derivation: it is the plan they
-- think of as their service, and the ORDER BY makes two runs of the same
-- redemption agree with each other.
--
-- ── THE SECOND LIE IN THE SAME FUNCTION ────────────────────────────────────
--
-- `applies_to = 'recurring'` has never had a reader either. A recurring code
-- promises a discount on every invoice for N cycles; redemption posts one lump
-- credit, and a lump credit draws down against the NEXT invoice in full — not
-- X% off each of the next N. The totals can even match while the customer's
-- experience does not. Fixed-amount recurring codes have been paying out that
-- way, quietly, for as long as the function has existed.
--
-- Refused now, for both discount types. Nothing is lost: no `recurring` row
-- exists in any org, and the Settings form does not offer the option. This
-- closes a path the product cannot reach rather than taking a feature away.
--
-- ── WHY A FULL BODY AND NOT A SPLICE ───────────────────────────────────────
--
-- House style is to patch `pg_get_functiondef()` output so a long body cannot
-- lose a branch to a retype. That reasoning does not carry here: the body is
-- thirty lines, and this change rewrites most of them. Three overlapping
-- `replace()` calls on a body being half-replaced is the more fragile of the
-- two, not the safer. The property the splice pattern really buys — fail loudly
-- if the live function is not what the author read — is bought here by the
-- pre-flight assertion below instead.

-- ── Pre-flight: the live definition is the one this was written against ────
DO $pre$
DECLARE _def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_redeem_promo';

  IF _def IS NULL THEN
    RAISE EXCEPTION 'portal_redeem_promo is not installed; nothing to replace';
  END IF;

  -- Already this version (re-run): the percent branch reads discount_percent.
  IF position('_p.discount_percent' IN _def) > 0 THEN
    RAISE NOTICE 'portal_redeem_promo already resolves percentage codes; replacing with the same body';
  -- The 20260805100000 version: honest refusal, no percent reader.
  ELSIF position('Percentage discounts are not supported yet' IN _def) > 0 THEN
    RAISE NOTICE 'replacing the refusing version of portal_redeem_promo';
  ELSE
    RAISE EXCEPTION
      'portal_redeem_promo is neither the version this migration was written against nor its result; refusing to clobber it';
  END IF;
END
$pre$;

-- ── Shape constraints the app has always assumed and never enforced ────────
-- `discount_percent` had no range check at all: nothing but a Zod schema in one
-- server function stood between a typo and a 1500%-off code. Now that a reader
-- exists, an out-of-range row is money.
ALTER TABLE public.promo_codes
  DROP CONSTRAINT IF EXISTS promo_codes_percent_range_chk;
ALTER TABLE public.promo_codes
  ADD CONSTRAINT promo_codes_percent_range_chk
  CHECK (discount_percent IS NULL OR (discount_percent > 0 AND discount_percent <= 100));

-- A percent code with a NULL percent, or a fixed code with NULL cents, is a
-- code that resolves to nothing at the counter. Same shape of guard as
-- subscriptions_account_shape_chk.
ALTER TABLE public.promo_codes
  DROP CONSTRAINT IF EXISTS promo_codes_discount_shape_chk;
ALTER TABLE public.promo_codes
  ADD CONSTRAINT promo_codes_discount_shape_chk
  CHECK (
    (discount_type = 'percent' AND discount_percent IS NOT NULL)
    OR
    (discount_type = 'fixed' AND discount_value_cents IS NOT NULL)
  );

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

  -- Already-used check stays ahead of the arithmetic, so someone redeeming
  -- twice is told they already used it rather than told their account has no
  -- plan to price the discount against.
  --
  -- Percent notes carry their arithmetic after ' (', so the comparison is on
  -- the part before it. split_part, not LIKE: exact string equality has no
  -- wildcards to escape, and SPRING cannot match SPRING25.
  IF EXISTS (SELECT 1 FROM public.credit_ledger
     WHERE client_id = _cid AND kind = 'promo'
       AND split_part(note, ' (', 1) = 'Promo: '||upper(_p.code)) THEN
    RAISE EXCEPTION 'You have already used this code';
  END IF;

  -- One redemption, one credit. 'recurring' cannot be said in that vocabulary.
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
    -- The arithmetic on the ledger line. Without it, a $6.10 credit labelled
    -- "Promo: SPRING" is unexplainable six months later, once the plan price
    -- has moved and the percentage can no longer be worked backwards.
    _note := 'Promo: '||upper(_p.code)
             ||' ('||trim(trailing '.' from to_char(_p.discount_percent, 'FM999990.99'))
             ||'% of $'||to_char(_base / 100.0, 'FM999999990.00')||')';
  ELSE
    RAISE EXCEPTION 'Unknown discount type %', _p.discount_type;
  END IF;

  IF _amount <= 0 THEN RAISE EXCEPTION 'Code has no value'; END IF;
  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
  VALUES (_org, _cid, _amount, 'promo', _note);
  -- balance maintained by the trigger; see post_credit_entry.
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = _p.id;
  RETURN _amount;
END;
$function$;

COMMENT ON FUNCTION public.portal_redeem_promo(uuid, text) IS
  'Redeems a promo code as an account credit. Fixed codes credit '
  'discount_value_cents. Percent codes resolve discount_percent against the '
  'client''s highest-priced active subscription price_cents — the per-visit '
  'rate — and record the arithmetic in the ledger note. applies_to = '
  '''recurring'' is refused: one redemption posts one credit, which is not a '
  'discount repeated over N cycles.';
