-- The Stripe catalog moved from sandbox to live mode.
--
-- ── WHAT WAS TRUE BEFORE THIS ─────────────────────────────────────────────
--
-- Every Stripe id in this database was a sandbox id. `platform_plans` pointed
-- launch/growth/scale at twelve sandbox prices, three retired plans and three
-- coming-soon add-ons carried sandbox ids of their own, and four organizations
-- held sandbox customer, subscription and Connect account ids.
--
-- That was the correct state while nothing could be sold. It stops being
-- correct the moment a live secret key is in the environment, because a
-- sandbox id does not fail loudly against a live key — `platform_plans` would
-- still render $79 on the pricing page and checkout would die at the card
-- form, in front of the first person who ever tried to pay.
--
-- ── WHAT THIS DOES ────────────────────────────────────────────────────────
--
--   1. Repoints launch/growth/scale at the live catalog. Three products and
--      twelve prices, created 2026-08-03 in acct_1U0CVSQUHYdejlaV, each one
--      verified `livemode: true` and matching this table to the cent:
--
--        Launch   $79/mo   $790/yr    seat $10/mo   seat $100/yr
--        Growth   $199/mo  $1,990/yr  seat $10/mo   seat $100/yr
--        Scale    $449/mo  $4,490/yr  seat $10/mo   seat $100/yr
--
--      Annual is 10x monthly on every line — the two-months-free convention
--      the sandbox already used. The annual SEAT amount is the one number that
--      exists in neither this table nor the checker's assertions (there is no
--      annual_seat_price_cents column, and check-stripe-catalog.mjs verifies
--      that price's existence and interval but deliberately not its amount),
--      so $100/yr is a decision recorded here rather than a value recovered
--      from anywhere.
--
--   2. Clears the sandbox ids that survive nowhere useful. Retired plans and
--      coming-soon add-ons keep their prices in cents; only the dead Stripe
--      pointers go. Nulling them costs nothing — every one of those rows is
--      unsellable — and leaving them is how a reactivated SKU quietly charges
--      against an account the app no longer talks to.
--
--   3. Clears sandbox customer, subscription and Connect ids on organizations.
--      This is the part that is not housekeeping. Two organizations carried
--      `stripe_connect_charges_enabled = true` against Connect accounts that
--      exist only in sandbox, so the app believed those tenants could accept
--      customer payments. Under a live key they cannot, and the discovery
--      would have happened at the moment a homeowner pressed Pay.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
--
-- `plan_status` is left alone. Demo Pet Waste Co reads 'active', which
-- `PAID_STATUSES` in src/lib/trial.ts treats as paid without consulting the
-- subscription id, so clearing the id below leaves the demo tenant reading
-- `paid` exactly as it did before — the marketing screenshots are built from
-- that org and none of them change. Writing 'free' here would have switched
-- off the demo's AI features and rewritten the screenshots as a side effect of
-- a Stripe migration, which is not what a Stripe migration is for.
--
-- Enterprise is untouched: active, no product, no prices, a contact-us tier.
-- The catalog checker skips it by design and demanding ids for it would be
-- wrong.

-- No explicit BEGIN/COMMIT: the migration runner wraps each file in its own
-- transaction, as every other migration in this directory relies on. The
-- assertion at the bottom therefore rolls the whole thing back rather than
-- leaving the catalog half-repointed.

-- ── 1. The live catalog ───────────────────────────────────────────────────

update public.platform_plans set
  stripe_product_id           = 'prod_V0Ev2UXEoRoqUN',
  stripe_price_id             = 'price_1U0ERdQUHYdejlaVBr4C57JD',  -- $79.00/mo
  stripe_annual_price_id      = 'price_1U0EReQUHYdejlaV3A5yEr1q',  -- $790.00/yr
  stripe_seat_price_id        = 'price_1U0ERiQUHYdejlaVkf94qyTz',  -- $10.00/mo
  stripe_annual_seat_price_id = 'price_1U0ERjQUHYdejlaVC4mazzSd',  -- $100.00/yr
  updated_at                  = now()
where slug = 'launch';

