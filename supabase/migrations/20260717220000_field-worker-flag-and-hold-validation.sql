-- QA round 3 phase 7 (C3/C4/G4): capability-flag reconciliation + hold-range validation.
--
-- 1. Field-worker capability flag: is_field_tech already exists
--    (20260710170000_staff-routing-flags) but that migration's one-time
--    reconciliation can be clobbered by a reseed, and there was no way to record
--    a deliberate owner override (a working owner who also runs a route). Add an
--    override marker so reconciliation is idempotent AND respects manual
--    overrides, then reconcile non-overridden rows from their current role.
-- 2. tg_client_holds_validate: server-enforced hold-range validation (I11) so a
--    2-year range (or end-before-start) is rejected in the database, not only in
--    the UI. The existing CHECK enforces end >= start; this adds a max span.

ALTER TABLE public.staff
  ADD COLUMN IF NOT EXISTS is_field_tech_overridden boolean NOT NULL DEFAULT false;

-- Idempotent reconciliation: derive is_field_tech from role for any row whose
-- flag was never deliberately overridden. Techs are field workers; owners,
-- office managers, and dispatchers are not unless an owner flags them in.
UPDATE public.staff
   SET is_field_tech = (role = 'tech')
 WHERE NOT is_field_tech_overridden
   AND is_field_tech IS DISTINCT FROM (role = 'tech');

-- ── Hold range validation ───────────────────────────────────────────────────
-- A vacation hold longer than a year is almost certainly a data-entry error
-- (the live sheet saw a 2026 -> 2028 request accepted). Reject it server-side.
CREATE OR REPLACE FUNCTION public.tg_client_holds_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF NEW.ends_on < NEW.starts_on THEN
    RAISE EXCEPTION 'A hold must end on or after it starts';
  END IF;
  IF (NEW.ends_on - NEW.starts_on) > 366 THEN
    RAISE EXCEPTION 'A hold cannot be longer than a year (got % days)', (NEW.ends_on - NEW.starts_on);
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS client_holds_validate ON public.client_holds;
CREATE TRIGGER client_holds_validate
  BEFORE INSERT OR UPDATE ON public.client_holds
  FOR EACH ROW EXECUTE FUNCTION public.tg_client_holds_validate();
