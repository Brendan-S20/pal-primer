-- An add-on is bought through Stripe, or not at all (owner, 2026-10-09).
--
-- Two holes, one rule.
--
-- 1. WHITE LABEL WAS ON SALE. `white-label` ($99/mo) has been `active` since
--    20260815140000, and buyable on every plan, while nothing it promises is
--    built: no custom portal domain, no client email from the business's own
--    domain (spec INV-6 failed). NP-5 holds it until both are proven. This
--    sets it to `coming_soon`, which the billing page already renders as a
--    disabled "Coming soon" button and `subscribePlatformAddon` already
--    refuses; the code-level launch flag in src/lib/addon-launch.ts refuses it
--    as well, so flipping this row back alone does not put it on sale.
--
-- 2. AN OWNER COULD GRANT THEMSELVES ANY ADD-ON. The write policies on
--    `org_platform_addons` (merged in 20260810120000) let anyone holding
--    `manage_org_billing` INSERT or UPDATE their own org's rows from the
--    browser client. Nothing guards the table, so an owner could write
--    `status = 'active'` for the AI Receptionist or Managed texting and own it
--    with no Stripe charge behind it. It unlocks nothing today (the
--    receptionist is also behind RECEPTIONIST_LAUNCHED), but it would be a
--    free entitlement the day it launches, and the platform MRR rollup already
--    counts active rows.
--
--    No code in src/ writes this table as the signed-in user: purchase,
--    removal, interval re-pointing and subscription-end deactivation all go
--    through `supabaseAdmin` (the service role, which RLS does not reach), and
--    the platform console reads through it too. So every authenticated write
--    path is removed, the read policy stays, and the table-level write grants
--    go with the policies so a policy added later by mistake is not enough on
--    its own.
--
-- Existing rows are untouched: grandfathered items keep renewing in Stripe,
-- and nothing here reads or writes `org_platform_addons` data.
--
-- On a fresh build the catalog row may not exist; that is warned, not failed.
-- What the file establishes (no authenticated write path) is asserted.

UPDATE public.platform_addons
   SET status = 'coming_soon',
       is_active = false,
       updated_at = now()
 WHERE slug = 'white-label';

DROP POLICY IF EXISTS "org platform addons written by billing or admin (insert)" ON public.org_platform_addons;
DROP POLICY IF EXISTS "org platform addons written by billing or admin (update)" ON public.org_platform_addons;
DROP POLICY IF EXISTS "org platform addons written by billing or admin (delete)" ON public.org_platform_addons;
-- The originals, in case a database still carries them unmerged.
DROP POLICY IF EXISTS "billing managers manage own platform addons" ON public.org_platform_addons;
DROP POLICY IF EXISTS "platform admins manage org platform addons" ON public.org_platform_addons;

REVOKE INSERT, UPDATE, DELETE ON public.org_platform_addons FROM anon, authenticated;

-- RLS stays on, and the two-step restrictive policy stays (it is reapplied
-- idempotently so this file does not depend on an earlier one having run it).
ALTER TABLE public.org_platform_addons ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.org_platform_addons');

DO $check$
DECLARE
  _status text;
  _writers text;
BEGIN
  -- Established here, from any starting state: no permissive policy lets a
  -- signed-in (or anonymous) caller write a row.
  SELECT string_agg(policyname || ' (' || cmd || ')', ', ')
    INTO _writers
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'org_platform_addons'
     AND permissive = 'PERMISSIVE'
     AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     AND roles && ARRAY['authenticated', 'anon', 'public']::name[];
  IF _writers IS NOT NULL THEN
    RAISE EXCEPTION 'org_platform_addons still has an authenticated write path: %', _writers;
  END IF;

  IF has_table_privilege('authenticated', 'public.org_platform_addons', 'INSERT')
     OR has_table_privilege('authenticated', 'public.org_platform_addons', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated still holds INSERT or UPDATE on org_platform_addons';
  END IF;

  -- The read policy is what the billing page lists through; losing it would
  -- blank every tenant's add-on cards.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'org_platform_addons'
       AND permissive = 'PERMISSIVE' AND cmd = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'org_platform_addons lost its read policy';
  END IF;

  SELECT status INTO _status FROM public.platform_addons WHERE slug = 'white-label';
  IF NOT FOUND THEN
    RAISE WARNING 'no white-label add-on on this database; nothing was taken off sale';
  ELSIF _status = 'active' THEN
    RAISE EXCEPTION 'white label is still purchasable';
  END IF;
END
$check$;
