-- The two white-label add-ons become one, at a price that reflects what is
-- being sold.
--
-- ── THE DECISION, AND WHOSE IT WAS ────────────────────────────────────────
--
-- Owner call, 2026-08-15: "I don't feel like that's enough to lose my
-- branding." White-label portal and white-label emails were $19/mo each.
--
-- What $19 was pricing: 24% of the cheapest plan (Launch, $79) and 4% of the
-- most expensive (Scale, $449), for the one capability that removes HoundStack
-- from the product entirely. And not merely a logo — white-labelling removes
-- HoundStack from every email a tenant's clients receive and every portal page
-- they visit. Those clients are homeowners, which is exactly the population
-- that hears about a pet-waste CRM from an operator already using one. The
-- $19 was selling the referral surface, not the branding.
--
-- ── WHY ONE ADD-ON RATHER THAN TWO REPRICED ONES ──────────────────────────
--
-- They are delivered together and cannot sensibly be delivered apart: both need
-- the same conversation about the tenant's domain and the same DNS records.
-- Selling them separately implied a choice that operations does not actually
-- offer, and made "$19" look like a toggle rather than a service with setup
-- behind it.
--
-- So: `white-label` at $99/mo, replacing `white-label-portal` and
-- `white-label-emails`.
--
-- ── THE IDS BELOW, READ FROM THE LIVE ACCOUNT ─────────────────────────────
--
-- Created on acct_1U0RifQjJFmqXgZD (the PLATFORM account) before this file was
-- written, so these are transcribed rather than predicted:
--
--   product  prod_V4sHgVCHmct5Rr
--   price    price_1U4iX9QjJFmqXgZDZb42kb4r   9900 usd, recurring month
--   lookup   addon_white_label
--
-- The lookup key matters more than the id. Since #90 the app resolves add-on
-- prices by `addon_<slug>` and treats the stored id as a fallback, so the key
-- is what actually decides the amount charged. `addonLookupKey('white-label')`
-- normalises to exactly `addon_white_label`.
--
-- ── NOBODY IS GRANDFATHERED, CHECKED RATHER THAN ASSUMED ──────────────────
--
-- org_platform_addons holds six rows and all six belong to Demo Pet Waste Co,
-- which has no stripe_customer_id and no stripe_subscription_id. No real
-- customer has ever bought an add-on, so there is no existing subscriber whose
-- price changes under them. This is the last moment that is true.
--
-- The two demo rows pointing at the retired add-ons are left alone: they are
-- seed data, they bill nothing, and rewriting them would only make the demo
-- disagree with the catalog it is meant to illustrate.

-- ── THE NEW ROW ───────────────────────────────────────────────────────────
--
-- sort_order takes the lower of the two it replaces, so the pricing page keeps
-- white-label in the position customers already saw it in.
INSERT INTO public.platform_addons
  (slug, name, description, price_cents, billing_interval,
   stripe_product_id, stripe_price_id, feature_flag, is_active, status, sort_order)
VALUES (
  'white-label',
  'White label',
  'Your own domain on the client portal and client emails sent from your domain, '
    'so the people you serve see your business rather than ours. Setup is arranged '
    'after purchase.',
  9900,
  'month',
  'prod_V4sHgVCHmct5Rr',
  'price_1U4iX9QjJFmqXgZDZb42kb4r',
  -- No feature flag, deliberately. Four of the six add-ons have none, because
  -- what they buy is work rather than a switch: setFeatureFlag opens with
  -- `if (!flag) return;` and there is no column for this one to set. Delivery is
  -- the DNS and domain setup, done on request.
  NULL,
  true,
  'active',
  COALESCE(
    (SELECT MIN(sort_order) FROM public.platform_addons
      WHERE slug IN ('white-label-portal', 'white-label-emails')),
    0
  )
)
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  price_cents = EXCLUDED.price_cents,
  billing_interval = EXCLUDED.billing_interval,
  stripe_product_id = EXCLUDED.stripe_product_id,
  stripe_price_id = EXCLUDED.stripe_price_id,
  is_active = EXCLUDED.is_active,
  status = EXCLUDED.status,
  updated_at = now();

-- ── RETIRING THE TWO IT REPLACES ──────────────────────────────────────────
--
-- `disabled` rather than deleted. subscribePlatformAddon refuses anything whose
-- status is not 'active', so this is a real server-side gate and not a UI hide;
-- and check-stripe-catalog skips `is_active = false` rows, so the archived
-- Stripe prices behind them stop being compared instead of failing the gate.
--
-- Deleting the rows would orphan the demo org's org_platform_addons entries
-- against a foreign key, and would erase the record that these SKUs existed at
-- a price a customer may have seen quoted.
UPDATE public.platform_addons
   SET is_active = false,
       status = 'disabled',
       updated_at = now()
 WHERE slug IN ('white-label-portal', 'white-label-emails');
