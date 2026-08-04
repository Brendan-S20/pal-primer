-- `is_field_tech` was derived from `role` exactly once, at INSERT.
--
-- The trigger read:
--
--     CREATE TRIGGER staff_field_flag BEFORE INSERT ON public.staff
--
-- INSERT only. So the rule the function states — a tech is a field tech unless
-- somebody deliberately says otherwise — held the moment a row was created and
-- never again.
--
-- ── WHAT THAT COSTS ───────────────────────────────────────────────────────
--
-- Promote an office manager to `tech` and they are still not a field tech.
-- They do not appear on the dispatch board, cannot be assigned a route, and
-- `assert_runs_routes` refuses them by name — while Users & roles shows their
-- role as Technician. Two screens, both correct about their own column,
-- disagreeing about the same person, and nothing anywhere explains why.
--
-- The reverse is worse in a quieter way: demote a tech to dispatcher and they
-- keep `is_field_tech = true`, so someone who no longer does fieldwork stays a
-- drop target on the board and keeps counting in tech reports.
--
-- Found while probing the new bulk-dispatch functions: `redistribute_staff_work`
-- raised "nobody else is available" in an org with three technicians. The
-- function was right and the data was wrong.
--
-- ── THE FIX ───────────────────────────────────────────────────────────────
--
-- Fire on UPDATE of the two columns the answer depends on as well. Scoped to
-- `role` and `is_field_tech_overridden` rather than every UPDATE, so ordinary
-- edits — a phone number, a start address, the seat-count trigger's own
-- writes — do not recompute anything.
--
-- The override still wins, unchanged. Clearing it is now how you say "go back
-- to following the role", and that clearing is itself an UPDATE of a watched
-- column, so it recomputes immediately rather than leaving the stale value in
-- place until the next insert that never comes.

CREATE OR REPLACE FUNCTION public.tg_staff_field_flag()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT COALESCE(NEW.is_field_tech_overridden, false) THEN
    NEW.is_field_tech := (NEW.role = 'tech');
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS staff_field_flag ON public.staff;

CREATE TRIGGER staff_field_flag
BEFORE INSERT OR UPDATE OF role, is_field_tech_overridden ON public.staff
FOR EACH ROW EXECUTE FUNCTION public.tg_staff_field_flag();

COMMENT ON FUNCTION public.tg_staff_field_flag() IS
  'Derives is_field_tech from role unless deliberately overridden. Fires on INSERT and on UPDATE OF role/is_field_tech_overridden — it was INSERT-only, so the rule held the moment a row was created and never again: promoting an office manager to tech left them not a field tech, invisible on the dispatch board, with no way to tell why.';

-- Repair rows the INSERT-only window left inconsistent: people whose role says
-- technician while the derived flag says otherwise, and where nobody made that
-- call deliberately. Clearing the override is the repair — the trigger above
-- then recomputes the flag on the way through, which is also a live check that
-- it now fires on UPDATE at all.
UPDATE public.staff
   SET is_field_tech_overridden = false
 WHERE role = 'tech'
   AND NOT is_field_tech;
