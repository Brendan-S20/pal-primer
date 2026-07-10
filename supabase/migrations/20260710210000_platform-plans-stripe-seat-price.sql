-- Per-employee plan Stripe wiring (finding #6 follow-through).
--
-- Records the sandbox Stripe product + base price + per-seat overage price for
-- the launch/growth/scale plans so checkout can bill the flat base plus a
-- per-employee overage line item. Enterprise stays custom (no Stripe price).
-- Idempotent: safe to re-run.

alter table platform_plans
  add column if not exists stripe_seat_price_id text;

update platform_plans set
  stripe_product_id    = 'prod_UrK8Io81TbuHde',
  stripe_price_id      = 'price_1TrbU4HJRMTjWv4jtMWwYJvW',
  stripe_seat_price_id = 'price_1TrbU8HJRMTjWv4jYOZG4kQl'
where slug = 'launch';

update platform_plans set
  stripe_product_id    = 'prod_UrK8MkvK50jX5k',
  stripe_price_id      = 'price_1TrbUQHJRMTjWv4jE3gGiril',
  stripe_seat_price_id = 'price_1TrbWUHJRMTjWv4jwuHGbkvB'
where slug = 'growth';

update platform_plans set
  stripe_product_id    = 'prod_UrKATNvdJxfS1L',
  stripe_price_id      = 'price_1TrbWcHJRMTjWv4jKgOlw1N6',
  stripe_seat_price_id = 'price_1TrbWdHJRMTjWv4jYTRdVpRw'
where slug = 'scale';
