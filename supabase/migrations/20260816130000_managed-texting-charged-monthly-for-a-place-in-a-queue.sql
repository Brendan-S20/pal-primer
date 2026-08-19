-- Managed texting charged $29 a month for a place in a queue, and said so
-- nowhere.
--
-- ── WHAT A BUYER SAW, AND WHAT THEY GOT ───────────────────────────────────
--
-- The catalog row read:
--
--   "Skip the Twilio setup entirely. Two-way client texting runs through a
--    HoundStack-managed number, with consent and STOP compliance handled for
--    you."
--
-- Every word of that is true eventually and none of it is true on the day of
-- purchase. `managed-sms` is `is_active = true`, `status = 'active'` and has no
-- feature flag, so subscribePlatformAddon takes the money and starts the
-- subscription immediately. The delivery it describes waits on 10DLC/A2P brand
-- and campaign registration, which the brief has recorded as "in the compliance
-- queue; nothing to accelerate" since v1.1.
--
-- The slug appears NOWHERE in src/. Not a feature flag, not a gate, not a
-- delivery path — grep returns nothing. So the add-on charges monthly and the
-- product does not change in any way a customer can observe.
--
-- ── WHY IT STAYS SELLABLE ─────────────────────────────────────────────────
--
-- Owner call, 2026-08-16, offered the choice of disabling it: sell it as a
-- waitlist, priced honestly. Registration is real work already underway, and a
-- customer who wants to be first in line when it clears should be able to say
-- so. What was wrong was never the price — it was a description that let
-- somebody believe they were buying something that would work that afternoon.
--
-- This is NOT the same case as white-label, and the difference is the reason
-- this file exists. White-label's setup is DNS records and a domain
-- conversation: our work, measured in days, and its description says "Setup is
-- arranged after purchase" because that is a promise we can keep. Carrier
-- registration is a third party's queue with no committed date. A description
-- that treats those two as the same kind of wait is the dishonest part.
--
-- So the copy below leads with the wait rather than burying it, and does not
-- give a date we do not have. "Weeks" is deliberately absent: the registrar
-- does not promise one and neither should we.

UPDATE public.platform_addons
   SET description =
         'Two-way client texting through a HoundStack-managed number, with '
         'consent and STOP compliance handled for you — no Twilio account of '
         'your own. Buying this reserves your place: texting switches on once '
         'carrier registration (10DLC) approves the number, which is a mobile '
         'carrier queue we submit to and do not control, so we cannot promise '
         'a date. Billing starts today. Cancel any time before it clears and '
         'you have lost nothing.',
       updated_at = now()
 WHERE slug = 'managed-sms';

DO $$
DECLARE _d text;
BEGIN
  SELECT description INTO _d FROM public.platform_addons WHERE slug = 'managed-sms';

  IF _d IS NULL THEN
    -- A fresh build has the row from the seed catalog; if it does not, this
    -- migration has nothing to correct and should say so rather than pass
    -- quietly on an UPDATE that matched nothing.
    RAISE WARNING 'no managed-sms add-on to reword';
    RETURN;
  END IF;

  -- The two things a buyer must not be able to miss. Asserted rather than
  -- trusted, because the whole fault being fixed here was copy that read fine
  -- and left the wrong impression.
  IF _d !~* '(10DLC|carrier registration)' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer mentions the registration it waits on';
  END IF;
  IF _d !~* 'cannot promise a date' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer admits there is no committed date';
  END IF;
END $$;
