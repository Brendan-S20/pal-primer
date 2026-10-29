-- Managed texting launches (ADDON_LAUNCHED["managed-sms"] = true).
--
-- 20261009120000 took it off sale while carrier registration was a queue with
-- no date. BUILD-3 (20261029160000, #585) is what it was waiting on: each
-- business now registers and texts from its own Twilio subaccount, and
-- `activate_org_texting()` switches a business on only once its verification
-- is approved. So buying the add-on starts the registration; it does not
-- promise a working number on the day of purchase, and the copy says so.
--
-- Turning a held add-on on is the code flag in src/lib/addon-launch.ts plus
-- this row's status. Price and Stripe ids are unchanged ($29/month,
-- 20260804020000). On a fresh build the row may not exist, so this updates by
-- slug, warns if there is nothing to update, and asserts only what it
-- establishes.

UPDATE public.platform_addons
   SET status = 'active',
       is_active = true,
       description =
         'Two-way texting with your clients from your own number, registered with carriers '
         'under your business name. HoundStack handles the setup and carrier filing for you, '
         'with consent and STOP handling built in. We''ll need your business details and '
         'approval before registering, and texting switches on once the carrier approves. '
         'No Twilio account of your own required.',
       updated_at = now()
 WHERE slug = 'managed-sms';

DO $check$
DECLARE
  _a record;
BEGIN
  SELECT status, is_active, description INTO _a
    FROM public.platform_addons
   WHERE slug = 'managed-sms';

  IF NOT FOUND THEN
    RAISE WARNING 'no managed-sms add-on on this database; nothing was put on sale';
    RETURN;
  END IF;

  IF _a.status IS DISTINCT FROM 'active' OR _a.is_active IS NOT TRUE THEN
    RAISE EXCEPTION 'managed texting did not go on sale (status %, is_active %)', _a.status, _a.is_active;
  END IF;
  IF _a.description ~* 'coming soon' THEN
    RAISE EXCEPTION 'managed texting is on sale but its copy still says coming soon';
  END IF;
  IF _a.description !~* 'carrier' THEN
    RAISE EXCEPTION 'the managed-texting copy no longer mentions the carrier approval it waits on';
  END IF;
END
$check$;
