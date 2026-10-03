-- The AI receptionist launches later (owner, 2026-10-03), so its add-on is
-- shown as coming soon and cannot be bought. `coming_soon` is already a status
-- the billing page renders and `subscribePlatformAddon` refuses, so this is a
-- catalog change, not a code one. The code side is RECEPTIONIST_LAUNCHED in
-- src/lib/receptionist-launch.ts, which keeps the model out of the SMS and
-- voice webhooks whatever an org's flags say.
--
-- Existing subscriptions are left alone: the only one is the comped demo org,
-- with no Stripe customer behind it. On a fresh build the row may not exist
-- yet in the shape production has, so this updates by slug and asserts only
-- what it establishes.

UPDATE public.platform_addons
   SET status = 'coming_soon'
 WHERE slug = 'ai-receptionist';

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.platform_addons
     WHERE slug = 'ai-receptionist' AND status IS DISTINCT FROM 'coming_soon'
  ) THEN
    RAISE EXCEPTION 'the receptionist add-on is still purchasable';
  END IF;
END
$check$;
