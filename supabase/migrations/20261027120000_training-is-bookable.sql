-- Training is bookable (#548, part of #476).
--
-- Training (#413, #476) is built on main and was Coming soon. Since #531 the
-- flip is one row of the platform switch, public.platform_service_lines, and
-- not a list in code: 20261025200000 seeded training bookable = false,
-- customer_requestable = false, and this turns the first column on. Nothing
-- else changes:
--
--   bookable_service_lines()        answers {dog_walking, pet_sitting,
--                                   pet_waste, training}
--   customer_requestable            stays false, as seeded. Training is sold
--                                   by the office: the public signup, the
--                                   booking link and the receptionist still
--                                   do not offer it. The portal's package
--                                   sale and lesson request key off bookable
--                                   (trainingIsForSale), not off this column.
--   organizations_service_lines_bookable
--                                   an owner may now add training
--
-- Mobile grooming stays Coming soon; it flips in its own PR after its own QA.
-- Pet waste, walking and sitting are not touched.
--
-- The UPDATE goes through tg_platform_service_lines_audit like any other
-- change, so it is in platform_admin_audit with no actor ("nobody did it":
-- a migration). A database where a platform admin already turned training on
-- matches no row and is left as it is, so nothing is logged twice.
--
-- Replays into an empty database: 20261025200000 seeds the row this updates.
-- Idempotent.

UPDATE public.platform_service_lines
   SET bookable = true
 WHERE service_line = 'training'
   AND bookable IS DISTINCT FROM true;

-- ── What this file establishes, checked from any starting state ───────────
DO $post$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_service_lines
     WHERE service_line = 'training' AND bookable AND NOT customer_requestable
  ) THEN
    RAISE EXCEPTION 'training is not bookable, or is customer requestable';
  END IF;
  IF NOT ('training' = ANY (public.bookable_service_lines())) THEN
    RAISE EXCEPTION 'bookable_service_lines() does not answer training';
  END IF;
  IF 'training' = ANY (public.customer_requestable_service_lines()) THEN
    RAISE EXCEPTION 'customer_requestable_service_lines() answers training';
  END IF;
END
$post$;
