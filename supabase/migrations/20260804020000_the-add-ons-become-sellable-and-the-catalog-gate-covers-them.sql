-- Every add-on becomes sellable, on the platform Stripe account.
--
-- ── WHAT WAS ACTUALLY THERE ───────────────────────────────────────────────
--
-- All six rows carried `stripe_product_id = NULL` and `stripe_price_id = NULL`.
-- Three of them used to hold ids, and those ids were TEST-mode ids on the
-- CONNECT account — the same wrong-account mistake the plan catalog was rebuilt
-- to fix. They were nulled with that rebuild and nothing replaced them.
--
-- It was not a live defect only because all six were also `coming_soon` /
-- `is_active = false`: subscribePlatformAddon refuses a `coming_soon` add-on
-- before Stripe is ever consulted. Unsellable is not the same as correct,
-- though, and the gap was invisible from the pricing page, which listed all six
-- with prices next to a "Coming soon" badge.
--
-- ── AND THE GATE WAS MEASURING NOTHING ────────────────────────────────────
--
-- scripts/check-stripe-catalog.mjs skips any add-on with `is_active = false`.
-- With all six inactive it validated twelve plan prices and ZERO add-on prices
-- while printing a tick. It says so in its own output — that is why it prints
-- the skip list every run, pass or fail — but a check that covers none of a
-- category is one nobody should be reading as coverage. Flipping these rows is
-- what puts them under it.
--
-- ── THE IDS BELOW ─────────────────────────────────────────────────────────
--
-- Created 2026-08-04 on acct_1U0RifQjJFmqXgZD (HoundStack Platform — the
-- account that bills TENANTS for the software, NOT the Connect account that
-- lets tenants charge their own clients). Every price came back
-- `livemode: true`, and every price id carries the platform account's fragment
-- `QjJFmqXgZD` — which is the one mechanical check that catches the
-- wrong-account mistake, because price ids embed the owning account and product
-- ids do not.
--
-- `developer-setup` is one-time (`recurring: null`, `type: one_time`);
-- subscribePlatformAddon puts it on the next invoice as an invoice item rather
-- than a subscription item. The other five recur monthly.
--
-- ── WHY BOTH `status` AND `is_active` ─────────────────────────────────────
--
-- They are read by different things and neither implies the other:
--   * `status`    — the purchase gate and the pricing badge (subscribe refuses
--                   'coming_soon'; the list hides 'disabled').
--   * `is_active` — what the catalog gate uses to decide whether a row is worth
--                   comparing against Stripe.
-- Setting only `status` would make the add-ons buyable while leaving them
-- outside the check that verifies the buyer is charged what the page says.

DO $$
DECLARE
  _updated int;
BEGIN
  UPDATE public.platform_addons a SET
    stripe_product_id = v.product_id,
    stripe_price_id   = v.price_id,
    status            = 'active',
    is_active         = true,
    updated_at        = now()
  FROM (VALUES
    ('ai-receptionist',    'prod_V0YfqJCXufXVpa', 'price_1U0XYEQjJFmqXgZD3mAReaQd',  4900, 'month'),
    ('managed-sms',        'prod_V0YfLhROT7OIFo', 'price_1U0XYGQjJFmqXgZDpS9gmI2P',  2900, 'month'),
    ('white-label-portal', 'prod_V0YfU4MaSctaeL', 'price_1U0XYGQjJFmqXgZDBkireNlb',  1900, 'month'),
    ('white-label-emails', 'prod_V0YfqrRzjPg15c', 'price_1U0XYIQjJFmqXgZDPnYHRXL0',  1900, 'month'),
    ('priority-support',   'prod_V0YfzG7hLCZqtL', 'price_1U0XYKQjJFmqXgZDybU43hg2',  2900, 'month'),
    ('developer-setup',    'prod_V0Yf74k6UNvR6I', 'price_1U0XYLQjJFmqXgZDwSlac1AS', 49900, 'one_time')
  ) AS v(slug, product_id, price_id, cents, interval)
  WHERE a.slug = v.slug
    -- Refuse to repoint a row whose price has drifted from what was created in
    -- Stripe. The whole point of these ids is that the database's cents and
    -- Stripe's unit_amount agree; if this migration ran against a catalog that
    -- had been repriced, it would silently attach a $49 price id to a $59 row
    -- and the check would then confirm the wrong pairing as correct.
    AND a.price_cents = v.cents
    AND a.billing_interval = v.interval;

  GET DIAGNOSTICS _updated = ROW_COUNT;
  IF _updated <> 6 THEN
    RAISE EXCEPTION
      'expected to repoint 6 add-ons, repointed %. The catalog does not match the prices created in Stripe — do not guess, re-check platform_addons against acct_1U0RifQjJFmqXgZD.',
      _updated;
  END IF;
END $$;

-- Every price id must carry the PLATFORM account's fragment. This is the check
-- that would have caught the original wrong-account build: a Connect-account
-- price id reads `...QUHYdejlaV...` and a platform one `...QjJFmqXgZD...`.
-- Product ids are deliberately not checked — they carry no account fragment.
DO $$
DECLARE _bad int;
BEGIN
  SELECT count(*) INTO _bad
    FROM public.platform_addons
   WHERE is_active
     AND (stripe_price_id IS NULL OR stripe_price_id NOT LIKE '%QjJFmqXgZD%');
  IF _bad > 0 THEN
    RAISE EXCEPTION
      '% sellable add-on(s) have a price id that is missing or does not belong to the platform account acct_1U0RifQjJFmqXgZD', _bad;
  END IF;
END $$;
