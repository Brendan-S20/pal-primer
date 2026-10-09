-- Managed texting is coming soon, not on sale (owner, 2026-10-09).
--
-- 20260816130000 kept it sellable as a waitlist: billing started on purchase
-- and texting would switch on when carrier registration (10DLC) cleared. The
-- owner has now chosen the other side of that call. While the registration
-- is a queue with no date, nobody should pay for a place in it. The
-- marketing site says the same: "Coming soon · on sale when carrier
-- registration clears".
--
-- `coming_soon` is a status the billing page already renders and
-- `subscribePlatformAddon` already refuses (20260719100000, and the
-- receptionist in 20261003120000), so this is a catalog change, not a code
-- one. The slug appears nowhere in src/.
--
-- Existing purchases are left alone. Production has one, from 2026-08-04,
-- with no Stripe customer and no subscription item behind it, so nobody is
-- being charged. On a fresh build the row may not exist, so this updates by
-- slug, warns if there is nothing to update, and asserts only what it
-- establishes.

UPDATE public.platform_addons
   SET status = 'coming_soon',
       description =
         'Two-way client texting through a HoundStack-managed number, with '
         'consent and STOP compliance handled for you, and no Twilio account '
         'of your own. Coming soon: it goes on sale once carrier registration '
         '(10DLC) approves the number. That is a mobile carrier queue we '
         'submit to and do not control, so we cannot promise a date.',
       updated_at = now()
 WHERE slug = 'managed-sms';

DO $check$
DECLARE
  _status text;
  _d text;
BEGIN
  SELECT status, description INTO _status, _d
    FROM public.platform_addons
   WHERE slug = 'managed-sms';

  IF NOT FOUND THEN
    RAISE WARNING 'no managed-sms add-on on this database; nothing was taken off sale';
    RETURN;
  END IF;

  IF _status IS DISTINCT FROM 'coming_soon' THEN
    RAISE EXCEPTION 'managed texting is still purchasable (status %)', _status;
  END IF;
  -- The two things 20260816130000 required a buyer could not miss still hold.
  IF _d !~* '(10DLC|carrier registration)' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer mentions the registration it waits on';
  END IF;
  IF _d !~* 'cannot promise a date' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer admits there is no committed date';
  END IF;
END
$check$;