update public.platform_plans set
  stripe_product_id           = 'prod_V0EvotqcFlpxc9',
  stripe_price_id             = 'price_1U0ERnQUHYdejlaV8t2qrsZh',  -- $199.00/mo
  stripe_annual_price_id      = 'price_1U0ERpQUHYdejlaVvv2X5QIC',  -- $1,990.00/yr
  stripe_seat_price_id        = 'price_1U0ERqQUHYdejlaVwVppI8hJ',  -- $10.00/mo
  stripe_annual_seat_price_id = 'price_1U0ERrQUHYdejlaVwoKi7Gwe',  -- $100.00/yr
  updated_at                  = now()
where slug = 'growth';

update public.platform_plans set
  stripe_product_id           = 'prod_V0EvAMtHtn9CMr',
  stripe_price_id             = 'price_1U0ERwQUHYdejlaV57GAxDyj',  -- $449.00/mo
  stripe_annual_price_id      = 'price_1U0ERxQUHYdejlaVzrmP1dpW',  -- $4,490.00/yr
  stripe_seat_price_id        = 'price_1U0ERzQUHYdejlaV712ez6VB',  -- $10.00/mo
  stripe_annual_seat_price_id = 'price_1U0ES0QUHYdejlaVpWhr7Rzm',  -- $100.00/yr
  updated_at                  = now()
where slug = 'scale';

-- ── 2. Dead sandbox pointers on unsellable rows ───────────────────────────

update public.platform_plans set
  stripe_product_id           = null,
  stripe_price_id             = null,
  stripe_annual_price_id      = null,
  stripe_seat_price_id        = null,
  stripe_annual_seat_price_id = null,
  updated_at                  = now()
where not is_active
  and (stripe_product_id is not null or stripe_price_id is not null);

update public.platform_addons set
  stripe_product_id = null,
  stripe_price_id   = null,
  updated_at        = now()
where not is_active
  and (stripe_product_id is not null or stripe_price_id is not null);

-- ── 3. Sandbox tenant state ───────────────────────────────────────────────
--
-- `organizations` carries a guard trigger — tg_orgs_protect_platform_columns —
-- over exactly the columns below: plan and billing state, the Stripe customer
-- and subscription ids, and the four Connect columns that decide where a
-- homeowner's card money lands. A tenant user cannot move any of them, which is
-- the point. The first attempt at this migration was refused by that trigger
-- and rolled the whole file back, which is the trigger doing its job.
--
-- The escape hatch is the one the trigger itself documents and that six earlier
-- migrations already use. `true` makes it transaction-local, so it expires when
-- this migration commits rather than leaving the guard disabled behind us.
select set_config('app.allow_protected_org_write', '1', true);

update public.organizations set
  stripe_customer_id     = null,
  stripe_subscription_id = null
where stripe_customer_id is not null
   or stripe_subscription_id is not null;

-- Mirrors the disconnect path in src/lib/stripe-connect.functions.ts, which
-- writes exactly this triple. `charges_enabled = false` is the important one:
-- it is what the portal consults before offering to take a card.
update public.organizations set
  stripe_connect_account_id      = null,
  stripe_connect_status          = null,
  stripe_connect_charges_enabled = false,
  stripe_connect_connected_at    = null
where stripe_connect_account_id is not null;

-- ── 4. Refuse to commit a half-applied cutover ─────────────────────────────
--
-- A silent partial apply here is the failure this whole migration exists to
-- prevent, so it is asserted rather than assumed.
do $$
declare
  live_plans int;
  stale_ids  int;
begin
  select count(*) into live_plans
    from public.platform_plans
   where slug in ('launch', 'growth', 'scale')
     and stripe_product_id is not null
     and stripe_price_id is not null
     and stripe_annual_price_id is not null
     and stripe_seat_price_id is not null
     and stripe_annual_seat_price_id is not null
     and stripe_product_id like 'prod_V0Ev%';

  if live_plans <> 3 then
    raise exception
      'expected 3 plans repointed at the live catalog, found %. Refusing to commit a partial cutover.',
      live_plans;
  end if;

  -- Nothing anywhere may still hold a pointer into the sandbox account.
  select
      (select count(*) from public.platform_plans
        where stripe_product_id is not null and stripe_product_id not like 'prod_V0Ev%')
    + (select count(*) from public.platform_addons where stripe_price_id is not null)
    + (select count(*) from public.organizations
        where stripe_customer_id is not null
           or stripe_subscription_id is not null
           or stripe_connect_account_id is not null)
    into stale_ids;

  if stale_ids <> 0 then
    raise exception
      '% sandbox Stripe id(s) survived the cutover. Every one of them fails silently against a live key.',
      stale_ids;
  end if;
end $$;


