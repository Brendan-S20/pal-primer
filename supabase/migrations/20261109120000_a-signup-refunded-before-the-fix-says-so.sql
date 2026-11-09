-- A signup refunded before the fix says so (#675).
--
-- 20261102130000 (#698) taught the Stripe webhook to write
-- signup_requests.refunded_at / refunded_amount_cents / stripe_refund_id when
-- a business refunds the payment of a signup it already provisioned, and
-- backfilled payments.refunded_cents from the reversal ledger. It backfilled
-- nothing on signup_requests. So every provisioned signup refunded before
-- that code shipped -- E1's 5c4ad3aa (PI pi_3UXBtRH7o0ny3UiP0bGFRa7z,
-- refunded 2026-11-01 from INV-1069) is the one we know of -- keeps all three
-- columns NULL for good: no later event re-sends a refund that already
-- happened, and Leads still reads "Started service online" for somebody who
-- has their money back.
--
-- The ledger has two of the three facts. The reversal ledger's
-- 'payment_refunded' row (file_reversal_review_item) holds Stripe's
-- cumulative amount_refunded for the charge -- the same figure the webhook
-- writes as refunded_amount_cents -- and detected_at is when the first refund
-- landed. The refund's Stripe id is stored nowhere in the database, so
-- stripe_refund_id is left NULL here rather than invented; the webhook now
-- fills it if Stripe sends any later event for that refund.
--
-- Matched exactly as the webhook matches (src/lib/refund-outcome.server.ts
-- recordRefundOnSignup): same organization, same payment intent, a
-- PROVISIONED signup. A failed signup is refunded by provisionSignup, which
-- writes these columns itself. Only rows with refunded_at still NULL are
-- touched, so a row the webhook already wrote is never overwritten.
--
-- Replays into an empty database: one UPDATE over whatever rows exist, which
-- on a fresh build is none. No assertion depends on data.

UPDATE public.signup_requests sr
   SET refunded_at = r.first_refunded_at,
       refunded_amount_cents = LEAST(r.amount_cents, 2147483647)::integer
  FROM (
    SELECT p.organization_id,
           p.stripe_payment_intent_id,
           max(COALESCE((ri.detail->>'amount_cents')::bigint, 0)) AS amount_cents,
           min(ri.detected_at) AS first_refunded_at
      FROM public.payments p
      JOIN public.review_items ri
        ON ri.subject_id = p.id
       AND ri.organization_id = p.organization_id
       AND ri.kind = 'payment_refunded'
     WHERE p.status = 'refunded'
       AND p.stripe_payment_intent_id IS NOT NULL
     GROUP BY p.organization_id, p.stripe_payment_intent_id
  ) r
 WHERE sr.organization_id = r.organization_id
   AND sr.stripe_payment_intent_id = r.stripe_payment_intent_id
   AND sr.status = 'provisioned'
   AND sr.refunded_at IS NULL
   AND r.amount_cents > 0;

-- ── What this file leaves behind ──────────────────────────────────────────
-- A count, not an assertion: how many provisioned signups still have a
-- refunded payment and no refund recorded (a refund whose ledger row failed
-- to file). On a fresh build this is zero, which is also true.
DO $post$
DECLARE _n integer;
BEGIN
  SELECT count(*) INTO _n
    FROM public.signup_requests sr
    JOIN public.payments p
      ON p.organization_id = sr.organization_id
     AND p.stripe_payment_intent_id = sr.stripe_payment_intent_id
   WHERE sr.status = 'provisioned'
     AND sr.refunded_at IS NULL
     AND p.status = 'refunded';
  IF _n > 0 THEN
    RAISE WARNING '% provisioned signup(s) have a refunded payment and no refund recorded; the reversal ledger has no amount for them', _n;
  END IF;
END
$post$;
