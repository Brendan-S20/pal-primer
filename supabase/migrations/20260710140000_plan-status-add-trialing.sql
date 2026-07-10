-- Finding #6: the real pricing model has a 14-day trial, not a permanent free
-- tier. Add a first-class trial state to the org status enums. Applied to live
-- via Supabase MCP apply_migration on 2026-07-10. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'org_plan_status' AND e.enumlabel = 'trialing'
  ) THEN
    ALTER TYPE public.org_plan_status ADD VALUE 'trialing';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'org_billing_status' AND e.enumlabel = 'trialing'
  ) THEN
    ALTER TYPE public.org_billing_status ADD VALUE 'trialing';
  END IF;
END $$;
