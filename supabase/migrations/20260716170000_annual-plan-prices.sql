-- Annual billing (UX round 7): each paid plan gets a yearly Stripe price
-- (two months free: annual = 10x monthly) plus a yearly seat-overage price.
-- Price ids reference objects created in the platform Stripe account.
alter table public.platform_plans
  add column if not exists annual_price_cents integer,
  add column if not exists stripe_annual_price_id text,
  add column if not exists stripe_annual_seat_price_id text;

update public.platform_plans set
  annual_price_cents = 79000,
  stripe_annual_price_id = 'price_1TtjIgHJRMTjWv4jmnDewjEt',
  stripe_annual_seat_price_id = 'price_1TtjIhHJRMTjWv4jPQBSj5GZ'
where slug = 'launch';

update public.platform_plans set
  annual_price_cents = 199000,
  stripe_annual_price_id = 'price_1TtjIrHJRMTjWv4j1CBQOUjY',
  stripe_annual_seat_price_id = 'price_1TtjIsHJRMTjWv4jrYUqHrgC'
where slug = 'growth';

update public.platform_plans set
  annual_price_cents = 449000,
  stripe_annual_price_id = 'price_1TtjJ0HJRMTjWv4jMxwlX153',
  stripe_annual_seat_price_id = 'price_1TtjJ1HJRMTjWv4j9ikViSXT'
where slug = 'scale';
