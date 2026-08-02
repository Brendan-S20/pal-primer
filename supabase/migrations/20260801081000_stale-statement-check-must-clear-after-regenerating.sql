-- Correction to 20260801080000, filed as its own migration because that is what
-- was applied.
--
-- The stale-statement block shipped in that migration asked "is any adjustment
-- on this statement reversed". That is a one-way door: a reversed adjustment
-- keeps its `applied_settlement_id`, so once one existed the statement could
-- NEVER be issued — not even after being regenerated, which is the very thing
-- the error message tells the owner to do.
--
-- The first probe of the fix caught it:
--
--     F2) stale_issue=BLOCKED  after_regen aug_adj=0  then_issue=STILL BLOCKED
--
-- Replaced with the invariant itself rather than a proxy for it: the adjustment
-- total printed on the statement must equal the adjustments that are actually
-- on it. A reversal makes those disagree, and regenerating makes them agree
-- again, so the block clears exactly when it should:
--
--     F2) stale_issue=BLOCKED  after_regen adj=0  then_issue=OK/issued
--
-- The sum mirrors the `adj` CTE in generate_franchise_settlements — same
-- collector split, same sign. If it did not, every statement would read as
-- stale and none could be issued at all.
--
-- 20260801080000 carries the corrected body, so a rebuild from the repo lands
-- in the right place in one step. This file exists so the repo and the applied
-- ledger say the same thing, which is the drift BUG-75 was about.

CREATE OR REPLACE FUNCTION public.tg_franchise_invoice_block_stale_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _live bigint;
BEGIN
  IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
    SELECT coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = NEW.parent_organization_id), 0)
         - coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM NEW.parent_organization_id), 0)
      INTO _live
      FROM public.franchise_adjustments fa
     WHERE fa.applied_settlement_id = NEW.id
       AND fa.status = 'applied';

    IF coalesce(_live, 0) IS DISTINCT FROM NEW.adjustments_applied_cents THEN
      RAISE EXCEPTION 'This statement says % in adjustments and the adjustments on it now total %. Regenerate it before issuing, so it shows what is actually owed.',
        NEW.adjustments_applied_cents, coalesce(_live, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
