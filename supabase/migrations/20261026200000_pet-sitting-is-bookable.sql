-- Pet sitting is bookable (#547, part of #411).
--
-- Sitting (#478) is built on main and was Coming soon. Since #531 the flip is
-- one row of the platform switch, public.platform_service_lines, and not a
-- list in code: 20261025200000 seeded pet_sitting bookable = false,
-- customer_requestable = true, and this turns the first column on. Nothing
-- else changes:
--
--   bookable_service_lines()        answers {dog_walking, pet_sitting, pet_waste}
--   customer_requestable            stays true, as seeded, so the public
--                                   signup, the portal's Request a stay and
--                                   the receptionist offer a PRICED sitting
--                                   service; an unpriced one stays out by
--                                   their own price filters, unchanged
--   organizations_service_lines_bookable
--                                   an owner may now add pet_sitting
--
-- Mobile grooming and training stay Coming soon; each flips in its own PR
-- after its own QA. Pet waste and walking are not touched.
--
-- The UPDATE goes through tg_platform_service_lines_audit like any other
-- change, so it is in platform_admin_audit with no actor ("nobody did it":
-- a migration). A database where a platform admin already turned sitting on
-- matches no row and is left as it is, so nothing is logged twice.
--
-- Replays into an empty database: 20261025200000 seeds the row this updates.
-- Idempotent.

UPDATE public.platform_service_lines
   SET bookable = true
 WHERE service_line = 'pet_sitting'
   AND bookable IS DISTINCT FROM true;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_service_lines
     WHERE service_line = 'pet_sitting' AND bookable AND customer_requestable
  ) THEN
    RAISE EXCEPTION 'pet_sitting is not bookable and customer requestable';
  END IF;
  IF NOT ('pet_sitting' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'bookable_service_lines() does not answer pet_sitting';
  END IF;
END
$post$;
