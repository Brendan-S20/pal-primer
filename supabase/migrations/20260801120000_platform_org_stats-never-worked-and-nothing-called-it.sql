-- platform_org_stats has never worked, and nothing calls it.
--
-- It selects a column that does not exist and compares against an enum member
-- that does not exist:
--
--     SUM(i.total_cents - COALESCE(i.amount_paid_cents, 0)) ...
--      WHERE i.status IN ('open','overdue')
--
-- `invoices` has no `amount_paid_cents`. `invoice_status` is
-- draft/open/paid/void/uncollectible — there is no 'overdue'. Proven by
-- calling it as a real platform admin so the authorization gate passed:
--
--     sqlstate=42703  message=column i.amount_paid_cents does not exist
--
-- So it has thrown on every call it has ever received. It is granted EXECUTE
-- to `authenticated`, which makes it a live endpoint that returns a 500 — but
-- its only TypeScript wrapper, getPlatformStats in src/lib/platform.functions
-- .ts, has no caller anywhere in src/. Nothing is broken today because nothing
-- reaches it.
--
-- ── WHY DROP RATHER THAN FIX ──────────────────────────────────────────────
--
-- Fixing it means choosing what per-tenant revenue and AR mean, and it already
-- disagrees with the answer this codebase settled on twice over:
--
--   * `revenue_mtd_cents` sums PAID INVOICES dated by `issued_at`. That is
--     precisely the shape BUG-21 and IMP-10 removed — an invoice issued in
--     March and paid in May counted in March. src/lib/revenue.ts is the one
--     definition now: money that ARRIVED, statuses 'succeeded' and 'refunded',
--     reversals deducted in their own period.
--   * its month boundary comes from `date_trunc('month', now())` in the
--     SESSION timezone, which is the defect the two migrations before this one
--     just removed from the due-date trigger and the billing run.
--
-- Repairing a routine nothing calls would mean inventing a third definition of
-- revenue for a screen that does not exist, and this repo has a documented
-- history of exactly that — three copies of the royalty calculation, three
-- copies of the org-local-day formatter. A platform stats screen, if one is
-- ever wanted, should be built against revenue.ts on the day it is designed.
--
-- The dead-machinery detector (IMP-11) did not catch this because its rules
-- look for functions that are granted and uncalled from SQL; this one is
-- called from TypeScript that is itself uncalled, one level further out than
-- the detector reaches. Recorded as a known gap rather than papered over.

DROP FUNCTION IF EXISTS public.platform_org_stats();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'platform_org_stats') THEN
    RAISE EXCEPTION 'platform_org_stats survived the drop';
  END IF;

  -- The platform admin surfaces that DO work must be untouched. If one of
  -- these disappears, the platform console loses a screen and this migration
  -- would be the last thing to have touched that area.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('franchise_signals', 'is_platform_admin')) <> 2 THEN
    RAISE EXCEPTION 'a working platform routine went missing';
  END IF;
END $$;
