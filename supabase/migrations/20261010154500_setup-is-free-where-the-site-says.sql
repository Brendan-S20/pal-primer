-- Done-for-you setup is free where the site says it is (owner, 2026-10-09;
-- spec NP-4).
--
-- houndstack.com/pricing says setup "is $199 one time, and free with yearly
-- billing, on Scale, or for founding accounts". The app charged $199 to
-- everyone. The rule now lives in src/lib/done-for-you-setup.ts
-- (setupIsFreeFor); a qualifying org's purchase writes the same
-- org_platform_addons row a paid one does, with no Stripe charge behind it.
--
-- This column is how that row says so. NULL is a paid purchase (or any other
-- add-on); otherwise the reason it was free. Without it, a free setup and a
-- paid one whose invoice item was lost look the same to anyone reading the
-- table, and the platform console could not tell a waiver from a leak.
--
-- Written only by the service role (subscribePlatformAddon); 20261009140000
-- removed every authenticated write path on this table and that is unchanged.
-- RLS, the read policy and the two-step restrictive policy are untouched; the
-- restrictive policy is reapplied idempotently so this file does not depend on
-- an earlier one having run it.

ALTER TABLE public.org_platform_addons
  ADD COLUMN IF NOT EXISTS waived_reason text;

ALTER TABLE public.org_platform_addons
  DROP CONSTRAINT IF EXISTS org_platform_addons_waived_reason_check;
ALTER TABLE public.org_platform_addons
  ADD CONSTRAINT org_platform_addons_waived_reason_check
  CHECK (waived_reason IS NULL OR waived_reason IN ('yearly', 'scale', 'founding'));

COMMENT ON COLUMN public.org_platform_addons.waived_reason IS
  'Why this add-on was granted with no Stripe charge (Done-for-you setup, NP-4): '
  'yearly | scale | founding. NULL = bought through Stripe.';

ALTER TABLE public.org_platform_addons ENABLE ROW LEVEL SECURITY;
SELECT public.require_mfa_policy('public.org_platform_addons');

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'org_platform_addons'
       AND column_name = 'waived_reason'
  ) THEN
    RAISE EXCEPTION 'org_platform_addons.waived_reason was not added';
  END IF;

  -- Still no way for a signed-in caller to write a row (20261009140000): a
  -- column that grants a free add-on must not be writable from a browser.
  IF has_table_privilege('authenticated', 'public.org_platform_addons', 'INSERT')
     OR has_table_privilege('authenticated', 'public.org_platform_addons', 'UPDATE') THEN
    RAISE EXCEPTION 'authenticated holds INSERT or UPDATE on org_platform_addons';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public' AND tablename = 'org_platform_addons'
       AND permissive = 'PERMISSIVE'
       AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
       AND roles && ARRAY['authenticated', 'anon', 'public']::name[]
  ) THEN
    RAISE EXCEPTION 'org_platform_addons has an authenticated write path';
  END IF;
END
$check$;
