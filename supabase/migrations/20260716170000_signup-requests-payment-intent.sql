-- Public signup prepay moves from hosted Stripe Checkout to an in-app
-- Payment Element (PaymentIntent-first), so the request row needs to track
-- the intent id alongside the legacy checkout session id.
alter table public.signup_requests
  add column if not exists stripe_payment_intent_id text;
