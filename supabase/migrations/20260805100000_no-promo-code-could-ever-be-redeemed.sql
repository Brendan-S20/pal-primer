-- Every promo code redemption failed, and had always failed.
--
-- `portal_redeem_promo` branched on the discount type:
--
--   IF _p.discount_type = 'amount' THEN
--     _amount := COALESCE(_p.discount_value_cents, 0);
--   ELSE
--     RAISE EXCEPTION 'Percent codes are applied automatically to your next invoice';
--   END IF;
--
-- `promo_codes.discount_type` carries
--
--   CHECK (discount_type = ANY (ARRAY['percent'::text, 'fixed'::text]))
--
-- so `'amount'` is a value the column cannot hold. The true branch was
-- unreachable by construction and every code — fixed or percent — fell into
-- the ELSE. Measured on the live database before this ran: 6 codes, 3 'fixed'
-- and 3 'percent', 0 that could redeem.
--
-- The failure mode was worse than an error. A fixed-amount code was refused
-- with "Percent codes are applied automatically to your next invoice" — a
-- sentence that is wrong about the code AND makes a promise nothing keeps.
-- The customer reads it as "already handled", closes the tab, and waits for a
-- discount that will never appear on an invoice. Nothing in this system reads
-- `discount_percent`; there is no automatic application anywhere.
--
-- Two changes, and only two:
--
--   1. 'amount' -> 'fixed', which restores fixed-amount codes.
--   2. The ELSE message stops reassuring and starts describing. Percentage
--      codes still do nothing, because applying them is a build that does not
--      exist. Saying so is the honest state; the previous wording was a
--      pleasant-sounding lie and would have kept the gap invisible.
--
-- What is deliberately NOT done here: percentage support. "20% off" needs a
-- base, and the only price this schema knows is `subscriptions.price_cents`,
-- which is per VISIT. Deriving a month of service from it means inventing a
-- visits-per-cycle rule that exists nowhere in this codebase. Guessing at that
-- inside a function that writes to the credit ledger is how a rounding
-- assumption becomes somebody's money. The percentage path is instead removed
-- from where codes are MINTED (the promotions form and the win-back sender),
-- so no new unredeemable code is created while this branch stays unbuilt.
--
-- ── WHY THIS PATCHES THE LIVE DEFINITION ──────────────────────────────────
--
-- Spliced into `pg_get_functiondef()` rather than restated. The body carries
-- the expiry check, the redemption-limit check, and the already-used check,
-- and retyping them to change one string literal is how one of them silently
-- reverts. The splice asserts both replacements landed and aborts otherwise,
-- so a moved anchor fails the migration instead of installing a half-patched
-- function.

DO $mig$
DECLARE _def text; _n int;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO _def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'portal_redeem_promo';

  IF _def IS NULL THEN RAISE EXCEPTION 'portal_redeem_promo not found'; END IF;

  IF position('Percentage discounts are not supported yet' in _def) > 0 THEN
    RAISE NOTICE 'portal_redeem_promo already patched'; RETURN;
  END IF;

  -- 1. The unreachable branch.
  _n := (length(_def) - length(replace(_def, '_p.discount_type = ''amount''', '')))
        / length('_p.discount_type = ''amount''');
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 ''amount'' comparison, found %', _n;
  END IF;
  _def := replace(_def, '_p.discount_type = ''amount''', '_p.discount_type = ''fixed''');

  -- 2. The false reassurance.
  _n := (length(_def) - length(replace(_def, 'Percent codes are applied automatically to your next invoice', '')))
        / length('Percent codes are applied automatically to your next invoice');
  IF _n <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 reassurance message, found %', _n;
  END IF;
  _def := replace(
    _def,
    'Percent codes are applied automatically to your next invoice',
    'This is a percentage code. Percentage discounts are not supported yet — ask us to apply it to your invoice.'
  );

  EXECUTE _def;
END
$mig$;

COMMENT ON FUNCTION public.portal_redeem_promo(uuid, text) IS
  'Redeems a fixed-amount promo code to account credit. Percentage codes are '
  'NOT applied anywhere — discount_percent has no reader in SQL or in the app. '
  'Until that is built, the promotions form no longer mints percent codes and '
  'the ones already on file are refused here with an honest message rather '
  'than a false reassurance.';
