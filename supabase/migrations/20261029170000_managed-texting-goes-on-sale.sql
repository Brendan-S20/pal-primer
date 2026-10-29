-- Managed texting goes on sale (2026-10-29).
--
-- 20261009120000 made it `coming_soon` because there was nothing to sell:
-- per-business numbers sat in a carrier queue with no date. BUILD-3 (#585,
-- 20261029160000) built the thing a buyer pays for: a Twilio subaccount per
-- business and a toll-free verification filed in that business's own name,
-- started from Settings → Texting. This file is the catalog half of the
-- launch; `ADDON_LAUNCHED["managed-sms"]` in src/lib/addon-launch.ts is the
-- code half, and neither alone sells it.
--
-- The copy loses its first two words and nothing else. 20261009150000 set
-- A-P0-2's description, which the Twilio Specialist approved as an exact
-- string beginning "Coming soon."; the rest of that string is kept verbatim,
-- because "close to the approved text" is not the approved text. (It says
-- "local number" where #585 files toll-free by default. Changing that is a
-- copy change for the owner and the Specialist, not part of a launch.)
--
-- No subscription, no org row and no Stripe price is touched. The price stays
-- what 20261009150000 left it. On a fresh build the row may not exist, so
-- this updates by slug and warns if there is nothing to update.

UPDATE public.platform_addons
   SET status = 'active',
       description =
         'Two-way texting with your clients from your own local number, '
         'registered with carriers under your business name. HoundStack handles the setup '
         'and carrier filing for you, with consent and STOP handling built in. We''ll need '
         'your business details and approval before registering. No Twilio account of your '
         'own required.',
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
    RAISE WARNING 'no managed-sms add-on on this database; nothing was put on sale';
    RETURN;
  END IF;

  IF _status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'managed texting is not on sale (status %)', _status;
  END IF;
  IF _d ~* 'coming soon' THEN
    RAISE EXCEPTION 'the managed-texting copy still says coming soon';
  END IF;
  IF _d !~* 'registered with carriers under your business name' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer says how the number is registered';
  END IF;
END
$check$;
