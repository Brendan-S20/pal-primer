-- BUILD-6: the settlement statement shows what was deducted and why.
--
-- Applied live on 2026-07-31 as `settlement_adjustments_column`; filed here so
-- the repo and the database agree (IMP-2 / check-migrations.mjs).
--
-- This is where adjustments_applied_cents actually landed in the live database
-- — a beat after the function that writes it. The preceding migration repeats
-- the ADD COLUMN so a fresh replay in filename order works; this file is that
-- replay's no-op and the ledger's record of where the column really came from.
-- Both are IF NOT EXISTS, so applying them in either order is safe.
--
-- WHY THE COLUMN EXISTS AT ALL. Without it a settlement reads
-- "$900 — location owes franchise" with no way to tell whether that is royalty,
-- a refund clawback, or an error. A franchisee handed a deduction they cannot
-- account for will dispute it, and they will be right to. The statement has to
-- carry its own explanation: revenue, royalty, and adjustments as three
-- separate numbers that visibly add up.
--
-- Idempotent.

ALTER TABLE public.franchise_royalty_invoices
  ADD COLUMN IF NOT EXISTS adjustments_applied_cents bigint NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.franchise_royalty_invoices.adjustments_applied_cents IS
  'BUILD-6: the location''s share of refunds and chargebacks folded into this settlement. Shown on the statement so a deduction is never unexplained.';
