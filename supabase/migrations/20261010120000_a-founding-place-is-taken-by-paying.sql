-- A founding place is taken by paying (owner, 2026-10-10; spec NP-2).
--
-- LAUNCH20 is for the first 20 PAYING accounts. Stripe counts a promotion
-- code's redemption when a subscription carrying it is CREATED, and the app
-- creates the subscription unpaid (payment_behavior default_incomplete) before
-- the Payment Element takes the card. So Stripe's times_redeemed counts
-- abandoned checkouts too, and an abandoned checkout would burn a place.
--
-- The owner's rule: a founding place is used only by an account that actually
-- paid. This table is that count. A row is written when a subscription
-- carrying the founding code is first seen PAID (active or past_due), by the
-- platform Stripe webhook or by refreshBillingStatus, whichever is first;
-- an incomplete subscription never writes one. A place, once taken, is kept:
-- cancelling later does not hand it to somebody else.
--
-- The number of places (20) is NOT written here. It lives once, in
-- FOUNDING_SPOTS (src/lib/founding-offer.ts), and the app passes it to
-- claim_founding_place. Stripe's max_redemptions on LAUNCH20 stays as a
-- backstop, set higher (scripts/stripe-test-setup.mjs) so that abandoned
-- checkouts do not reach it first.
--
-- ── RACE ──────────────────────────────────────────────────────────────────
--
-- Two payments for place 20 can land at once. claim_founding_place takes a
-- transaction-level advisory lock before it counts, so claims are serial, and
-- `place` is UNIQUE, so even a writer that skipped the lock cannot take a place
-- twice. The second payer gets no place: a row with place NULL, which the app
-- answers by taking the founding discount off that subscription in Stripe so
-- its next invoice is full price, and by logging it. See founding-offer.server.ts
-- for what is left over (that payer's FIRST invoice was already discounted).

CREATE TABLE IF NOT EXISTS public.founding_accounts (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL,
  -- 1..FOUNDING_SPOTS in the order payments were seen; NULL = paid after the
  -- places were gone (the founding discount is removed from the subscription).
  place integer UNIQUE CHECK (place IS NULL OR place >= 1),
  paid_seen_at timestamptz NOT NULL DEFAULT now(),
  discount_removed_at timestamptz
);

COMMENT ON TABLE public.founding_accounts IS
  'LAUNCH20 founding places, one row per account whose founding subscription was seen PAID. '
  'place is NULL for a payment after the places were gone. Written only by claim_founding_place.';

ALTER TABLE public.founding_accounts ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.founding_accounts');
DROP POLICY IF EXISTS "platform admins read founding accounts" ON public.founding_accounts;
CREATE POLICY "platform admins read founding accounts"
  ON public.founding_accounts FOR SELECT TO authenticated
  USING (public.is_platform_admin((SELECT auth.uid())));
REVOKE INSERT, UPDATE, DELETE ON public.founding_accounts FROM anon, authenticated;

-- ── Take a place, once per account ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_founding_place(
  _org uuid,
  _subscription text,
  _spots integer
)
RETURNS TABLE (place integer, newly_claimed boolean, places_taken integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  _row public.founding_accounts%ROWTYPE;
  _taken integer;
BEGIN
  IF _org IS NULL OR _subscription IS NULL OR _spots IS NULL OR _spots < 0 THEN
    RAISE EXCEPTION 'claim_founding_place needs an organization, a subscription and a number of places';
  END IF;

  -- Serial: count and insert under one lock, so two payments cannot both read
  -- "19 taken" and both take place 20.
  PERFORM pg_advisory_xact_lock(hashtext('houndstack.founding_places'));

  SELECT count(*)::integer INTO _taken FROM public.founding_accounts fa WHERE fa.place IS NOT NULL;

  SELECT * INTO _row FROM public.founding_accounts fa WHERE fa.organization_id = _org;
  IF FOUND THEN
    RETURN QUERY SELECT _row.place, false, _taken;
    RETURN;
  END IF;

  INSERT INTO public.founding_accounts (organization_id, stripe_subscription_id, place)
  VALUES (_org, _subscription, CASE WHEN _taken < _spots THEN _taken + 1 END)
  RETURNING * INTO _row;

  RETURN QUERY SELECT _row.place, true, _taken + (CASE WHEN _row.place IS NULL THEN 0 ELSE 1 END);
END;
$$;

REVOKE ALL ON FUNCTION public.claim_founding_place(uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_founding_place(uuid, text, integer) TO service_role;

DO $check$
BEGIN
  IF has_function_privilege('authenticated', 'public.claim_founding_place(uuid, text, integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.claim_founding_place(uuid, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'claim_founding_place is callable by a client role';
  END IF;
  IF has_table_privilege('authenticated', 'public.founding_accounts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.founding_accounts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.founding_accounts', 'DELETE') THEN
    RAISE EXCEPTION 'a client role can write founding_accounts';
  END IF;
  -- A place cannot be held twice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid = 'public.founding_accounts'::regclass AND c.contype = 'u'
       AND c.conkey = ARRAY[(SELECT a.attnum FROM pg_attribute a
                              WHERE a.attrelid = 'public.founding_accounts'::regclass AND a.attname = 'place')]::int2[]
  ) THEN
    RAISE EXCEPTION 'founding_accounts.place is not unique';
  END IF;
END
$check$;
