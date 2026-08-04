-- Repoint platform_plans at the PLATFORM Stripe account.
--
-- WHAT WENT WRONG
--
-- HoundStack runs two live Stripe accounts, and they do different jobs:
--
--   acct_1U0RifQjJFmqXgZD   PLATFORM. Bills tenants for the software.
--                           STRIPE_SECRET_KEY / STRIPE_PUBLISHABLE_KEY /
--                           PLATFORM_STRIPE_WEBHOOK_SECRET.
--
--   acct_1U0CVSQUHYdejlaV   CONNECT. Tenants charge their own clients through
--                           it; our 50 bps application fee comes from here.
--                           STRIPE_CONNECT_*.
--
-- The live-mode catalog (migration 20260803050000) was created on the CONNECT
-- account by mistake, and platform_plans was pointed at it. Subscription
-- checkout runs on STRIPE_SECRET_KEY — the platform account — where those price
-- ids do not exist, so every attempt failed with `No such price`. No tenant
-- could subscribe.
--
-- Stripe embeds the owning account in every id, which is what makes this
-- checkable rather than a matter of belief:
--
--   price_1U0ERd QUHYdejlaV Br4C57JD   ← acct_1U0CVS QUHYdejlaV   (Connect)
--   price_1U0Tkd QjJFmqXgZD 7ZlwFfon   ← acct_1U0Rif QjJFmqXgZD   (platform)
--
-- Nothing was charged incorrectly: it failed closed at checkout. At the time of
-- this migration zero organizations held a stripe_subscription_id, zero held a
-- platform stripe_customer_id, and zero had a connected account, so there is
-- nothing to migrate beyond these pointers.
--
-- THE CATALOG ON THE PLATFORM ACCOUNT
--
-- Recreated identically — same amounts, intervals, nicknames, product
-- descriptions and metadata keys — and each price verified livemode: true:
--
--   plan     monthly    annual      seat/mo   seat/yr
--   Launch   $79.00     $790.00     $10.00    $100.00
--   Growth   $199.00    $1,990.00   $10.00    $100.00
--   Scale    $449.00    $4,490.00   $10.00    $100.00
--
-- The three products on the Connect account have been archived (active: false)
-- so they cannot be mistaken for the live catalog later. Their prices remain but
-- are unusable while the product is archived.
--
-- WHY THIS WAS NOT CAUGHT
--
-- `scripts/check-stripe-catalog.mjs` exists precisely to compare platform_plans
-- against what the live key can actually see, and it is the check that would
-- have failed on its first run. It has never run: it needs STRIPE_SECRET_KEY in
-- GitHub Actions, which is a different store from Lovable, so every CI run has
-- printed `NOT ARMED` and exited 2. A gate that is never armed is not a gate.
-- Arming it is the follow-up that stops this recurring.

UPDATE public.platform_plans SET
  stripe_product_id           = 'prod_V0UjeSKYAyQvIS',
  stripe_price_id             = 'price_1U0TkdQjJFmqXgZD7ZlwFfon',
  stripe_annual_price_id      = 'price_1U0TkhQjJFmqXgZDUtJL52YW',
  stripe_seat_price_id        = 'price_1U0TkoQjJFmqXgZDS0A78AVa',
  stripe_annual_seat_price_id = 'price_1U0TkyQjJFmqXgZDDvxvUvh9'
WHERE slug = 'launch';

UPDATE public.platform_plans SET
  stripe_product_id           = 'prod_V0Uj7ofcZZNMyI',
  stripe_price_id             = 'price_1U0Tl3QjJFmqXgZD9jjiGjBY',
  stripe_annual_price_id      = 'price_1U0Tl9QjJFmqXgZDRmNxhSKR',
  stripe_seat_price_id        = 'price_1U0TlGQjJFmqXgZDhUO2tNSZ',
  stripe_annual_seat_price_id = 'price_1U0TlKQjJFmqXgZDuMN8jpWM'
WHERE slug = 'growth';

UPDATE public.platform_plans SET
  stripe_product_id           = 'prod_V0UjjWpzBzkMeD',
  stripe_price_id             = 'price_1U0TlQQjJFmqXgZDoYESWcVd',
  stripe_annual_price_id      = 'price_1U0TlVQjJFmqXgZDpIKedi1c',
  stripe_seat_price_id        = 'price_1U0TlaQjJFmqXgZDeP7VVk90',
  stripe_annual_seat_price_id = 'price_1U0TleQjJFmqXgZDB1V7m2kg'
WHERE slug = 'scale';

-- ── the migration asserts its own completeness ─────────────────────────────
-- Same shape as the cutover migration this one repairs: state the outcome and
-- raise rather than leave a half-applied catalog that reads as finished.
DO $$
DECLARE
  stragglers TEXT;
  repointed  INT;
BEGIN
  -- 1. Not one Connect-account id may survive anywhere in the table.
  SELECT string_agg(slug || ' (' || col || ')', ', ') INTO stragglers
  FROM (
    SELECT slug, 'product' AS col FROM public.platform_plans WHERE stripe_product_id LIKE '%QUHYdejlaV%'
    UNION ALL
    SELECT slug, 'price' FROM public.platform_plans WHERE stripe_price_id LIKE '%QUHYdejlaV%'
    UNION ALL
    SELECT slug, 'annual' FROM public.platform_plans WHERE stripe_annual_price_id LIKE '%QUHYdejlaV%'
    UNION ALL
    SELECT slug, 'seat' FROM public.platform_plans WHERE stripe_seat_price_id LIKE '%QUHYdejlaV%'
    UNION ALL
    SELECT slug, 'annual_seat' FROM public.platform_plans WHERE stripe_annual_seat_price_id LIKE '%QUHYdejlaV%'
  ) q;
  IF stragglers IS NOT NULL THEN
    RAISE EXCEPTION 'Connect-account Stripe ids still present in platform_plans: %', stragglers;
  END IF;

  -- 2. All three paid plans must carry a COMPLETE set of platform-account ids.
  --    Checking the account fragment, not merely non-null: a null and an id from
  --    the wrong account are different mistakes and both must fail here.
  --
  --    PRICE ids embed the owning account; PRODUCT ids do not. `prod_V0UjeSKYAyQvIS`
  --    carries no account fragment at all, so the LIKE trick that works on the four
  --    price columns is meaningless on the product column and would never match.
  --    The first version of this assertion applied it to all five and failed with
  --    "got 0" against data that was in fact correct — the migration rolled back
  --    rather than half-apply, which is the behaviour wanted, but the check was
  --    the thing at fault. Products are pinned by literal id instead.
  SELECT count(*) INTO repointed
  FROM public.platform_plans
  WHERE slug IN ('launch', 'growth', 'scale')
    AND stripe_price_id             LIKE '%QjJFmqXgZD%'
    AND stripe_annual_price_id      LIKE '%QjJFmqXgZD%'
    AND stripe_seat_price_id        LIKE '%QjJFmqXgZD%'
    AND stripe_annual_seat_price_id LIKE '%QjJFmqXgZD%'
    AND stripe_product_id IN (
      'prod_V0UjeSKYAyQvIS', 'prod_V0Uj7ofcZZNMyI', 'prod_V0UjjWpzBzkMeD'
    );
  IF repointed <> 3 THEN
    RAISE EXCEPTION
      'expected 3 plans fully repointed to the platform account, got %', repointed;
  END IF;
END $$;
